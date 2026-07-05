/**
 * Delegation status module — sync mode, refresh status, update UI/hint.
 */

import {
  connectedAddress, authSignature, authTimestamp,
  executionMode, setExecutionMode,
  autoExecuteMode, setAutoExecuteMode,
  delegationState, setDelegationState,
  vaultInput, CHAIN_NAMES, escapeHtml, apiHeaders,
  currentChainId, MAINNET_CHAINS_LIST, copyToClipboard,
} from "./state.js";

import { fetchDelegationStatus, fetchAgentBalance } from "./api.js";

/* ================================================================
   Execution Mode — auto-detected from delegation status
   ================================================================ */

/** Auto-detect execution mode from delegation state.
 *  Allows delegated mode if delegation is active on ANY chain,
 *  not just the current one — enables multi-chain delegated swaps. */
export function syncExecutionMode() {
  if (delegationState &&
      (delegationState.enabled || delegationState.isActiveOnChain) &&
      (delegationState.isActiveOnChain || (delegationState.activeChains && delegationState.activeChains.length > 0))) {
    setExecutionMode('delegated');
  } else {
    setExecutionMode('manual');
  }
}

/* ================================================================
   Delegation Status & Management
   ================================================================ */

/**
 * Fetch on-chain delegation status for ALL supported chains.
 * Caches the result in delegationState.allChainsStatus for the modal.
 */
export async function fetchAllDelegationStatuses(vault) {
  try {
    const res = await fetch(`/api/delegation/status?vaultAddress=${vault}&allChains=true`);
    if (!res.ok) return null;
    const data = await res.json();
    // Merge allChainsStatus into the existing delegationState
    if (delegationState && data.allChainsStatus) {
      delegationState.allChainsStatus = data.allChainsStatus;
    }
    return data.allChainsStatus;
  } catch (err) {
    console.warn('[Delegation] Failed to fetch all-chain status:', err);
    return null;
  }
}

export async function refreshDelegationStatus() {
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) {
    updateDelegationUI(null);
    return;
  }

  try {
    const res = await fetch(`/api/delegation/status?vaultAddress=${vault}&chainId=${currentChainId}&verify=true`);
    if (!res.ok) throw new Error('Failed to fetch');
    setDelegationState(await res.json());

    // Auto-heal: if on-chain delegation is active but KV doesn't have this chain,
    // sync KV by calling the confirm endpoint (handles chat-based delegation setup)
    if (delegationState.isActiveOnChain && !delegationState.isActiveInKV &&
        delegationState.agentAddress && connectedAddress && authSignature && authTimestamp) {
      try {
        const confirmRes = await fetch('/api/delegation/confirm', {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify({
            operatorAddress: connectedAddress,
            vaultAddress: vault,
            chainId: currentChainId,
            authSignature,
            authTimestamp,
            txHash: '0x' + '0'.repeat(64), // placeholder — on-chain state is proof enough
          }),
        });
        if (confirmRes.ok) {
          // Re-fetch with updated KV
          const res2 = await fetch(`/api/delegation/status?vaultAddress=${vault}&chainId=${currentChainId}&verify=true`);
          if (res2.ok) setDelegationState(await res2.json());
        }
      } catch { /* best-effort sync */ }
    }

    updateDelegationUI(delegationState);
    syncExecutionMode();

    // Also fetch balance if delegation is active on current chain
    const isActive = delegationState.isActiveOnChain != null
      ? delegationState.isActiveOnChain
      : (delegationState.isActiveInKV || false);
    if (delegationState.agentAddress && isActive) {
      fetchAgentBalance(vault);
    }
  } catch {
    updateDelegationUI(null);
  }
}

export function updateDelegationHint(state) {
  const hint = document.getElementById('delegation-hint');
  const hintText = document.getElementById('delegation-hint-text');
  const hintBtn = document.getElementById('delegation-hint-btn');
  if (!hint) return;

  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42 || !connectedAddress) {
    hint.style.display = 'none';
    return;
  }

  if (!state || (!state.agentAddress && !state.isActiveOnChain)) {
    // No delegation at all
    hint.className = '';
    hint.style.display = 'flex';
    hintText.innerHTML = '<strong>Agent execution off</strong> — Enable to trade without signing every transaction';
    hintBtn.textContent = 'Enable';
    hintBtn.onclick = window.openDelegationSetup;
  } else {
    const isActive = state.isActiveOnChain != null ? state.isActiveOnChain : (state.isActiveInKV || false);
    if (isActive) {
      // Delegation active on current chain — hide hint
      hint.style.display = 'none';
    } else {
      // Agent exists but not on this chain
      hint.className = 'active-other-chain';
      hint.style.display = 'flex';
      hintText.innerHTML = '<strong>Agent not enabled on this chain</strong> — Delegate for the best experience';
      hintBtn.textContent = 'Delegate';
      hintBtn.onclick = () => window.openDelegationSetup(currentChainId);
    }
  }
}

