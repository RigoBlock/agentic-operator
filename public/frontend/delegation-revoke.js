/**
 * Delegation revoke module — revoke modal and execution.
 */

import {
  connectedAddress, authSignature, authTimestamp,
  executionMode, setExecutionMode,
  delegationState, setDelegationState,
  vaultInput, CHAIN_NAMES, MAINNET_CHAINS_LIST, escapeHtml, apiHeaders,
  currentChainId, activeProvider,
  setAfterValidateVault,
} from "./state.js";

import { fetchDelegationStatus } from "./api.js";

import { appendMessage } from "./chat-ui.js";

import { closeModal, signAuthMessage } from "./wallet.js";

import { refreshDelegationStatus, updateDelegationUI } from "./delegation-status.js";

function openRevokeModal() {
  if (!delegationState || !delegationState.agentAddress) return;

  // Build the set of chains that have active delegation.
  // Use DelegationConfig activeChains as primary (correctly updated on revoke),
  // plus AgentWalletInfo delegatedChains as fallback.
  // Only ADD to the set from isActiveOnChain — never remove — to avoid false
  // negatives from transient RPC failures or stale on-chain check results.
  const activeChainSet = new Set([
    ...(delegationState.activeChains || []),
    ...(delegationState.delegatedChains || []),
  ]);
  if (delegationState.isActiveOnChain) activeChainSet.add(currentChainId);

  const grid = document.getElementById('revoke-chain-checkboxes');
  if (grid) {
    const activeChains = MAINNET_CHAINS_LIST.filter(function(c) { return activeChainSet.has(c.id); });
    if (activeChains.length === 0) {
      grid.innerHTML = '<p style="color:var(--muted);font-size:13px;">No active delegations found.</p>';
    } else {
      grid.innerHTML = activeChains.map(function(c) {
        return '<label class="chain-check-item">' +
          '<input type="checkbox" value="' + c.id + '" checked>' +
          c.name + '</label>';
      }).join('');
    }
  }

  // Reset progress/status
  const statusEl = document.getElementById('revoke-setup-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }
  const progressEl = document.getElementById('revoke-chain-progress');
  if (progressEl) { progressEl.style.display = 'none'; progressEl.innerHTML = ''; }
  const confirmBtn = document.getElementById('revoke-confirm-btn');
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Revoke'; }

  document.getElementById('revoke-modal').classList.add('visible');
}

async function executeRevoke() {
  const vault = vaultInput.value.trim();
  if (!connectedAddress || !vault) return;

  // Ensure operator is authenticated before calling the backend.
  // The revoke endpoint requires a valid authSignature to verify vault ownership.
  if (!authSignature) {
    const auth = await signAuthMessage();
    if (!auth) return; // user rejected the auth signature
  }

  const statusEl = document.getElementById('revoke-setup-status');
  const progressEl = document.getElementById('revoke-chain-progress');
  const confirmBtn = document.getElementById('revoke-confirm-btn');

  // Collect selected chains
  const checked = document.querySelectorAll('#revoke-chain-checkboxes input[type=checkbox]:checked');
  const selectedChains = Array.from(checked).map(function(cb) { return parseInt(cb.value); });
  if (selectedChains.length === 0) {
    statusEl.style.color = 'var(--warn)';
    statusEl.textContent = 'Select at least one chain.';
    return;
  }

  confirmBtn.disabled = true;
  statusEl.style.color = '';
  statusEl.textContent = '';

  // Build per-chain progress rows
  progressEl.innerHTML = selectedChains.map(function(chainId) {
    return '<div class="chain-progress-row cpr-pending" id="rcpr-' + chainId + '">' +
      '<span class="cpr-icon">○</span>' +
      '<span class="cpr-name">' + (CHAIN_NAMES[chainId] || chainId) + '</span>' +
      '<span class="cpr-status" id="rcpr-s-' + chainId + '">Pending</span>' +
      '</div>';
  }).join('');
  progressEl.style.display = '';

  let anySuccess = false;

  for (let ci = 0; ci < selectedChains.length; ci++) {
    const chainId = selectedChains[ci];
    const row = document.getElementById('rcpr-' + chainId);
    const rowStatus = document.getElementById('rcpr-s-' + chainId);

    row.className = 'chain-progress-row cpr-active';
    row.querySelector('.cpr-icon').textContent = '…';
    rowStatus.textContent = 'Calling backend…';

    try {
      // ── Step 1: Backend revoke → get unsigned revokeAllDelegations() tx ──
      const res = await fetch('/api/delegation/revoke', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          operatorAddress: connectedAddress,
          vaultAddress: vault,
          chainId: chainId,
          authSignature,
          authTimestamp,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      const data = await res.json();

      if (data.transaction) {
        // ── Step 2: Switch wallet to this chain ──
        rowStatus.textContent = 'Switching chain…';
        const targetHex = '0x' + chainId.toString(16);
        try {
          const walletChainHex = await activeProvider.request({ method: 'eth_chainId' });
          if (walletChainHex !== targetHex) {
            await activeProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetHex }] });
            await new Promise(function(r) { setTimeout(r, 500); });
          }
        } catch (switchErr) {
          if (switchErr.code === 4001) throw new Error('Chain switch rejected');
          throw new Error('Switch failed: ' + (switchErr.message || switchErr));
        }

        // ── Step 2b: Check vault exists on this chain (skip on-chain tx if not) ──
        try {
          const code = await activeProvider.request({ method: 'eth_getCode', params: [vault, 'latest'] });
          if (!code || code === '0x' || code === '0x0') {
            // Vault not deployed here — KV was already cleared, nothing to revoke on-chain
            row.className = 'chain-progress-row cpr-done';
            row.querySelector('.cpr-icon').textContent = '✓';
            rowStatus.textContent = 'Cleared (no pool on chain)';
            anySuccess = true;
            continue;
          }
        } catch (codeErr) {
          console.warn('[Revoke] eth_getCode failed on chain', chainId, codeErr.message);
        }

        // ── Step 3: Send revokeAllDelegations() transaction ──
        rowStatus.textContent = 'Sign in wallet…';
        const tx = data.transaction;
        let txHash;
        try {
          const estimatedGas = await activeProvider.request({
            method: 'eth_estimateGas',
            params: [{ from: connectedAddress, to: tx.to, data: tx.data, value: '0x0' }],
          });
          const gasWithBuffer = '0x' + Math.ceil(parseInt(estimatedGas, 16) * 1.2).toString(16);
          txHash = await activeProvider.request({
            method: 'eth_sendTransaction',
            params: [{ from: connectedAddress, to: tx.to, data: tx.data, value: '0x0', gas: gasWithBuffer }],
          });
        } catch (sendErr) {
          if (sendErr.code === 4001 || (sendErr.message && (sendErr.message.includes('rejected') || sendErr.message.includes('denied')))) {
            throw new Error('Rejected by user');
          }
          throw new Error('Send failed: ' + sendErr.message);
        }

        // ── Step 4: Wait for receipt ──
        rowStatus.textContent = 'Confirming…';
        let confirmed = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(function(r) { setTimeout(r, 2000); });
          try {
            const receipt = await activeProvider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
            if (receipt && receipt.status === '0x1') { confirmed = true; break; }
            if (receipt && receipt.status === '0x0') throw new Error('Transaction reverted on-chain');
          } catch (e) {
            if (e.message && e.message.includes('reverted')) throw e;
          }
        }
        if (!confirmed) throw new Error('Not confirmed after 60s');
      }

      row.className = 'chain-progress-row cpr-done';
      row.querySelector('.cpr-icon').textContent = '✓';
      rowStatus.textContent = 'Revoked';
      anySuccess = true;

    } catch (err) {
      row.className = 'chain-progress-row cpr-error';
      row.querySelector('.cpr-icon').textContent = '✕';
      rowStatus.textContent = err.message.slice(0, 60);
    }
  }

  // Final status
  if (anySuccess) {
    statusEl.style.color = 'var(--success)';
    statusEl.textContent = '✓ Delegation revoked.';
    confirmBtn.textContent = 'Done';
    confirmBtn.onclick = function() { closeModal('revoke-modal'); };
    confirmBtn.disabled = false;
    refreshDelegationStatus();
  } else {
    statusEl.style.color = 'var(--error)';
    statusEl.textContent = 'Revocation failed on all selected chains.';
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Retry';
  }
}

