/**
 * Delegated execution module — in-chat confirmation cards for agent-signed txs.
 */

import {
  activeProvider, connectedAddress,
  delegationState, executionMode,
  authSignature, authTimestamp,
  currentChainId, vaultInput, chatEl,
  CHAIN_NAMES, escapeHtml, apiHeaders,
} from "./state.js";

import { appendMessage } from "./chat-ui.js";

import { fetchAgentBalance } from "./api.js";

import { showTxReceiptCard, showManualTxCard, pollPendingTx, formatTxMetrics } from "./tx-receipt.js";

function showDelegatedConfirmation(tx, note) {
  const meta = tx.swapMeta;

  let tradeHtml;
  if (meta) {
    tradeHtml = `
      <div class="trade-pair">
        <span class="trade-amount sell">${escapeHtml(meta.sellAmount)} ${escapeHtml(meta.sellToken)}</span>
        <span class="trade-arrow">→</span>
        <span class="trade-amount buy">~${escapeHtml(meta.buyAmount)} ${escapeHtml(meta.buyToken)}</span>
      </div>
      <div class="trade-meta">${meta.price ? escapeHtml(meta.price) + ' · ' : ''}${escapeHtml(meta.dex || 'Agent')} · ${CHAIN_NAMES[tx.chainId] || tx.chainId}</div>
    `;
  } else {
    tradeHtml = `<div class="trade-meta">${escapeHtml(tx.description || 'Execute transaction')} · ${CHAIN_NAMES[tx.chainId] || tx.chainId}</div>`;
  }

  // Determine default sponsorship state for this transaction:
  // per-chain setting > global setting > true
  const defaultSponsored = delegationState?.chainSponsoredGas !== undefined
    ? delegationState.chainSponsoredGas
    : (delegationState?.sponsoredGas !== false);

  const metricsHtml = formatTxMetrics(tx);
  const noteHtml = note ? `<div class="tx-fallback-note">${escapeHtml(note)}</div>` : '';

  const div = document.createElement('div');
  div.className = 'msg assistant compact';
  div.innerHTML = `
    <div class="delegated-confirm">
      ${tradeHtml}
      ${metricsHtml}
      ${noteHtml}
      <div class="sponsor-tx-toggle" style="margin:8px 0;font-size:13px;color:var(--muted);">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" class="sponsor-tx-checkbox" ${defaultSponsored ? 'checked' : ''} />
          <span>Sponsored gas (${CHAIN_NAMES[tx.chainId] || tx.chainId})</span>
        </label>
      </div>
      <div class="confirm-actions">
        <button class="btn-agent-exec approve" onclick="confirmDelegatedExecution(this)">Execute</button>
        <button class="btn-agent-exec reject" onclick="rejectDelegatedExecution(this)">Cancel</button>
      </div>
      <div class="exec-status"></div>
    </div>
  `;

  div._pendingTx = tx;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

/** Confirm delegated execution — call direct execute endpoint (no LLM re-processing) */
async function confirmDelegatedExecution(btn) {
  const container = btn.closest('.delegated-confirm');
  const msgEl = btn.closest('.msg');
  const tx = msgEl._pendingTx;
  if (!tx) return;

  const statusEl = container.querySelector('.exec-status');
  const buttons = container.querySelectorAll('.btn-agent-exec');

  // Read per-transaction sponsorship toggle
  const sponsorCheckbox = container.querySelector('.sponsor-tx-checkbox');
  const txSponsored = sponsorCheckbox ? sponsorCheckbox.checked : true;

  // Pre-check: if sponsored gas is OFF, verify agent has ETH before calling execute
  if (!txSponsored) {
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = 'Checking agent balance…';
    try {
      const vault = vaultInput.value.trim();
      const balRes = await fetch(`/api/delegation/balance?vaultAddress=${vault}&chainId=${tx.chainId}`);
      if (balRes.ok) {
        const balData = await balRes.json();
        if (!balData.sufficient) {
          statusEl.style.color = 'var(--error)';
          statusEl.innerHTML = `Agent wallet has no ETH for gas on ${CHAIN_NAMES[tx.chainId] || tx.chainId}. ` +
            `<a href="#" onclick="event.preventDefault();document.getElementById('settings-btn').click();" style="color:var(--accent);">Enable sponsored gas</a> or fund ${balData.agentAddress?.slice(0,6)}…${balData.agentAddress?.slice(-4)}.`;
          buttons.forEach(b => b.disabled = false);
          btn.textContent = 'Execute';
          return;
        }
      }
    } catch { /* proceed anyway — backend will catch it */ }
  }

  buttons.forEach(b => b.disabled = true);
  btn.textContent = 'Executing…';
  statusEl.style.color = 'var(--accent)';
  statusEl.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;"><span class="spinner"></span> Broadcasting…</span>';

  try {
    const vault = vaultInput.value.trim();

    // Direct execution endpoint — skips LLM, sends the pre-built tx immediately
    const res = await fetch('/api/delegation/execute', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        operatorAddress: connectedAddress,
        vaultAddress: vault,
        chainId: tx.chainId,
        authSignature,
        authTimestamp,
        sponsoredGas: txSponsored,
        transaction: {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          chainId: tx.chainId,
          gas: tx.gas,
          description: tx.description,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // If delegation not active on this chain, fall back to manual wallet signing
      if (err.code === 'DELEGATION_NOT_ON_CHAIN' || err.code === 'METHOD_NOT_ALLOWED' || err.code === 'AGENT_NOT_DELEGATED' || err.fallbackToManual) {
        container.innerHTML = '';
        const manualMsg = document.createElement('div');
        manualMsg.style.cssText = 'color:var(--muted);font-size:13px;margin-bottom:12px;white-space:pre-wrap;';
        if (err.code === 'SPONSORED_FAILED') {
          manualMsg.textContent = err.error || 'Gas sponsorship failed. You can fund the agent wallet, disable sponsored gas, or sign manually.';
        } else if (err.code === 'AGENT_NOT_DELEGATED') {
          manualMsg.textContent = 'This function is not in your current on-chain delegation:';
        } else if (err.code === 'METHOD_NOT_ALLOWED') {
          manualMsg.textContent = 'This selector is not in the allowed function list — sign manually:';
        } else if (err.code === 'DELEGATION_NOT_ON_CHAIN') {
          manualMsg.textContent = 'Delegation not active on this chain — sign manually:';
        } else {
          manualMsg.textContent = err.error || 'Execution failed — sign manually:';
        }
        container.appendChild(manualMsg);
        // Re-render as manual tx card inline
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'confirm-actions';
        let extraBtn = '';
        if (err.code === 'AGENT_NOT_DELEGATED') {
          extraBtn = `<button class="btn-agent-exec approve" style="background:var(--accent);" onclick="openDelegationSetup(${tx.chainId});this.closest('.msg').remove()">Update Delegation</button>`;
        } else if (err.code === 'SPONSORED_FAILED') {
          extraBtn = `<button class="btn-agent-exec approve" style="background:var(--accent);" onclick="openSettings();document.getElementById('sponsor-toggle').checked=false;toggleSponsoredGas(false);">Disable Sponsored Gas</button>`;
        }
        actionsDiv.innerHTML = extraBtn +
          `<button class="btn-agent-exec approve" onclick="signManualTxCard(this)">Sign with Wallet</button>
          <button class="btn-agent-exec reject" onclick="this.closest('.msg').remove()">Dismiss</button>`;
        container.appendChild(actionsDiv);
        const newStatusEl = document.createElement('div');
        newStatusEl.className = 'exec-status';
        container.appendChild(newStatusEl);
        return;
      }
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data.executionResult) {
      const r = data.executionResult;
      buttons.forEach(b => b.style.display = 'none');

      // Keep the confirmation card and turn it into a compact receipt.
      const hash = r.txHash || '';
      const shortHash = hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '';
      const safeUrl = r.explorerUrl && /^https:\/\//i.test(r.explorerUrl) ? r.explorerUrl : null;
      const explorerLink = safeUrl && shortHash
        ? `<a href="${safeUrl}" target="_blank" rel="noopener">${shortHash} ↗</a>`
        : shortHash;
      const statusText = r.confirmed
        ? '✅ Confirmed'
        : r.reverted
          ? '❌ Reverted'
          : '⏳ Submitted';
      const tradeText = tx.swapMeta
        ? `${escapeHtml(tx.swapMeta.sellAmount)} ${escapeHtml(tx.swapMeta.sellToken)} → ${escapeHtml(tx.swapMeta.buyAmount)} ${escapeHtml(tx.swapMeta.buyToken)}`
        : escapeHtml(tx.description || 'Transaction');
      statusEl.innerHTML = `<div class="receipt-status-line"><span class="receipt-status-text">${statusText}</span><span class="receipt-trade-text">${tradeText}</span>${explorerLink ? `<span class="receipt-explorer">${explorerLink}</span>` : ''}</div>`;

      // If not yet final, poll for confirmation and update this same status line.
      if (!r.confirmed && !r.reverted) {
        pollPendingTx(r, tx.swapMeta, statusEl);
      } else if (r.confirmed) {
        // Auto-progress to next strategy step.
        // NOTE: for non-swap txs (bridges, delegation, etc.), pass null rather than
        // tx.description — bridge descriptions contain receive amounts that the LLM
        // would incorrectly use as swap inputs instead of calling get_token_balance.
        const desc = tx.swapMeta
          ? `${tx.swapMeta.sellAmount} ${tx.swapMeta.sellToken} → ${tx.swapMeta.buyAmount} ${tx.swapMeta.buyToken}`
          : null;
        setTimeout(() => window.autoProgressAfterTx(desc), 2000);
      }

      // Refresh agent balance
      fetchAgentBalance(vault);
    } else {
      throw new Error('No execution result returned');
    }
  } catch (err) {
    statusEl.style.color = 'var(--error)';
    statusEl.textContent = `Error: ${err.message}`;
    buttons.forEach(b => b.disabled = false);
    btn.textContent = 'Retry';
  }
}

function rejectDelegatedExecution(btn) {
  const container = btn.closest('.delegated-confirm');
  container.innerHTML = '<div style="color:var(--muted);font-size:24px;">Execution cancelled.</div>';
  appendMessage('system', 'Execution cancelled.');
}

/* ================================================================
   Multi-Transaction Delegated Confirmation
   ================================================================ */

/** Show a combined card for multiple transactions in delegated mode */
function showMultiDelegatedConfirmation(txList, note) {
  let tradesHtml = '';
  for (let i = 0; i < txList.length; i++) {
    const tx = txList[i];
    const meta = tx.swapMeta;
    const chain = CHAIN_NAMES[tx.chainId] || tx.chainId;
    const metricsHtml = formatTxMetrics(tx);
    if (meta) {
      tradesHtml += `
        <div class="multi-trade-row" data-tx-idx="${i}">
          <span class="trade-amount sell">${escapeHtml(meta.sellAmount)} ${escapeHtml(meta.sellToken)}</span>
          <span class="trade-arrow">→</span>
          <span class="trade-amount buy">~${escapeHtml(meta.buyAmount)} ${escapeHtml(meta.buyToken)}</span>
          <span class="trade-chain">${escapeHtml(chain)}</span>
          <span class="multi-tx-status"></span>
        </div>${metricsHtml}`;
    } else {
      tradesHtml += `
        <div class="multi-trade-row" data-tx-idx="${i}">
          <span class="trade-meta">${escapeHtml(tx.description || 'Transaction ' + (i + 1))} · ${escapeHtml(chain)}</span>
          <span class="multi-tx-status"></span>
        </div>${metricsHtml}`;
    }
  }

  const noteHtml = note ? `<div class="tx-fallback-note">${escapeHtml(note)}</div>` : '';

  const div = document.createElement('div');
  div.className = 'msg assistant compact';
  div.innerHTML = `
    <div class="delegated-confirm multi-tx">
      <div class="multi-tx-header">${txList.length} transactions to execute</div>
      ${tradesHtml}
      ${noteHtml}
      <div class="confirm-actions">
        <button class="btn-agent-exec approve" onclick="confirmMultiDelegatedExecution(this)">Execute All</button>
        <button class="btn-agent-exec reject" onclick="rejectDelegatedExecution(this)">Cancel</button>
      </div>
      <div class="exec-status"></div>
    </div>
  `;

  div._pendingTxList = txList;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

/** Execute multiple transactions sequentially */
async function confirmMultiDelegatedExecution(btn) {
  const container = btn.closest('.delegated-confirm');
  const msgEl = btn.closest('.msg');
  const txList = msgEl._pendingTxList;
  if (!txList || txList.length === 0) return;

  const statusEl = container.querySelector('.exec-status');
  const buttons = container.querySelectorAll('.btn-agent-exec');
  buttons.forEach(b => b.disabled = true);
  btn.textContent = 'Executing…';

  const vault = vaultInput.value.trim();
  let allSuccess = true;

  for (let i = 0; i < txList.length; i++) {
    const tx = txList[i];
    const rowStatusEl = container.querySelector(`.multi-trade-row[data-tx-idx="${i}"] .multi-tx-status`);
    if (rowStatusEl) {
      rowStatusEl.innerHTML = '<span class="spinner" style="width:12px;height:12px;"></span>';
    }
    statusEl.style.color = 'var(--accent)';
    statusEl.textContent = `Executing ${i + 1} of ${txList.length}…`;

    try {
      const res = await fetch('/api/delegation/execute', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          operatorAddress: connectedAddress,
          vaultAddress: vault,
          chainId: tx.chainId || currentChainId,
          authSignature,
          authTimestamp,
          transaction: {
            to: tx.to,
            data: tx.data,
            value: tx.value,
            chainId: tx.chainId,
            gas: tx.gas,
            description: tx.description,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // If delegation not active on this chain, show manual sign for remaining txs
        if (err.code === 'DELEGATION_NOT_ON_CHAIN' || err.code === 'METHOD_NOT_ALLOWED' || err.fallbackToManual) {
          if (rowStatusEl) rowStatusEl.textContent = '⚠️';
          const reason = err.code === 'METHOD_NOT_ALLOWED'
            ? 'Selector not delegated'
            : `Sign remaining transactions with your wallet`;
          appendMessage('system', reason);
          for (let j = i; j < txList.length; j++) {
            showManualTxCard(txList[j]);
          }
          buttons.forEach(b => b.style.display = 'none');
          statusEl.style.color = 'var(--warning, orange)';
          statusEl.textContent = `${i} of ${txList.length} executed via agent — remaining require wallet signing`;
          fetchAgentBalance(vault);
          return;
        }
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();

      if (data.executionResult) {
        const r = data.executionResult;
        if (rowStatusEl) {
          rowStatusEl.textContent = r.confirmed ? '✅' : r.reverted ? '❌' : '⏳';
        }
        showTxReceiptCard(r, tx.swapMeta);
        if (!r.confirmed || r.reverted) allSuccess = false;
      } else {
        throw new Error('No execution result');
      }
    } catch (err) {
      if (rowStatusEl) rowStatusEl.textContent = '❌';
      appendMessage('system', `Transaction ${i + 1} failed: ${err.message}`);
      allSuccess = false;
    }
  }

  buttons.forEach(b => b.style.display = 'none');
  statusEl.style.color = allSuccess ? 'var(--success)' : 'var(--error)';
  statusEl.textContent = allSuccess
    ? `All ${txList.length} transactions executed successfully`
    : 'Some transactions failed — see details above';

  fetchAgentBalance(vault);
}

/* ================================================================
   Rich Tx Receipt Card & Pending Tx Polling
   ================================================================ */

/**
 * Show a compact transaction receipt card in the chat.
 * Highlights the trade (token amounts + execution price) with gas/explorer in a footer line.
 */

export {
  showDelegatedConfirmation, confirmDelegatedExecution,
  rejectDelegatedExecution,
  showMultiDelegatedConfirmation, confirmMultiDelegatedExecution,
};
