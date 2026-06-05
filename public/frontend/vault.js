import {
  connectedAddress,
  currentChainId, setCurrentChainId,
  vaultInput,
  CHAIN_NAMES, TESTNET_CHAINS_LIST,
  lastEventTimestamp, setLastEventTimestamp,
  strategyPollTimer, setStrategyPollTimer,
  setExecutionMode, setDelegationState,
  afterValidateVault,
} from './state.js';

import {
  applyTestnetState, updateChainDisplay,
} from './settings.js';

import { appendMessage } from './chat-ui.js';

/* ================================================================
   Saved Vaults (localStorage)
   ================================================================ */
const VAULT_STORAGE_KEY = 'rigoblock_operated_vaults';

function getSavedVaults() {
  try { return JSON.parse(localStorage.getItem(VAULT_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveVault(address, chainId, name) {
  // Deduplicate by address only -- a vault address is unique across chains
  const vaults = getSavedVaults().filter(v => v.address.toLowerCase() !== address.toLowerCase());
  vaults.unshift({ address, chainId, name: name || '', lastUsed: Date.now() });
  if (vaults.length > 20) vaults.length = 20;
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(vaults));
}

function removeVault(address) {
  const vaults = getSavedVaults().filter(v => v.address.toLowerCase() !== address.toLowerCase());
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(vaults));
  renderSavedVaults();
}

function toggleSavedVaults() {
  const dd = document.getElementById('saved-vaults-dropdown');
  dd.classList.toggle('visible');
  if (dd.classList.contains('visible')) renderSavedVaults();
}

function renderSavedVaults() {
  const dd = document.getElementById('saved-vaults-dropdown');
  const vaults = getSavedVaults();
  if (vaults.length === 0) {
    dd.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:24px;">No saved vaults yet.</div>';
    return;
  }
  dd.innerHTML = '';
  for (const v of vaults) {
    const item = document.createElement('div');
    item.className = 'saved-vault-item';
    item.addEventListener('click', () => loadVault(v.address));

    const label = document.createElement('span');
    label.className = 'vault-label';
    label.textContent = v.name || `${v.address.slice(0,6)}\u2026${v.address.slice(-4)}`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-vault';
    removeBtn.type = 'button';
    removeBtn.innerHTML = '&times;';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      removeVault(v.address);
    });

    item.appendChild(label);
    item.appendChild(removeBtn);
    dd.appendChild(item);
  }
}

function loadVault(address) {
  vaultInput.value = address;
  document.getElementById('saved-vaults-dropdown').classList.remove('visible');
  // Let validateVault() discover the correct chain via the backend
  window.validateVault();
}

/* ================================================================
   Restore last-used vault on page load
   ================================================================ */
function restoreLastVault() {
  // Restore network mode FIRST
  const testnetOn = localStorage.getItem('rigoblock_testnet') === 'true';
  document.getElementById('testnet-toggle').checked = testnetOn;
  applyTestnetState(testnetOn);
  if (testnetOn) setCurrentChainId(11155111);

  const vaults = getSavedVaults();
  if (vaults.length > 0) {
    vaultInput.value = vaults[0].address;
    // Don't restore cached chainId -- validateVault() will discover it
    updateChainDisplay();
    const status = document.getElementById('vault-status');
    status.className = 'vault-info-badge';
    status.textContent = vaults[0].name || 'last used';
  } else {
    updateChainDisplay();
  }
}

/* ================================================================
   Strategy Event Polling -- shows notifications for cron-triggered actions
   ================================================================ */
function startStrategyPoller() {
  stopStrategyPoller();
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) return;
  setLastEventTimestamp(Date.now()); // only show events after page load
  setStrategyPollTimer(setInterval(() => pollStrategyEvents(vault), 30000));
}

function stopStrategyPoller() {
  if (strategyPollTimer) { clearInterval(strategyPollTimer); setStrategyPollTimer(null); }
}

async function pollStrategyEvents(vault) {
  try {
    const res = await fetch(`/api/strategy-events?vault=${vault}&since=${lastEventTimestamp}`);
    if (!res.ok) return;
    const { events } = await res.json();
    if (!events || events.length === 0) return;
    for (const ev of events) {
      if (ev.timestamp > lastEventTimestamp) setLastEventTimestamp(ev.timestamp);
      if (ev.type === 'twap') {
        const twapIcon = ev.success ? '\u26A1' : '\u26A0\uFE0F';
        appendMessage('system', `${twapIcon} TWAP #${ev.twapOrderId}: ${ev.summary}`);
        continue;
      }
      const icon = ev.success ? (ev.autoExecute ? '\u26A1' : '\uD83D\uDD14') : '\u26A0\uFE0F';
      const label = ev.autoExecute ? 'Auto-executed' : 'Recommendation';
      appendMessage('system', `${icon} Strategy #${ev.strategyId} -- ${label}: ${ev.summary}`);
    }
  } catch { /* network error -- silent */ }
}