async function revokeDelegation() {
  if (!connectedAddress) return;
  const vault = vaultInput.value.trim();
  if (!vault) return;

  const chainName = CHAIN_NAMES[currentChainId] || 'chain ' + currentChainId;
  if (!confirm(`Revoke agent delegation on ${chainName}?\nThis will remove the agent's authority to execute vault functions.`)) return;

  try {
    appendMessage('system', 'Revoking delegation…');

    // Step 1: Call backend to get unsigned revokeAllDelegations() tx + clear KV
    const res = await fetch('/api/delegation/revoke', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        operatorAddress: connectedAddress,
        vaultAddress: vault,
        chainId: currentChainId,
        authSignature,
        authTimestamp,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Revoke failed');
    }

    const data = await res.json();

    // Step 2: Send the on-chain revocation tx if provided
    if (data.transaction) {
      // Ensure correct chain
      const targetChainHex = '0x' + currentChainId.toString(16);
      const walletChainHex = await activeProvider.request({ method: 'eth_chainId' });
      if (walletChainHex !== targetChainHex) {
        appendMessage('system', `Switching to ${chainName}…`);
        await activeProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetChainHex }],
        });
        await new Promise(r => setTimeout(r, 500));
      }

      appendMessage('system', `Sending revocation tx on ${chainName}…`);
      // Estimate gas dynamically — revocation clears dynamic arrays,
      // gas usage depends on how many selectors are being revoked.
      const revokeEstimate = await activeProvider.request({
        method: 'eth_estimateGas',
        params: [{
          from: connectedAddress,
          to: data.transaction.to,
          data: data.transaction.data,
          value: '0x0',
        }],
      });
      const revokeGas = '0x' + Math.ceil(parseInt(revokeEstimate, 16) * 1.2).toString(16);
      console.log('[Delegation] Revocation estimated gas:', parseInt(revokeEstimate, 16), '→ with buffer:', parseInt(revokeGas, 16));

      const txHash = await activeProvider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: connectedAddress,
          to: data.transaction.to,
          data: data.transaction.data,
          value: '0x0',
          gas: revokeGas,
        }],
      });

      // Wait for confirmation (up to 60s)
      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const receipt = await activeProvider.request({
            method: 'eth_getTransactionReceipt',
            params: [txHash],
          });
          if (receipt && receipt.status === '0x1') {
            confirmed = true;
            appendMessage('system', `Revocation confirmed on ${chainName}: ${txHash.slice(0,10)}…`);
            break;
          } else if (receipt && receipt.status === '0x0') {
            throw new Error('Revocation transaction reverted');
          }
        } catch (e) {
          if (e.message?.includes('reverted')) throw e;
        }
      }
      if (!confirmed) {
        appendMessage('system', `Revocation tx pending: ${txHash.slice(0,10)}… (check explorer)`);
      }
    }

    appendMessage('system', data.message || 'Delegation revoked.');
    refreshDelegationStatus();
  } catch (err) {
    if (err.code === 4001 || err.message?.includes('rejected')) {
      appendMessage('system', 'Revocation cancelled by user. Backend delegation was cleared but on-chain delegation may still be active.');
    } else {
      appendMessage('system', `Revoke failed: ${err.message}`);
    }
  }
}

