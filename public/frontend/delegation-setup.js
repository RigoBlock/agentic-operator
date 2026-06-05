/**
 * Delegation setup module — open/setup delegation flow.
 */

import {
  connectedAddress, authSignature, authTimestamp,
  executionMode, setExecutionMode,
  delegationState, setDelegationState,
  vaultInput, CHAIN_NAMES, MAINNET_CHAINS_LIST, escapeHtml, apiHeaders, copyToClipboard,
  currentChainId, activeProvider,
} from "./state.js";

import { fetchDelegationStatus, fetchAgentBalance } from "./api.js";

import { appendMessage } from "./chat-ui.js";

import { closeModal, openWalletPicker } from "./wallet.js";

import { fetchAllDelegationStatuses, refreshDelegationStatus } from "./delegation-status.js";

async function openDelegationSetup(targetChainId) {
  if (!connectedAddress) {
    appendMessage('system', 'Connect your wallet first to set up delegation.');
    openWalletPicker();
    return;
  }
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) {
    appendMessage('system', 'Enter a valid vault address first.');
    return;
  }

  // Reset modal state
  document.getElementById('delegation-agent-info').style.display = 'none';
  document.getElementById('delegation-setup-status').textContent = '';
  document.getElementById('delegation-chain-progress').style.display = 'none';
  document.getElementById('delegation-chain-progress').innerHTML = '';
  const confirmBtn = document.getElementById('delegation-confirm-btn');
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Update Delegation';
  confirmBtn.onclick = startDelegationSetup;

  // Ensure we have all-chain status before opening the modal
  if (!delegationState?.allChainsStatus) {
    document.getElementById('delegation-setup-status').textContent = 'Checking delegation status across all chains…';
    await fetchAllDelegationStatuses(vault);
  }

  const allChainsStatus = delegationState?.allChainsStatus || {};
  const activeSet = new Set(delegationState?.delegatedChains || []);
  // Current chain missing count from the most recent single-chain fetch
  const currentMissing = delegationState?.onChainStatus?.undelegatedSelectors?.length || 0;

  const grid = document.getElementById('delegation-chain-checkboxes');
  if (grid) {
    const items = [];
    for (const c of MAINNET_CHAINS_LIST) {
      const chainStatus = allChainsStatus[String(c.id)];
      const hasOnChainData = !!chainStatus;
      const isFullyDelegated = hasOnChainData ? chainStatus.allDelegated : activeSet.has(c.id);
      const missingHere = hasOnChainData ? chainStatus.missingCount : (activeSet.has(c.id) ? 0 : 20);
      const isTarget = c.id === targetChainId;

      // HIDE chains where delegation is fully complete (all selectors on-chain)
      if (isFullyDelegated && missingHere === 0) {
        continue;
      }

      // Pre-check chains that need action:
      //   - Target chain (if specified)
      //   - Chains with missing selectors
      //   - Inactive chains (fresh setup)
      const checked = isTarget || missingHere > 0 || !activeSet.has(c.id);

      let label = c.name;
      if (missingHere > 0) {
        label += ' — Update (' + missingHere + ' new)';
      } else if (activeSet.has(c.id)) {
        label += ' — Update';
      }

      items.push('<label class="chain-check-item' + (activeSet.has(c.id) ? ' already-active' : '') + '">' +
        '<input type="checkbox" value="' + c.id + '"' + (checked ? ' checked' : '') + '>' +
        label + '</label>');
    }

    if (items.length === 0) {
      grid.innerHTML = '<p style="color:var(--success);margin:0;">✓ All chains are fully delegated. Nothing to update.</p>';
      confirmBtn.disabled = true;
    } else {
      grid.innerHTML = items.join('');
    }
  }

  document.getElementById('delegation-modal').classList.add('visible');
}