// Close saved vaults dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('saved-vaults-dropdown');
  if (!e.target.closest('.saved-vaults-btn') && !e.target.closest('#saved-vaults-dropdown')) {
    dd.classList.remove('visible');
  }
});

/* ================================================================
   Vault validation
   ================================================================ */
let validateTimer = null;
let validateInProgress = false;

vaultInput.addEventListener('input', () => {
  clearTimeout(validateTimer);
  const v = vaultInput.value.trim();
  if (v.length === 42 && v.startsWith('0x')) {
    // Clear stale delegation state immediately so the UI doesn't show the
    // previous vault's delegation while the async validateVault fetch is in flight.
    setDelegationState(null);
    setExecutionMode('manual');
    window.updateDelegationUI(null);
    validateTimer = setTimeout(window.validateVault, 600);
  } else {
    document.getElementById('vault-status').textContent = '';
  }
});

async function validateVault() {
  const addr = vaultInput.value.trim();
  const chainId = currentChainId;
  const status = document.getElementById('vault-status');
  if (!addr || addr.length !== 42) { status.textContent = ''; return; }
  if (validateInProgress) return;
  validateInProgress = true;

  status.className = 'vault-info-badge';
  status.textContent = 'checking\u2026';

  let valid = false;
  let foundChainId = chainId;
  let name = '';

  try {
    // Backend tries selected chain first, then all others
    const res = await fetch(`/api/vault?address=${addr}&chain=${chainId}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Not a vault');

    name = data.name || '';
    foundChainId = data.chainId || chainId;

    // Auto-switch chain within the same network mode (e.g. Ethereum -> Base).
    // NEVER auto-switch between mainnet and testnet -- respect the user's toggle.
    if (foundChainId !== chainId) {
      const isTestnet = TESTNET_CHAINS_LIST.some(c => c.id === foundChainId);
      const currentlyTestnet = document.getElementById('testnet-toggle').checked;
      if (isTestnet !== currentlyTestnet) {
        // Vault found on other network mode -- inform but don't switch
        const modeLabel = isTestnet ? 'testnet' : 'mainnet';
        status.className = 'vault-info-badge';
        status.textContent = `${name || 'valid'} -- on ${CHAIN_NAMES[foundChainId] || 'chain ' + foundChainId} (${modeLabel})`;
        saveVault(addr, foundChainId, name);
        validateInProgress = false;
        return;
      }
      // Same network mode -- safe to auto-switch chain
      setCurrentChainId(foundChainId);
      window.updateChainDisplay();
    }

    const chainLabel = foundChainId !== chainId
      ? ` on ${CHAIN_NAMES[foundChainId] || 'chain ' + foundChainId}` : '';
    status.className = 'vault-info-badge';
    status.textContent = (name || 'valid') + chainLabel;

    // Check ownership if wallet connected
    if (connectedAddress && data.owner) {
      const owner = data.owner.toLowerCase();
      if (owner !== connectedAddress.toLowerCase()) {
        status.className = 'vault-info-badge error';
        status.textContent = name || 'valid';
      } else {
        status.className = 'vault-info-badge';
        status.textContent = (name || 'valid') + ' (owned)';
      }
    }

    saveVault(addr, foundChainId, name);
    valid = true;
  } catch {
    status.className = 'vault-info-badge error';
    status.textContent = 'not a vault on any chain';
  }

  // Post-validation work: delegation refresh, strategy polling, trade settings.
  // These are best-effort and must NOT overwrite a successful vault status.
  if (valid) {
    try {
      window.refreshDelegationStatus();
    } catch { /* ignore */ }
    try {
      startStrategyPoller();
    } catch { /* ignore */ }
    try {
      window.restoreTradeSettings();
    } catch { /* ignore */ }
  }

  if (afterValidateVault) {
    try { await afterValidateVault(); } catch { /* ignore */ }
  }
  validateInProgress = false;
}

/* ================================================================
   Pool Onboarding -- show/hide based on vault input
   ================================================================ */
function updateOnboardingVisibility() {
  const onboarding = document.getElementById('pool-onboarding');
  const vault = vaultInput.value.trim();
  if (!vault || vault.length < 42) {
    onboarding.style.display = '';
  } else {
    onboarding.style.display = 'none';
  }
}

// Listen on vault input changes
vaultInput.addEventListener('input', updateOnboardingVisibility);

export {
  VAULT_STORAGE_KEY,
  getSavedVaults, saveVault, removeVault,
  toggleSavedVaults, renderSavedVaults, loadVault,
  startStrategyPoller, stopStrategyPoller, pollStrategyEvents,
  validateVault, updateOnboardingVisibility, restoreLastVault,
};
