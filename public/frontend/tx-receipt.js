/**
 * Transaction receipt module — in-chat cards, manual tx signing, polling.
 */

import {
  activeProvider, connectedAddress, chatEl, vaultInput,
  CHAIN_NAMES, escapeHtml, getExplorerUrl,
} from "./state.js";

import { appendMessage } from "./chat-ui.js";

import { fetchAgentBalance } from "./api.js";

/** Format per-transaction metrics (NAV impact, swap-shield divergence) as HTML. */
function formatTxMetrics(tx) {
  if (!tx?.metrics) return '';
  const m = tx.metrics;
  const parts = [];
  if (m.navShield?.navImpactPct != null) {
    const pct = String(m.navShield.navImpactPct);
    const cls = pct.startsWith('-') ? 'negative' : 'positive';
    parts.push(`<span class="metric-item"><span class="metric-label">NAV impact</span><span class="metric-value ${cls}">${escapeHtml(pct)}</span></span>`);
  }
  if (m.swapShield?.divergencePct != null) {
    const pct = String(m.swapShield.divergencePct);
    const cls = pct.startsWith('-') ? 'negative' : 'positive';
    parts.push(`<span class="metric-item"><span class="metric-label">Oracle divergence</span><span class="metric-value ${cls}">${escapeHtml(pct)}</span></span>`);
  }
  return parts.length ? `<div class="tx-metrics">${parts.join('')}</div>` : '';
}

