/**
 * Transaction modal — show modal, confirm, poll receipt.
 */

import {
  pendingTx, setPendingTx,
  activeProvider, connectedAddress, currentChainId,
  CHAIN_NAMES, escapeHtml, getExplorerUrl,
} from "./state.js";

import { appendMessage } from "./chat-ui.js";

import { closeModal } from "./wallet.js";

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

  document.getElementById('tx-details').innerHTML = `
    <div class="row"><span class="label">${toLabel}</span><span class="value">${escapeHtml(tx.to)}</span></div>
    <div class="row"><span class="label">Chain</span><span class="value">${CHAIN_NAMES[tx.chainId] || tx.chainId}</span></div>
    <div class="row"><span class="label">Value</span><span class="value">${valueDisplay}</span></div>
    <div class="row"><span class="label">Gas limit</span><span class="value">${gasDisplay}</span></div>
    <div class="row"><span class="label">Data</span><span class="value">${tx.data.slice(0, 10)}… (${dataLength} bytes)</span></div>
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
    const currentChainId = await activeProvider.request({ method: 'eth_chainId' });
    const targetChainHex = '0x' + pendingTx.chainId.toString(16);
    if (currentChainId !== targetChainHex) {
      statusEl.textContent = 'Switching chain…';
      await activeProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetChainHex }],
      });
    }

    statusEl.textContent = 'Confirm in your wallet…';

    const txHash = await activeProvider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: connectedAddress,
        to: pendingTx.to,
        data: pendingTx.data,
        gas: pendingTx.gas,
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

        if (success) {
          statusEl.style.color = 'var(--success)';
          // Show human-readable summary in modal
          if (meta) {
            statusEl.textContent = `✓ Swapped ${meta.sellAmount} ${meta.sellToken} for ${meta.buyAmount} ${meta.buyToken}`;
          } else {
            statusEl.textContent = '✓ Transaction confirmed';
          }
          // Chat message: human-readable, no block number
          const chatMsg = meta
            ? `✅ Swapped ${meta.sellAmount} ${meta.sellToken} for ${meta.buyAmount} ${meta.buyToken}${meta.price ? ' (' + meta.price + ')' : ''}`
            : `✅ Transaction confirmed`;
          appendMessage('system', chatMsg);
          // Refresh delegation status (handles chat-based delegation setup)
          window.refreshDelegationStatus();
          // Auto-progress to next strategy step if agent is leading a multi-step flow
          // Note: we do NOT repeat the buy/sell amounts here (those came from the swap
          // result — already in conversation history). Including them as a new user
          // message causes the LLM to echo them as "new balance", which is wrong.
          setTimeout(() => window.autoProgressAfterTx(null), 4500);
        } else {
          statusEl.style.color = 'var(--error)';
          statusEl.textContent = '✗ Transaction reverted';
          appendMessage('system', `❌ Transaction reverted — ${txHash}`);
        }
        // Keep modal open for 4 seconds so user sees the result
        setTimeout(() => {
          closeModal('tx-modal');
          // Restore button visibility for next tx
          const cancelBtn = document.querySelector('#tx-modal .btn-cancel');
          const confirmBtn = document.getElementById('tx-confirm-btn');
          if (cancelBtn) cancelBtn.style.display = '';
          if (confirmBtn) { confirmBtn.style.display = ''; confirmBtn.textContent = 'Confirm'; confirmBtn.disabled = false; }
        }, 4000);
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

/** Show an in-chat card for a manual-mode transaction (user signs with wallet) */

export { showTransactionModal, confirmTransaction };