export function updateDelegationUI(state) {
  updateDelegationHint(state);
  const badge = document.getElementById('delegation-status-badge');
  const statusText = document.getElementById('delegation-status-text');
  const setupBtn = document.getElementById('delegation-setup-btn');
  const revokeBtn = document.getElementById('delegation-revoke-btn');
  const telegramBtn = document.getElementById('telegram-pair-btn');
  const telegramResetBtn = document.getElementById('telegram-reset-btn');
  const telegramSection = document.getElementById('telegram-section');
  const telegramBadge = document.getElementById('telegram-status-badge');
  const telegramStatusText = document.getElementById('telegram-status-text');
  const agentAddr = document.getElementById('agent-addr');
  const balanceEl = document.getElementById('agent-balance-display');
  const sponsorLabel = document.getElementById('sponsor-toggle-label');
  const sponsorToggle = document.getElementById('sponsor-toggle');

  const anyDelegated = state && state.agentAddress && (state.delegatedChains || []).length > 0;

  if (!state || (!state.enabled && !state.isActiveOnChain && !anyDelegated)) {
    // Completely not set up — no agent wallet at all
    badge.className = 'delegation-status inactive';
    statusText.textContent = 'Not set up';
    setupBtn.style.display = '';
    setupBtn.textContent = 'Set Up Delegation';
    setupBtn.title = '';
    setupBtn.onclick = () => window.openDelegationSetup();
    revokeBtn.style.display = 'none';
    if (telegramSection) telegramSection.style.display = 'none';
    if (telegramBtn) telegramBtn.style.display = 'none';
    if (telegramResetBtn) telegramResetBtn.style.display = 'none';
    const chatModeInactive = document.getElementById('chat-mode-bar');
    if (chatModeInactive) chatModeInactive.style.display = 'none';
    agentAddr.style.display = 'none';
    balanceEl.style.display = 'none';
    if (sponsorLabel) sponsorLabel.style.display = 'none';

  } else {
    // Use on-chain status if available, fall back to KV status
    const isOnChain = state.isActiveOnChain != null ? state.isActiveOnChain : (state.isActiveInKV || false);

    let missingCount = 0;
    if (isOnChain) {
      const onChain = state.onChainStatus;
      missingCount = onChain?.undelegatedSelectors?.length || 0;
      if (missingCount > 0) {
        badge.className = 'delegation-status stale';
        statusText.textContent = `Active (${missingCount} selector${missingCount > 1 ? 's' : ''} missing)`;
      } else {
        badge.className = 'delegation-status active';
        statusText.textContent = 'Active';
      }
    } else {
      // Agent exists, active on other chains but not this one — chips show per-chain detail
      badge.className = 'delegation-status active';
      statusText.textContent = 'Active';
    }

    // Compute total missing selectors across ALL chains (if allChainsStatus is available)
    let totalMissingAcrossAllChains = missingCount;
    let anyChainNeedsSetup = !isOnChain;
    if (state.allChainsStatus) {
      for (const cid of Object.keys(state.allChainsStatus)) {
        const cs = state.allChainsStatus[cid];
        if (cs.missingCount > 0) {
          anyChainNeedsSetup = true;
          totalMissingAcrossAllChains += cs.missingCount;
        }
      }
    }

    // Setup button: shown when current chain needs setup OR any chain has missing selectors.
    // If we haven't fetched allChainsStatus yet, always show the button so the user can
    // open the modal and check other chains.
    if (!isOnChain) {
      setupBtn.style.display = '';
      setupBtn.textContent = 'Delegate';
      setupBtn.title = 'Set up delegation on this chain';
      setupBtn.onclick = () => window.openDelegationSetup(currentChainId);
    } else if (anyChainNeedsSetup || !state.allChainsStatus) {
      setupBtn.style.display = '';
      // If current chain is complete but others need updates (or status unknown), show generic label
      const label = missingCount > 0 ? `Update (${missingCount} new)` : 'Update Delegation';
      setupBtn.textContent = label;
      setupBtn.title = missingCount > 0
        ? `${missingCount} new function selector${missingCount > 1 ? 's are' : ' is'} available`
        : 'Check and update delegation across chains';
      setupBtn.onclick = () => window.openDelegationSetup(currentChainId);
    } else {
      setupBtn.style.display = 'none';
    }

    // Revoke button: visible whenever any chain has delegation
    revokeBtn.style.display = anyDelegated ? '' : 'none';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.onclick = () => window.openRevokeModal();
    // Telegram section: only visible when delegation is active on this chain
    if (telegramSection) {
      telegramSection.style.display = isOnChain ? '' : 'none';
    }
    if (telegramBadge && telegramStatusText) {
      if (state.telegramPaired) {
        telegramBadge.className = 'delegation-status active';
        telegramStatusText.textContent = 'Linked';
      } else {
        telegramBadge.className = 'delegation-status inactive';
        telegramStatusText.textContent = 'Not linked';
      }
    }
    if (telegramBtn) {
      telegramBtn.style.display = (isOnChain && !state.telegramPaired) ? '' : 'none';
    }
    if (telegramResetBtn) {
      telegramResetBtn.style.display = (isOnChain && state.telegramPaired) ? '' : 'none';
    }

    // Execution mode toggle — visible in chat input when delegation is active
    const chatModeBar = document.getElementById('chat-mode-bar');
    if (chatModeBar) {
      chatModeBar.style.display = isOnChain ? 'flex' : 'none';
    }

    // Balance is chain-specific — only meaningful when active on current chain
    if (!isOnChain) {
      balanceEl.style.display = 'none';
    }

    // Gas sponsoring toggle — per-chain, only visible when active on current chain
    if (sponsorLabel && sponsorToggle) {
      if (isOnChain) {
        const chainSponsored = state.chainSponsoredGas !== undefined ? state.chainSponsoredGas : (state.sponsoredGas !== false);
        sponsorToggle.checked = chainSponsored;
        const sponsorText = document.getElementById('sponsor-toggle-text');
        if (sponsorText) sponsorText.textContent = `Sponsored gas (${CHAIN_NAMES[currentChainId] || currentChainId})`;
        sponsorLabel.style.display = '';
      } else {
        sponsorLabel.style.display = 'none';
      }
    }

    if (state.agentAddress) {
      const addr = state.agentAddress;
      const short = addr.slice(0, 6) + '\u2026' + addr.slice(-4);
      agentAddr.textContent = `Agent: ${short}`;
      agentAddr.title = `${addr} — click to copy`;
      agentAddr.dataset.address = addr;
      agentAddr.onclick = () => copyToClipboard(addr);
      agentAddr.style.display = '';
    }

    // Wallet-change warning — shown when CDP credential rotation is detected.
    // The old delegation is now useless; the operator must re-delegate.
    const existingWarn = document.getElementById('wallet-changed-warn');
    if (state.walletChanged) {
      const prev = state.previousAgentAddress
        ? state.previousAgentAddress.slice(0, 6) + '…' + state.previousAgentAddress.slice(-4)
        : 'previous address';
      const msg = `⚠️ Agent wallet changed (${prev} → ${state.agentAddress?.slice(0,6)}…). ` +
        `The old on-chain delegation is now invalid. Click "Set Up Delegation" to re-delegate to the new agent wallet.`;
      if (existingWarn) {
        existingWarn.textContent = msg;
      } else {
        const warn = document.createElement('div');
        warn.id = 'wallet-changed-warn';
        warn.style.cssText = 'margin-top:10px;padding:10px 14px;background:rgba(255,170,0,0.12);border:1px solid var(--warn);border-radius:8px;font-size:13px;color:var(--warn);line-height:1.5;';
        warn.textContent = msg;
        badge.parentElement.appendChild(warn);
      }
      // Force status badge to stale so operator knows action is required
      badge.className = 'delegation-status stale';
      statusText.textContent = 'Re-delegation required';
      setupBtn.style.display = '';
      setupBtn.textContent = 'Re-delegate to New Agent';
    } else if (existingWarn) {
      existingWarn.remove();
    }
  }

  // Per-chain delegation chips — show which chains are active
  const chipsEl = document.getElementById('delegation-chain-chips');
  if (chipsEl) {
    if (state && state.agentAddress) {
      // Build a set of chains known to be active from delegatedChains (KV)
      const activeChainSet = new Set(state.delegatedChains || []);
      // Apply on-chain verified status for current chain
      if (state.isActiveOnChain !== undefined) {
        if (state.isActiveOnChain) activeChainSet.add(currentChainId);
        else activeChainSet.delete(currentChainId);
      }
      chipsEl.innerHTML = MAINNET_CHAINS_LIST.map(function(c) {
        const isActive = activeChainSet.has(c.id);
        return '<span class="chain-chip' + (isActive ? ' active' : '') + '">' +
          '<span class="cc-dot"></span>' + c.name + '</span>';
      }).join('');
      chipsEl.style.display = '';
    } else {
      chipsEl.style.display = 'none';
    }
  }

  // Load execution mode preference for this vault
  loadExecMode();
}

