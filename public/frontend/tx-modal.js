/**
 * Transaction modal — show modal, confirm, poll receipt.
 */

import {
  pendingTx, setPendingTx,
  activeProvider, connectedAddress, currentChainId, vaultInput,
  CHAIN_NAMES, escapeHtml, getExplorerUrl,
} from "./state.js";

import { appendMessage } from "./chat-ui.js";

import { formatTxMetrics } from "./tx-receipt.js";

import { closeModal, ensureWalletChain } from "./wallet.js";

import { callTool } from "./api.js";

function showTransactionModal(tx) {
  if (!tx || !tx.to || !tx.data) {
    console.error('[tx-modal] Invalid transaction object:', tx);
    appendMessage('system', 'Error: Transaction data is missing. Please retry the swap.');
    return;
  }
  setPendingTx(tx);
  document.getElementById('tx-description').textContent = tx.description || 'Vault transaction';
  const gasDisplay = tx.gas ? parseInt(tx.gas, 16).toLocaleString() : 'auto';
  const dataLength = tx.data ? (tx.data.length - 2) / 2 : 0;
  const valueHex = tx.value || '0x0';
  const valueBigInt = valueHex === '0x0' ? 0n : BigInt(valueHex);
  // tx.operatorOnly is set by the API for EOA-signed transactions; also treat
  // non-zero msg.value as a reliable indicator (delegated vault adapter calls
  // never require msg.value; direct vault owner calls like fundPool may, but
  // those are EOA transactions anyway).
  const isOperatorOnly = tx.operatorOnly || valueBigInt > 0n;
  const valueDisplay = valueBigInt > 0n
    ? (() => {
        const divisor = 10n ** 18n;
        const whole = valueBigInt / divisor;
        const frac = valueBigInt % divisor;
        const fracStr = frac > 0n ? '.' + frac.toString().padStart(18, '0').replace(/0+$/, '') : '';
        return `${whole}${fracStr} (msg.value)`;
      })()
    : isOperatorOnly ? '0' : '0 (vault uses own balance)';
  const toLabel = isOperatorOnly ? 'To' : 'To (vault)';

  const metricsHtml = formatTxMetrics(tx);
  document.getElementById('tx-details').innerHTML = `
    <div class="row"><span class="label">${toLabel}</span><span class="value">${escapeHtml(tx.to)}</span></div>
    <div class="row"><span class="label">Chain</span><span class="value">${CHAIN_NAMES[tx.chainId] || tx.chainId}</span></div>
    <div class="row"><span class="label">Value</span><span class="value">${valueDisplay}</span></div>
    <div class="row"><span class="label">Gas limit</span><span class="value">${gasDisplay}</span></div>
    <div class="row"><span class="label">Data</span><span class="value">${tx.data.slice(0, 10)}… (${dataLength} bytes)</span></div>
    ${metricsHtml ? `<div class="row" style="margin-top:8px;">${metricsHtml}</div>` : ''}
  `;
  document.getElementById('tx-status').textContent = '';
  const confirmBtn = document.getElementById('tx-confirm-btn');
  confirmBtn.disabled = false;
  // Set button label based on transaction type
  const desc = (tx.description || '').toLowerCase();
  confirmBtn.textContent = desc.includes('deploy') ? 'Deploy Pool'
    : desc.includes('liquidity') ? 'Add Liquidity'
    : desc.includes('bridge') || desc.includes('transfer') ? 'Transfer'
    : desc.includes('stake') || desc.includes('unstake') ? 'Confirm'
    : desc.includes('delegation') || desc.includes('delegate') ? 'Delegate'
    : desc.includes('gmx') || desc.includes('close') || desc.includes('decrease') ? 'Confirm'
    : 'Confirm';
  confirmBtn.style.display = '';
  // Restore the cancel button — it is hidden while a tx is pending and must be
  // back whenever the modal is reused (e.g. a deterministic step 2 reopens it).
  const cancelBtn = document.querySelector('#tx-modal .btn-cancel');
  if (cancelBtn) cancelBtn.style.display = '';
  document.getElementById('tx-modal').classList.add('visible');
}

