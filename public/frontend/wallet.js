import {
  discoveredProviders, activeProvider, setActiveProvider,
  connectedAddress, setConnectedAddress,
  authSignature, setAuthSignature, authTimestamp, setAuthTimestamp,
  providerListenersAttached, setProviderListenersAttached,
  setExecutionMode, setDelegationState,
  vaultInput,
  CHAIN_NAMES, TESTNET_CHAINS_LIST,
  setPendingTx, setCurrentChainId,
} from './state.js';

/* ================================================================
   EIP-6963 Multi-Wallet Discovery
   ================================================================ */
window.addEventListener('eip6963:announceProvider', (event) => {
  const { info, provider } = event.detail;
  if (!discoveredProviders.some(p => p.info.rdns === info.rdns)) {
    discoveredProviders.push({ info, provider });
  }
  renderWalletList();
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function renderWalletList() {
  const list = document.getElementById('wallet-list');
  const divider = document.getElementById('wallet-divider');
  if (discoveredProviders.length === 0) {
    list.style.display = 'none';
    if (divider) divider.style.display = 'none';
    return;
  }
  list.style.display = '';
  if (divider) divider.style.display = '';
  list.innerHTML = '';
  for (const { info, provider } of discoveredProviders) {
    const el = document.createElement('div');
    el.className = 'wallet-option';

    // Only allow safe URL schemes for wallet icons — EIP-6963 provider
    // metadata is untrusted (comes from browser extensions), so a
    // `javascript:` or `data:text/html` icon src could execute arbitrary code.
    const iconSrc = String(info.icon ?? '');
    const safeIconSchemes = /^(https?:\/\/|data:image\/)/i;
    if (iconSrc && safeIconSchemes.test(iconSrc)) {
      const img = document.createElement('img');
      img.src = iconSrc;
      img.alt = String(info.name ?? '');
      img.onerror = function() { this.style.display = 'none'; };
      el.appendChild(img);
    }

    const infoDiv = document.createElement('div');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'wallet-name';
    nameDiv.textContent = String(info.name ?? '');
    const rdnsDiv = document.createElement('div');
    rdnsDiv.className = 'wallet-rdns';
    rdnsDiv.textContent = String(info.rdns ?? '');
    infoDiv.appendChild(nameDiv);
    infoDiv.appendChild(rdnsDiv);
    el.appendChild(infoDiv);

    el.addEventListener('click', () => connectWithProvider(provider, String(info.name ?? '')));
    list.appendChild(el);
  }
}

function openWalletPicker() {
  if (connectedAddress) { disconnectWallet(); return; }
  document.getElementById('wallet-modal').classList.add('visible');
}

async function connectWithProvider(provider, name) {
  closeModal('wallet-modal');
  try {
    setActiveProvider(provider);
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (accounts.length > 0) {
      setConnectedAddress(accounts[0]);
      document.getElementById('wallet-addr').textContent =
        connectedAddress.slice(0, 6) + '…' + connectedAddress.slice(-4);
      document.getElementById('connect-btn').textContent = 'Disconnect';
      document.getElementById('connect-btn').classList.add('active');
      appendMessage('system', `Connected via ${name}: ${connectedAddress}`);

      // Reload per-address trade settings now that connectedAddress is known
      window.restoreTradeSettings();

      // Remember provider for auto-reconnect on reload
      const rdns = discoveredProviders.find(p => p.provider === provider)?.info?.rdns || 'injected';
      localStorage.setItem('rigoblock_last_provider', rdns);

      // Sign auth message to prove wallet ownership
      await signAuthMessage();

      // Re-validate vault with ownership check
      if (vaultInput.value.trim().length === 42) await window.validateVault();

      attachProviderListeners(provider);
    }
  } catch (err) {
    appendMessage('system', `Wallet error: ${err.message}`);
  }
}

/**
 * Attach accountsChanged and chainChanged listeners.
 * Guarded to prevent duplicate registrations.
 */
function attachProviderListeners(provider) {
  if (!provider || !provider.on || providerListenersAttached) return;
  setProviderListenersAttached(true);

  provider.on('accountsChanged', (accts) => {
    if (accts.length === 0) { disconnectWallet(); return; }
    const newAddr = accts[0];
    // Some wallets fire accountsChanged spuriously on chain change — skip if address is same
    if (newAddr.toLowerCase() === connectedAddress?.toLowerCase()) return;
    setConnectedAddress(newAddr);
    document.getElementById('wallet-addr').textContent =
      connectedAddress.slice(0, 6) + '…' + connectedAddress.slice(-4);
    // Reload per-address trade settings for the new account
    window.restoreTradeSettings();
    // Try cached auth for the new address (no re-sign needed if still valid)
    if (restoreCachedAuth()) {
      appendMessage('system', `Account switched to ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)} ✓`);
    } else {
      setAuthSignature(null);
      setAuthTimestamp(null);
      // Only auto-prompt for signature if this tab is currently active.
      // accountsChanged fires from any tab — don't interrupt the user
      // when they switched accounts while looking at a different page.
      if (document.visibilityState === 'visible') {
        appendMessage('system', `Account switched. Signing authentication…`);
        signAuthMessage();
      } else {
        appendMessage('system', `Account switched to ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}. Sign in to authenticate.`);
      }
    }
    // validateVault() now handles delegation refresh (skips if non-owner)
    if (vaultInput.value.trim().length === 42) {
      window.validateVault();
    } else {
      window.refreshDelegationStatus();
    }
  });

  provider.on('chainChanged', (chainIdHex) => {
    const newChainId = parseInt(chainIdHex, 16);
    if (CHAIN_NAMES[newChainId]) {
      setCurrentChainId(newChainId);
      window.updateChainDisplay();
      // Update testnet toggle if needed
      const isTestnet = TESTNET_CHAINS_LIST.some(c => c.id === newChainId);
      const toggle = document.getElementById('testnet-toggle');
      if (toggle.checked !== isTestnet) {
        toggle.checked = isTestnet;
        window.applyTestnetState(isTestnet);
        localStorage.setItem('rigoblock_testnet', isTestnet);
      }
      window.refreshDelegationStatus();
    }
    // No re-auth needed — auth is chain-independent
  });
}

/**
 * Sign a human-readable auth message proving wallet ownership.
 * Wallet-wide — not tied to any specific vault or chain.
 */
const AUTH_STORAGE_PREFIX = 'rigoblock_auth_';
/** Version of the auth message format. Bump when the signed message format changes. */
const AUTH_MESSAGE_VERSION = 2; // v2 added the Timestamp line (prevents legacy cache replay)
/** Returns the per-address localStorage key for auth caching */
function authKey(addr) { return AUTH_STORAGE_PREFIX + (addr || '').toLowerCase(); }

/** Try to restore a cached auth signature from localStorage */
function restoreCachedAuth() {
  try {
    const cached = JSON.parse(localStorage.getItem(authKey(connectedAddress)) || 'null');
    if (!cached) return false;
    // Reject cached auth from the old (versionless) message format — the backend
    // no longer accepts signatures without a timestamp line.
    if (cached.version !== AUTH_MESSAGE_VERSION) return false;
    // Sanity-check address matches (key is address-scoped but double-check)
    if (cached.address?.toLowerCase() !== connectedAddress?.toLowerCase()) return false;
    if (Date.now() - cached.timestamp > 23 * 60 * 60 * 1000) return false; // 23h to add margin
    setAuthSignature(cached.signature);
    setAuthTimestamp(cached.timestamp);
    return true;
  } catch { return false; }
}

async function signAuthMessage() {
  if (!activeProvider || !connectedAddress) return null;
  // Try cached signature first
  if (restoreCachedAuth()) {
    appendMessage('system', 'Authenticated ✓ (cached)');
    return { signature: authSignature, timestamp: authTimestamp };
  }
  const ts = Date.now();
  // Must match backend buildAuthMessage(address, timestamp) exactly
  // Cached auth is version-gated: restoreCachedAuth() above rejects any
  // payload without version === AUTH_MESSAGE_VERSION (v2 = timestamp line).
  // If you change this message format, bump AUTH_MESSAGE_VERSION.
  const message = [
    'Welcome to Rigoblock Operator',
    '',
    'Sign this message to verify your wallet and access your smart pool assistant.',
    '',
    `Timestamp: ${ts}`,
  ].join('\n');
  try {
    const sig = await activeProvider.request({
      method: 'personal_sign',
      params: [toHex(message), connectedAddress],
    });
    setAuthSignature(sig);
    setAuthTimestamp(ts);
    // Cache in localStorage keyed by address — switching accounts never overwrites
    // another address's cached signature, so switching A→B→A doesn't require re-signing A.
    localStorage.setItem(authKey(connectedAddress), JSON.stringify({
      version: AUTH_MESSAGE_VERSION,
      address: connectedAddress,
      signature: sig,
      timestamp: ts,
    }));
    appendMessage('system', 'Authenticated ✓');
    return { signature: sig, timestamp: ts };
  } catch (err) {
    appendMessage('system', `Auth sign rejected: ${err.message || 'User rejected'}`);
    setAuthSignature(null);
    setAuthTimestamp(null);
    return null;
  }
}

/** Convert a string to 0x-prefixed hex (for personal_sign) */
function toHex(str) {
  return '0x' + Array.from(new TextEncoder().encode(str)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function disconnectWallet() {
  setConnectedAddress(null);
  setActiveProvider(null);
  setAuthSignature(null);
  setAuthTimestamp(null);
  setProviderListenersAttached(false);
  // Don't remove per-address auth entries on disconnect — they'll be reused on reconnect.
  // Only clear the in-memory state so the current session is de-authenticated.
  localStorage.removeItem('rigoblock_last_provider');
  document.getElementById('wallet-addr').textContent = '';
  document.getElementById('connect-btn').textContent = 'Connect Wallet';
  document.getElementById('connect-btn').classList.remove('active');
  // Clear delegation panel — no wallet means no delegation
  setDelegationState(null);
  setExecutionMode('manual');
  window.updateDelegationUI(null);
}

function closeModal(id) {
  document.getElementById(id).classList.remove('visible');
  if (id === 'tx-modal') setPendingTx(null);
}

// Legacy fallback after a brief delay + auto-reconnect
setTimeout(async () => {
  // Auth is handled via cached wallet signature headers (X-Auth-*) sent with every request.

  if (discoveredProviders.length === 0 && window.ethereum) {
    discoveredProviders.push({
      info: { name: 'Browser Wallet', rdns: 'injected', icon: '' },
      provider: window.ethereum,
    });
    renderWalletList();
  }

  // ── Auto-reconnect: silently restore previous session on page reload ──
  const savedRdns = localStorage.getItem('rigoblock_last_provider');
  if (savedRdns && !connectedAddress) {
    (async () => {
      try {
        // ── External wallet (MetaMask etc.) auto-reconnect ──
        const match = discoveredProviders.find(p => p.info.rdns === savedRdns);
        const provider = match ? match.provider : (savedRdns === 'injected' ? window.ethereum : null);
        if (!provider) return;
        const accounts = await provider.request({ method: 'eth_accounts' });
        if (accounts.length === 0) return;
        const addr = accounts[0];
        const savedAuth = localStorage.getItem(authKey(addr));
        if (!savedAuth) return;
        const cached = JSON.parse(savedAuth);
        if (!cached || cached.version !== AUTH_MESSAGE_VERSION) return;
        if (Date.now() - cached.timestamp > 23 * 60 * 60 * 1000) return;
        if (addr.toLowerCase() !== cached.address?.toLowerCase()) return;
        setActiveProvider(provider);
        setConnectedAddress(addr);
        setAuthSignature(cached.signature);
        setAuthTimestamp(cached.timestamp);
        document.getElementById('wallet-addr').textContent =
          connectedAddress.slice(0, 6) + '…' + connectedAddress.slice(-4);
        document.getElementById('connect-btn').textContent = 'Disconnect';
        document.getElementById('connect-btn').classList.add('active');
        appendMessage('system', `Reconnected: ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)} ✓`);
        if (vaultInput.value.trim().length === 42) {
          await window.validateVault();
        }
        // Always refresh delegation status after reconnect so executionMode is accurate
        await window.refreshDelegationStatus();
        attachProviderListeners(provider);
      } catch { /* silent — auto-reconnect is best-effort */ }
    })();
  }
}, 500);

export {
  renderWalletList,
  openWalletPicker,
  connectWithProvider,
  disconnectWallet,
  restoreCachedAuth,
  signAuthMessage,
  authKey,
  closeModal,
};