export async function toggleSponsoredGas(checked) {
  const vault = vaultInput.value.trim();
  if (!vault || !connectedAddress) return;
  try {
    const res = await fetch('/api/delegation/settings', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        operatorAddress: connectedAddress,
        vaultAddress: vault,
        chainId: currentChainId,
        sponsoredGas: checked,
        authSignature,
        authTimestamp,
      }),
    });
    if (!res.ok) throw new Error('Failed to update');
    // Update cached state
    if (delegationState) {
      delegationState.chainSponsoredGas = checked;
      if (delegationState.allChainsStatus) {
        const cs = delegationState.allChainsStatus[String(currentChainId)];
        if (cs) cs.sponsoredGas = checked;
      }
    }
    const chainName = CHAIN_NAMES[currentChainId] || currentChainId;
    window.appendMessage('system', checked
      ? `Gas sponsoring enabled on ${chainName} — no agent funding needed.`
      : `Gas sponsoring disabled on ${chainName} — agent will pay gas from its own ETH balance.`);
  } catch (err) {
    window.appendMessage('system', `Failed to update gas setting: ${err.message}`);
    document.getElementById('sponsor-toggle').checked = !checked; // revert
  }
}

// Execution mode: autonomous (auto-execute) vs confirm (require button click)
// Stored in KV per operator and shared with Telegram.
export async function toggleExecMode(checked) {
  const vault = vaultInput.value.trim();
  if (!vault || !connectedAddress || !authSignature) return;
  const mode = checked ? 'autonomous' : 'confirm';
  try {
    const res = await fetch('/api/settings/exec-mode', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        operatorAddress: connectedAddress,
        vaultAddress: vault,
        chainId: currentChainId,
        authSignature,
        authTimestamp,
        mode,
      }),
    });
    if (!res.ok) throw new Error('Failed to save');
    setAutoExecuteMode(mode);
    updateExecModeLabel(mode);
    window.appendMessage('system', checked
      ? 'Switched to autonomous mode — trades execute immediately.'
      : 'Switched to confirm mode — you\'ll review each trade before execution.');
  } catch (err) {
    console.warn('[Delegation] Failed to update exec mode:', err);
    window.appendMessage('system', `Failed to update execution mode: ${err.message}`);
    updateExecModeLabel(autoExecuteMode);
  }
}

export async function loadExecMode() {
  const vault = vaultInput.value.trim();
  if (!vault || !connectedAddress || !authSignature) {
    updateExecModeLabel('confirm');
    return;
  }
  try {
    const params = new URLSearchParams({
      operatorAddress: connectedAddress,
      vaultAddress: vault,
      chainId: String(currentChainId),
      authSignature,
      authTimestamp: String(authTimestamp),
    });
    const res = await fetch(`/api/settings/exec-mode?${params.toString()}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error('Failed to load');
    const { mode } = await res.json();
    setAutoExecuteMode(mode === 'autonomous' ? 'autonomous' : 'confirm');
    updateExecModeLabel(autoExecuteMode);
  } catch (err) {
    console.warn('[Delegation] Failed to load exec mode:', err);
    updateExecModeLabel('confirm');
  }
}

function updateExecModeLabel(mode) {
  const cb = document.getElementById('chat-mode-checkbox');
  const label = document.getElementById('chat-mode-label');
  if (cb) cb.checked = mode === 'autonomous';
  if (label) label.textContent = mode === 'autonomous' ? '⚡ Autonomous' : '🔔 Confirm trades';
}