function showManualTxCard(tx) {
  if (!tx || !tx.to || !tx.data) return;
  const meta = tx.swapMeta;
  const chain = CHAIN_NAMES[tx.chainId] || tx.chainId;

  let tradeHtml;
  if (meta) {
    tradeHtml = `
      <div class="trade-pair">
        <span class="trade-amount sell">${escapeHtml(meta.sellAmount)} ${escapeHtml(meta.sellToken)}</span>
        <span class="trade-arrow">→</span>
        <span class="trade-amount buy">~${escapeHtml(meta.buyAmount)} ${escapeHtml(meta.buyToken)}</span>
      </div>
      <div class="trade-meta">${meta.price ? escapeHtml(meta.price) + ' · ' : ''}${escapeHtml(chain)}</div>
    `;
  } else {
    tradeHtml = `<div class="trade-meta">${escapeHtml(tx.description || 'Execute transaction')} · ${escapeHtml(chain)}</div>`;
  }

  const metricsHtml = formatTxMetrics(tx);

  const div = document.createElement('div');
  div.className = 'msg assistant compact';
  div.innerHTML = `
    <div class="delegated-confirm">
      ${tradeHtml}
      ${metricsHtml}
      <div class="confirm-actions">
        <button class="btn-agent-exec approve" onclick="signManualTxCard(this)">Sign with Wallet</button>
        <button class="btn-agent-exec reject" onclick="this.closest('.msg').remove()">Dismiss</button>
      </div>
      <div class="exec-status"></div>
    </div>
  `;
  div._pendingTx = tx;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

/** Handle signing a manual tx card — opens wallet for the specific tx */
async function signManualTxCard(btn) {
  const msgEl = btn.closest('.msg');
  const tx = msgEl._pendingTx;
  if (!tx || !activeProvider) return;

  const container = btn.closest('.delegated-confirm');
  const statusEl = container.querySelector('.exec-status');
  const buttons = container.querySelectorAll('.btn-agent-exec');
  buttons.forEach(b => b.disabled = true);
  btn.textContent = 'Signing…';

  try {
    const currentChainHex = await activeProvider.request({ method: 'eth_chainId' });
    const targetChainHex = '0x' + tx.chainId.toString(16);
    if (currentChainHex !== targetChainHex) {
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
        to: tx.to,
        data: tx.data,
        gas: tx.gas,
        value: tx.value || '0x0',
      }],
    });

    buttons.forEach(b => b.style.display = 'none');
    statusEl.style.color = 'var(--accent)';
    statusEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span class="spinner"></span> Pending… ${txHash.slice(0, 10)}…${txHash.slice(-6)}</span>`;
    pollManualTxReceipt(txHash, tx, statusEl);
  } catch (err) {
    statusEl.style.color = 'var(--error)';
    statusEl.textContent = `Error: ${err.message || 'User rejected'}`;
    buttons.forEach(b => b.disabled = false);
    btn.textContent = 'Sign with Wallet';
  }
}

/** Poll receipt for a manual tx card */
async function pollManualTxReceipt(txHash, tx, statusEl) {
  const meta = tx.swapMeta;
  const explorerUrl = getExplorerUrl(tx.chainId, txHash);
  const explorerLink = `<a href="${explorerUrl}" target="_blank" rel="noopener">${txHash.slice(0,10)}…${txHash.slice(-6)} ↗</a>`;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const receipt = await activeProvider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt) {
        const success = receipt.status === '0x1';
        statusEl.style.color = success ? 'var(--success)' : 'var(--error)';
        if (success && meta) {
          statusEl.innerHTML = `✓ Swapped ${escapeHtml(meta.sellAmount)} ${escapeHtml(meta.sellToken)} for ${escapeHtml(meta.buyAmount)} ${escapeHtml(meta.buyToken)} · ${explorerLink}`;
        } else {
          statusEl.innerHTML = success
            ? `✓ Transaction confirmed · ${explorerLink}`
            : `✗ Transaction reverted · ${explorerLink}`;
        }
        if (success) {
          // Refresh delegation status (handles chat-based delegation setup)
          window.refreshDelegationStatus();
          // Auto-progress to next strategy step.
          // NOTE: for non-swap txs (bridges, delegation, etc.), pass null rather than
          // tx.description — bridge descriptions contain receive amounts (e.g.
          // "receive ~39.827602 USDT") that the LLM would incorrectly use as swap inputs.
          const desc = meta
            ? `${meta.sellAmount} ${meta.sellToken} → ${meta.buyAmount} ${meta.buyToken}`
            : null;
          setTimeout(() => window.autoProgressAfterTx(desc), 2000);
        }
        return;
      }
    } catch (e) { /* retry */ }
  }
  statusEl.style.color = 'var(--warn)';
  statusEl.innerHTML = `Tx still pending. ${explorerLink}`;
}

/* ================================================================
   Delegated Execution Confirmation (in-chat)
   ================================================================ */
/** Show an in-chat confirmation for delegated execution (agent signs, not you) */
function showTxReceiptCard(r, swapMeta) {
  const isConfirmed = r.confirmed;
  const isReverted = r.reverted;
  const cardClass = isConfirmed ? 'success' : (isReverted ? 'failed' : 'pending');

  const hash = r.txHash;
  const shortHash = hash ? `${hash.slice(0,10)}…${hash.slice(-6)}` : '—';
  // Only allow https explorer URLs — validate scheme to prevent javascript: injection.
  const safeExplorerUrl = (r.explorerUrl && /^https:\/\//i.test(r.explorerUrl)) ? r.explorerUrl : null;
  const explorerLink = safeExplorerUrl
    ? `<a href="${safeExplorerUrl}" target="_blank" rel="noopener">${shortHash} ↗</a>`
    : shortHash;

  const statusIcon = isConfirmed ? '✅' : (isReverted ? '❌' : '⏳');
  let headerHtml;
  if (swapMeta) {
    headerHtml = `<div class="receipt-header"><span class="receipt-status">${statusIcon}</span><span class="receipt-trade">${escapeHtml(swapMeta.sellAmount)} ${escapeHtml(swapMeta.sellToken)} → ${escapeHtml(swapMeta.buyAmount)} ${escapeHtml(swapMeta.buyToken)}</span></div>${swapMeta.price ? `<div class="receipt-price">${escapeHtml(swapMeta.price)}</div>` : ''}`;
  } else {
    const label = isConfirmed ? 'Confirmed' : (isReverted ? 'Reverted' : 'Pending');
    headerHtml = `<div class="receipt-header"><span class="receipt-status">${statusIcon}</span><span class="receipt-trade">${label}</span></div>`;
  }

  const detailParts = [];
  if (r.gasCostEth) detailParts.push(`Gas: ${parseFloat(r.gasCostEth).toFixed(6)} ETH`);
  if (r.blockNumber) detailParts.push(`Block ${r.blockNumber.toLocaleString()}`);
  detailParts.push(explorerLink);

  const div = document.createElement('div');
  div.className = 'msg system';
  div.innerHTML = `<div class="tx-receipt-card ${cardClass}">${headerHtml}<div class="receipt-details">${detailParts.join(' · ')}</div></div>`;
  div._txResult = r;
  div._swapMeta = swapMeta;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

/**
 * Poll the backend for a pending tx until it's confirmed or times out.
 * Uses faster polling for L2 chains with sub-second block times.
 */
async function pollPendingTx(r, swapMeta) {
  const hash = r.txHash;
  if (!hash || hash === '0x') return;

  // L2s and BSC have sub-second blocks — poll faster
  const fastChains = new Set([10, 42161, 8453, 130, 56, 84532]);
  const intervalMs = fastChains.has(r.chainId) ? 1000 : 3000;
  const maxAttempts = fastChains.has(r.chainId) ? 15 : 20;
  let attempts = 0;

  const pollInterval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(pollInterval);
      appendMessage('system', `Transaction still pending after ${maxAttempts * intervalMs / 1000}s. Check explorer for status.`);
      return;
    }

    try {
      const res = await fetch(
        `/api/delegation/tx-status?hash=${hash}&chainId=${r.chainId}`
      );
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'confirmed' || data.status === 'failed') {
        clearInterval(pollInterval);
        if (data.status === 'confirmed') {
          showTxReceiptCard({ ...r, ...data, confirmed: true }, swapMeta);
          // Auto-progress to next strategy step
          const desc = swapMeta
            ? `${swapMeta.sellAmount} ${swapMeta.sellToken} → ${swapMeta.buyAmount} ${swapMeta.buyToken}`
            : 'transaction';
          setTimeout(() => window.autoProgressAfterTx(desc), 2000);
        } else {
          showTxReceiptCard({ ...r, ...data, reverted: true }, swapMeta);
        }
        fetchAgentBalance(vaultInput.value.trim());
      }
    } catch { /* silent retry */ }
  }, intervalMs);
}

export {
  showTxReceiptCard, pollPendingTx,
  showManualTxCard, signManualTxCard, pollManualTxReceipt,
  formatTxMetrics,
};