// Refresh delegation when vault changes
setAfterValidateVault(async () => {
  // Only load delegation data when the connected wallet IS the vault owner.
  // Otherwise clear the panel so stale agent info doesn't persist.
  const statusEl = document.getElementById('vault-status');
  const isNonOwner = statusEl && statusEl.className.includes('error');
  if (isNonOwner) {
    setDelegationState(null);
    setExecutionMode('manual');
    updateDelegationUI(null);
  } else {
    refreshDelegationStatus();
  }
});

// Auto-refresh delegation on load
(function initDelegation() {
  setTimeout(() => window.refreshDelegationStatus?.() || refreshDelegationStatus(), 600);
})();

// One-time cleanup: remove old per-vault swap-shield keys from earlier versions
(function cleanupOldShieldKeys() {
  const hasRun = localStorage.getItem('rigoblock_shield_cleanup_v3');
  if (hasRun) return;
  // Remove any keys that were namespaced with a vault address
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('rigoblock_swap_shield:') || key.startsWith('rigoblock_swap_shield_tolerance:'))) {
      localStorage.removeItem(key);
    }
  }
  localStorage.setItem('rigoblock_shield_cleanup_v3', '1');
})();

/* ================================================================
   Pool Onboarding — show/hide based on vault input
   ================================================================ */

export { openRevokeModal, executeRevoke, revokeDelegation };