async function startDelegationSetup() {
  const vault = vaultInput.value.trim();
  const statusEl = document.getElementById('delegation-setup-status');
  const progressEl = document.getElementById('delegation-chain-progress');
  const confirmBtn = document.getElementById('delegation-confirm-btn');

  // Collect selected chains from checkboxes
  const checked = document.querySelectorAll('#delegation-chain-checkboxes input[type=checkbox]:checked:not([disabled])');
  const selectedChains = Array.from(checked).map(function(cb) { return parseInt(cb.value); });
  if (selectedChains.length === 0) {
    statusEl.style.color = 'var(--warn)';
    statusEl.textContent = 'Select at least one chain.';
    return;
  }

  confirmBtn.disabled = true;
  statusEl.style.color = 'var(--accent)';
  statusEl.textContent = '';

  // Build per-chain progress rows
  progressEl.innerHTML = selectedChains.map(function(chainId) {
    return '<div class="chain-progress-row cpr-pending" id="cpr-' + chainId + '">' +
      '<span class="cpr-icon">○</span>' +
      '<span class="cpr-name">' + (CHAIN_NAMES[chainId] || chainId) + '</span>' +
      '<span class="cpr-status" id="cpr-s-' + chainId + '">Pending</span>' +
      '</div>';
  }).join('');
  progressEl.style.display = '';

  let anySuccess = false;
  let firstAgentAddress = null;

  for (let ci = 0; ci < selectedChains.length; ci++) {
    const chainId = selectedChains[ci];
    const row = document.getElementById('cpr-' + chainId);
    const rowStatus = document.getElementById('cpr-s-' + chainId);

    row.className = 'chain-progress-row cpr-active';
    row.querySelector('.cpr-icon').textContent = '…';
    rowStatus.textContent = 'Creating wallet…';

    try {
      // ── Step 1: Backend setup → get unsigned updateDelegation() tx ──
      // Pass undelegatedSelectors from the already-fetched status so the server
      // doesn't need to re-check on-chain (avoids a duplicate RPC call).
      const undelegatedHint = chainId === currentChainId
        ? (delegationState?.onChainStatus?.undelegatedSelectors || null)
        : null;
      const setupRes = await fetch('/api/delegation/setup', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          operatorAddress: connectedAddress,
          vaultAddress: vault,
          chainId: chainId,
          authSignature,
          authTimestamp,
          ...(undelegatedHint && undelegatedHint.length > 0 ? { undelegatedSelectors: undelegatedHint } : {}),
        }),
      });
      if (!setupRes.ok) {
        const err = await setupRes.json().catch(function() { return {}; });
        throw new Error(err.error || 'HTTP ' + setupRes.status);
      }
      const setupData = await setupRes.json();

      // Show agent wallet once (same address across all chains for this vault)
      if (!firstAgentAddress && setupData.agentAddress) {
        firstAgentAddress = String(setupData.agentAddress);
        const infoEl = document.getElementById('delegation-agent-info');
        infoEl.innerHTML = '<div class="row" id="delegation-agent-row"></div>' +
          '<div class="row"><span class="label">Vault</span><span class="value">' +
          escapeHtml(vault.slice(0,6)) + '…' + escapeHtml(vault.slice(-4)) + '</span></div>';
        const agentRow = document.getElementById('delegation-agent-row');
        const agentLabel = document.createElement('span');
        agentLabel.className = 'label';
        agentLabel.textContent = 'Agent Wallet';
        const agentValue = document.createElement('span');
        agentValue.className = 'value copyable-addr';
        agentValue.title = 'Click to copy';
        agentValue.textContent = firstAgentAddress;
        agentValue.addEventListener('click', function() { copyToClipboard(firstAgentAddress); });
        agentRow.appendChild(agentLabel);
        agentRow.appendChild(agentValue);
        infoEl.style.display = '';
      }

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
        if (switchErr.code === 4902) throw new Error('Chain not in wallet — add ' + (CHAIN_NAMES[chainId] || chainId) + ' manually');
        throw new Error('Switch failed: ' + (switchErr.message || switchErr));
      }

      // ── Step 2b: Verify vault exists on this chain ──
      rowStatus.textContent = 'Checking vault…';
      try {
        const code = await activeProvider.request({ method: 'eth_getCode', params: [vault, 'latest'] });
        if (!code || code === '0x' || code === '0x0') {
          throw new Error('No smart pool on ' + (CHAIN_NAMES[chainId] || chainId) + ' — deploy the pool first');
        }
      } catch (codeErr) {
        // Re-throw vault-not-found errors; ignore RPC hiccups (contract check is advisory)
        if (codeErr.message && codeErr.message.includes('deploy the pool first')) throw codeErr;
        console.warn('[Delegation] eth_getCode failed on chain', chainId, codeErr.message);
      }

      // ── Step 3: Send updateDelegation() transaction ──
      rowStatus.textContent = 'Sign in wallet…';
      const tx = setupData.transaction;
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
      for (let i = 0; i < 60; i++) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        try {
          const receipt = await activeProvider.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
          if (receipt && receipt.status === '0x1') { confirmed = true; break; }
          if (receipt && receipt.status === '0x0') throw new Error('Transaction reverted on-chain');
        } catch (e) {
          if (e.message && e.message.includes('reverted')) throw e;
        }
      }
      if (!confirmed) throw new Error('Not confirmed after 2 min');

      // ── Step 5: Notify backend ──
      rowStatus.textContent = 'Saving…';
      await fetch('/api/delegation/confirm', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          operatorAddress: connectedAddress,
          vaultAddress: vault,
          chainId: chainId,
          authSignature,
          authTimestamp,
          txHash,
        }),
      });

      row.className = 'chain-progress-row cpr-done';
      row.querySelector('.cpr-icon').textContent = '✓';
      rowStatus.textContent = 'Active';
      anySuccess = true;

    } catch (err) {
      row.className = 'chain-progress-row cpr-error';
      row.querySelector('.cpr-icon').textContent = '✕';
      rowStatus.textContent = err.message.slice(0, 60);
      // Continue with remaining chains even if one fails
    }
  }

  // Final status
  if (anySuccess) {
    statusEl.style.color = 'var(--success)';
    statusEl.textContent = '✓ Delegation set up! The agent can now execute vault functions.';
    confirmBtn.textContent = 'Done';
    confirmBtn.onclick = function() { closeModal('delegation-modal'); };
    confirmBtn.disabled = false;
    if (firstAgentAddress) {
      appendMessage('system', 'Agent delegation active. Agent: ' + firstAgentAddress.slice(0,6) + '…' + firstAgentAddress.slice(-4));
    }
    refreshDelegationStatus();
  } else {
    statusEl.style.color = 'var(--error)';
    statusEl.textContent = 'Setup failed on all selected chains.';
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Retry';
  }
}


export { openDelegationSetup, startDelegationSetup };