async function confirmTransaction() {
  if (!pendingTx || !activeProvider) return;
  const statusEl = document.getElementById('tx-status');
  const confirmBtn = document.getElementById('tx-confirm-btn');
  const cancelBtn = document.querySelector('#tx-modal .btn-cancel');

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Confirming…';
  statusEl.style.color = 'var(--accent)';
  statusEl.textContent = 'Waiting for wallet…';

  try {
    // Ensure correct chain
    statusEl.textContent = 'Switching chain…';
    await ensureWalletChain(activeProvider, pendingTx.chainId);

    statusEl.textContent = 'Confirm in your wallet…';

    // Never forward a zero/unset gas to the wallet: Lighter's sequencer
    // rejects gas 0 ("pubdata budget below intrinsic") and some wallets
    // pass it through instead of re-estimating. Omitting the field makes the
    // wallet estimate itself.
    const gasParam = pendingTx.gas && pendingTx.gas !== '0x0' ? pendingTx.gas : undefined;
    const txHash = await activeProvider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: connectedAddress,
        to: pendingTx.to,
        data: pendingTx.data,
        ...(gasParam ? { gas: gasParam } : {}),
        value: pendingTx.value || '0x0',
      }],
    });

    // Show pending state in the modal — hide buttons, show spinner
    confirmBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    statusEl.style.color = 'var(--accent)';
    statusEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span class="spinner"></span> Pending… waiting for on-chain confirmation</span>`;
    document.getElementById('tx-description').textContent = `Tx: ${txHash.slice(0, 10)}…${txHash.slice(-6)}`;

    // Poll for receipt
    const confirmedTx = pendingTx;
    setPendingTx(null);
    pollTransactionReceipt(txHash, confirmedTx, statusEl);

  } catch (err) {
    statusEl.style.color = 'var(--error)';
    statusEl.textContent = `Error: ${err.message || 'User rejected'}`;
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm';
    confirmBtn.style.display = '';
  }
}

/**
 * Poll eth_getTransactionReceipt until the tx is mined.
 * Uses the wallet provider (same RPC the user is connected to).
 * L2s with fast/flash blocks typically confirm in 1-3 seconds.
 */
async function pollTransactionReceipt(txHash, tx, statusEl) {
  const maxAttempts = 60; // ~2 minutes at 2s intervals
  const interval = 2000;
  const meta = tx.swapMeta;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const receipt = await activeProvider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) {
        const success = receipt.status === '0x1';
        const explorerUrl = getExplorerUrl(tx.chainId, txHash);
        const shortHash = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;

        if (success) {
          statusEl.style.color = 'var(--success)';
          // Show human-readable summary in modal
          if (meta) {
            statusEl.textContent = `✓ Swapped ${meta.sellAmount} ${meta.sellToken} for ${meta.buyAmount} ${meta.buyToken}`;
          } else {
            statusEl.innerHTML = `✓ Transaction confirmed — <a href="${explorerUrl}" target="_blank" rel="noopener">${shortHash} ↗</a>`;
          }
          // Chat message: human-readable with a clickable explorer link
          // (assistant role renders rich content; system messages are plain text)
          const chatMsg = meta
            ? `✅ Swapped ${meta.sellAmount} ${meta.sellToken} for ${meta.buyAmount} ${meta.buyToken}${meta.price ? ' (' + meta.price + ')' : ''} — [${shortHash}](${explorerUrl})`
            : `✅ ${tx.description || 'Transaction'} confirmed — [${shortHash}](${explorerUrl})`;
          appendMessage('assistant', chatMsg);
          // Pool deployments: extract the new pool address from the receipt and
          // switch the app to it (same auto-fill the dedicated deploy form did).
          if (/deploy new rigoblock pool/i.test(tx.description || '')) {
            const newPool = extractPoolAddressFromReceipt(receipt);
            if (newPool) {
              vaultInput.value = newPool;
              appendMessage('system', `🏊 New pool deployed at ${newPool} — address auto-filled above.`);
              if (window.validateVault) window.validateVault();
              if (window.updateOnboardingVisibility) window.updateOnboardingVisibility();
            }
          }
          // Refresh delegation status (handles chat-based delegation setup)
          window.refreshDelegationStatus();
          // Progression after a confirmed tx:
          //  - tx.nextStep: deterministic multi-step (e.g. fund_pool approve →
          //    mint) — re-invoke the tool directly, no LLM roundtrip.
          //  - otherwise: auto-progress to next strategy step if agent is
          //    leading a multi-step flow.
          if (tx.nextStep) {
            setTimeout(() => runToolNextStep(tx), 1200);
          } else {
            setTimeout(() => window.autoProgressAfterTx(null), 4500);
          }
        } else {
          statusEl.style.color = 'var(--error)';
          statusEl.innerHTML = `✗ Transaction reverted — <a href="${explorerUrl}" target="_blank" rel="noopener">${shortHash} ↗</a>`;
          appendMessage('assistant', `❌ Transaction reverted — [${shortHash}](${explorerUrl})`);
        }
        // Keep modal open for 4 seconds so user sees the result — unless a
        // deterministic next step is about to reopen the modal with step 2.
        if (!tx.nextStep) {
          setTimeout(() => {
            closeModal('tx-modal');
            // Restore button visibility for next tx
            const cancelBtn = document.querySelector('#tx-modal .btn-cancel');
            const confirmBtn = document.getElementById('tx-confirm-btn');
            if (cancelBtn) cancelBtn.style.display = '';
            if (confirmBtn) { confirmBtn.style.display = ''; confirmBtn.textContent = 'Confirm'; confirmBtn.disabled = false; }
          }, 4000);
        }
        return;
      }
    } catch (e) {
      console.warn('[poll] Receipt fetch error:', e.message);
    }
  }

  // Timeout — still pending
  statusEl.style.color = 'var(--warn)';
  statusEl.textContent = `Tx still pending after ${maxAttempts * interval / 1000}s. Check explorer.`;
  setTimeout(() => {
    closeModal('tx-modal');
    const cancelBtn = document.querySelector('#tx-modal .btn-cancel');
    const confirmBtn = document.getElementById('tx-confirm-btn');
    if (cancelBtn) cancelBtn.style.display = '';
    if (confirmBtn) { confirmBtn.style.display = ''; confirmBtn.textContent = 'Confirm'; confirmBtn.disabled = false; }
  }, 5000);
}

/**
 * Deterministic follow-up for multi-step operator transactions (tx.nextStep):
 * re-invoke the tool directly after step 1 confirmed — no LLM roundtrip, so a
 * replayed stale draft can never re-open an already-completed approval.
 */
async function runToolNextStep(confirmedTx) {
  const step = confirmedTx.nextStep;
  if (!step) return;
  // Step 1's outcome is already posted to the chat (with the explorer link) —
  // close the modal before preparing step 2.
  closeModal('tx-modal');
  appendMessage('system', '⏭️ Step 1 confirmed — preparing the next step…');
  try {
    const { ok, data } = await callTool(step.toolName, {
      arguments: step.arguments,
      chainId: confirmedTx.chainId,
      vaultAddress: vaultInput.value.trim(),
      operatorAddress: connectedAddress,
    });
    if (!ok || !data || data.error) {
      appendMessage(
        'assistant',
        `❌ Could not prepare the next step: ${(data && (data.error || data.message)) || `HTTP error`}`,
        { toolError: true },
      );
      return;
    }
    if (data.message) appendMessage('assistant', data.message);
    if (data.transaction) {
      showTransactionModal({
        ...data.transaction,
        description: `Step 2/2 — ${data.transaction.description || 'next step'}`,
      });
    }
  } catch (err) {
    appendMessage('system', `Next step failed: ${err.message}`);
  }
}

/** PoolCreated(address indexed newPoolAddress) topic0 — emitted by the factory AFTER the
 *  proxy's own init events, so blindly taking the first address-shaped topic returns the
 *  SmartPool implementation (BeaconUpgraded topic1). Match the event exactly. */
const POOL_CREATED_TOPIC0 = '0x83a48fbcfc991335314e74d0496aab6a1987e992ddc85dddbcc4d6dd6ef2e9fc';

function extractPoolAddressFromReceipt(receipt) {
  if (!receipt.logs) return null;
  for (const log of receipt.logs) {
    if (log.topics && log.topics[0] === POOL_CREATED_TOPIC0 && log.topics.length >= 2) {
      const addr = '0x' + log.topics[1].slice(26);
      if (addr.length === 42 && addr !== '0x0000000000000000000000000000000000000000') {
        return addr;
      }
    }
  }
  return null;
}

/** Show an in-chat card for a manual-mode transaction (user signs with wallet) */

export { showTransactionModal, confirmTransaction, runToolNextStep };
