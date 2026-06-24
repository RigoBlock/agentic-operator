import {
  connectedAddress,
  currentChainId, setCurrentChainId,
  vaultInput,
  CHAIN_NAMES,
  authSignature, authTimestamp,
  apiHeaders,
} from './state.js';

import { appendMessage } from './chat-ui.js';

// AI model configuration (persisted in localStorage)
const AI_SETTINGS_KEY = 'rigoblock_ai_settings';
let aiSettings = loadAiSettings();

const AI_MODELS = {
  openrouter: [
    { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4 (best reasoning)' },
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (recommended)' },
    { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
    { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ],
  anthropic: [
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4 (best reasoning)' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  ],
  openai: [
    { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
  ],
};

const AI_BASE_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openai: undefined, // default OpenAI
};

function loadAiSettings() {
  try {
    const stored = localStorage.getItem(AI_SETTINGS_KEY);
    const parsed = stored ? JSON.parse(stored) : { provider: 'server', apiKey: '', model: '' };
    return parsed;
  } catch { return { provider: 'server', apiKey: '', model: '' }; }
}
function saveAiSettings() {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
}
function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.toggle('visible');
}
function toggleAiSettings() { openSettings(); }
function onAiProviderChange() {
  const provider = document.getElementById('ai-provider').value;
  aiSettings.provider = provider;
  const showCustom = provider !== 'server';
  // Routing mode removed -- Kimi K2.7 Code is the fixed default
  document.getElementById('ai-key-row').style.display = showCustom ? '' : 'none';
  document.getElementById('ai-model-row').style.display = showCustom ? '' : 'none';
  if (showCustom) {
    const modelSelect = document.getElementById('ai-model');
    modelSelect.innerHTML = '';
    const models = AI_MODELS[provider] || [];
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id; opt.textContent = m.name;
      modelSelect.appendChild(opt);
    });
    if (aiSettings.model && models.some(m => m.id === aiSettings.model)) {
      modelSelect.value = aiSettings.model;
    } else {
      aiSettings.model = models[0]?.id || '';
      modelSelect.value = aiSettings.model;
    }
    document.getElementById('ai-api-key').value = aiSettings.apiKey || '';
    document.getElementById('ai-status').textContent = 'Your API key is sent per-request and never stored on our servers.';
  } else {
    aiSettings.apiKey = '';
    aiSettings.model = '';
    document.getElementById('ai-status').textContent = 'Using Workers AI Kimi K2.7 Code -- native reasoning + tool calling. No API key needed.';
  }
  saveAiSettings();
}
// Restore AI settings on load
const sel = document.getElementById('ai-provider');
if (sel) { sel.value = aiSettings.provider; onAiProviderChange(); }
const keyInput = document.getElementById('ai-api-key');
if (keyInput) {
  keyInput.value = aiSettings.apiKey || '';
  keyInput.addEventListener('change', () => { aiSettings.apiKey = keyInput.value; saveAiSettings(); });
}
const modelSel = document.getElementById('ai-model');
if (modelSel) {
  modelSel.addEventListener('change', () => { aiSettings.model = modelSel.value; saveAiSettings(); });
}
// Routing mode removed -- Kimi K2.7 Code is the fixed default

function getAiRequestParams() {
  if (aiSettings.provider === 'server') {
    return {};
  }
  if (!aiSettings.apiKey) return {};
  return {
    aiApiKey: aiSettings.apiKey,
    aiModel: aiSettings.model,
    aiBaseUrl: AI_BASE_URLS[aiSettings.provider],
  };
}

/* ================================================================
   Trading Settings (slippage, swap shield)
   ================================================================ */
// Raw base key strings -- used ONLY via the namespaced helper functions below.
// Never pass these directly to localStorage; always call slippageKey() / shieldKey() etc.
// which append the connected wallet address so settings never bleed across accounts.
const SLIPPAGE_STORAGE_KEY = 'rigoblock_slippage_bps';
const SLIPPAGE_OVERRIDE_STORAGE_KEY = 'rigoblock_slippage_override_explicit';
const SHIELD_STORAGE_KEY = 'rigoblock_swap_shield';
const SHIELD_TOLERANCE_KEY = 'rigoblock_swap_shield_tolerance';
const NAV_SHIELD_STORAGE_KEY = 'rigoblock_nav_shield_pct';
const DEFAULT_SLIPPAGE_BPS = 100;
const MIN_SLIPPAGE_BPS = 10;
const MAX_SLIPPAGE_BPS = 500;
const DEFAULT_NAV_SHIELD_PCT = 10;
const MIN_NAV_SHIELD_PCT = 1;
const MAX_NAV_SHIELD_PCT = 100;

// Key helpers -- namespaced per connected address so switching wallets
// never shows a stale override that belongs to a different operator.
function slippageKey() { return SLIPPAGE_STORAGE_KEY + '_' + (connectedAddress || 'anon').toLowerCase(); }
function slippageOverrideKey() { return SLIPPAGE_OVERRIDE_STORAGE_KEY + '_' + (connectedAddress || 'anon').toLowerCase(); }
function shieldKey() { return SHIELD_STORAGE_KEY + '_' + (connectedAddress || 'anon').toLowerCase(); }
function shieldToleranceKey() { return SHIELD_TOLERANCE_KEY + '_' + (connectedAddress || 'anon').toLowerCase(); }
function navShieldKey() { return NAV_SHIELD_STORAGE_KEY + '_' + (connectedAddress || 'anon').toLowerCase(); }

function getSlippageBps() {
  const stored = localStorage.getItem(slippageKey());
  if (!stored) return DEFAULT_SLIPPAGE_BPS;
  const parsed = parseInt(stored, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_SLIPPAGE_BPS || parsed > MAX_SLIPPAGE_BPS) {
    return DEFAULT_SLIPPAGE_BPS;
  }
  return parsed;
}

function onSlippageChange() {
  const input = document.getElementById('slippage-input');
  const pct = parseFloat(input.value);
  if (isNaN(pct) || pct < 0.1 || pct > 5) {
    alert('Slippage must be between 0.1% and 5%.');
    const storedBps = localStorage.getItem(slippageKey());
    const parsedBps = storedBps ? parseInt(storedBps, 10) : NaN;
    if (Number.isFinite(parsedBps) && parsedBps >= MIN_SLIPPAGE_BPS && parsedBps <= MAX_SLIPPAGE_BPS) {
      // Restore to the last valid user-set value and re-affirm both storage entries
      input.value = (parsedBps / 100).toString();
      localStorage.setItem(slippageKey(), String(parsedBps));
      localStorage.setItem(slippageOverrideKey(), 'true');
    } else {
      // No valid prior setting: revert to default and clear both storage entries
      input.value = (DEFAULT_SLIPPAGE_BPS / 100).toString();
      localStorage.removeItem(slippageKey());
      localStorage.removeItem(slippageOverrideKey());
    }
    return;
  }
  const bps = Math.round(pct * 100);
  localStorage.setItem(slippageKey(), String(bps));
  localStorage.setItem(slippageOverrideKey(), 'true');
}

async function onSwapShieldToleranceChange() {
  const input = document.getElementById('swap-shield-tolerance');
  const pct = parseFloat(input.value);
  if (isNaN(pct) || pct < 0.5 || pct > 50) {
    alert('Swap Shield tolerance must be between 0.5% and 50%.');
    const stored = localStorage.getItem(shieldToleranceKey());
    const expiry = localStorage.getItem(shieldKey());
    const hasActive = stored && expiry && parseInt(expiry, 10) > Date.now();
    if (hasActive) {
      // Restore to the last persisted active tolerance so UI matches KV state
      input.value = stored;
    } else {
      // No active override: show the default and ensure stale KV keys are cleared
      input.value = '5';
      localStorage.removeItem(shieldToleranceKey());
      localStorage.removeItem(shieldKey());
    }
    return;
  }

  // Require wallet + vault to change tolerance server-side
  if (!connectedAddress || !vaultInput.value.trim()) {
    // Revert input to the last persisted value so UI stays consistent with server state
    const stored = localStorage.getItem(shieldToleranceKey());
    const expiry = localStorage.getItem(shieldKey());
    input.value = (stored && expiry && parseInt(expiry, 10) > Date.now()) ? stored : '5';
    appendMessage('system', 'Connect a wallet and enter a vault address before changing Swap Shield tolerance.');
    return;
  }

  input.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        messages: [{ role: 'user', content: `set swap shield tolerance to ${pct}%` }],
        vaultAddress: vaultInput.value.trim(),
        chainId: currentChainId,
        operatorAddress: connectedAddress,
        authSignature, authTimestamp,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const expiry = Date.now() + 600000;
    localStorage.setItem(shieldKey(), String(expiry));
    localStorage.setItem(shieldToleranceKey(), String(pct));
    document.getElementById('swap-shield-reset').style.display = 'inline-block';
    startShieldTimer(expiry);
  } catch (err) {
    appendMessage('system', `Failed to set swap shield tolerance: ${err instanceof Error ? err.message : String(err)}`);
    // Revert UI to the last known persisted state so it stays consistent with server/KV
    const stored = localStorage.getItem(shieldToleranceKey());
    const expiry = localStorage.getItem(shieldKey());
    input.value = (stored && expiry && parseInt(expiry, 10) > Date.now()) ? stored : '5';
    if (!stored || !expiry || parseInt(expiry, 10) <= Date.now()) {
      document.getElementById('swap-shield-reset').style.display = 'none';
      if (shieldTimerInterval) { clearInterval(shieldTimerInterval); shieldTimerInterval = null; }
      document.getElementById('swap-shield-timer').style.display = 'none';
    }
  } finally {
    input.disabled = false;
  }
}

async function resetSwapShieldTolerance() {
  if (!connectedAddress || !vaultInput.value.trim()) {
    appendMessage('system', 'Connect a wallet and enter a vault address before resetting Swap Shield tolerance.');
    return;
  }

  const input = document.getElementById('swap-shield-tolerance');
  input.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        messages: [{ role: 'user', content: '__enable_swap_shield__' }],
        vaultAddress: vaultInput.value.trim(),
        chainId: currentChainId,
        operatorAddress: connectedAddress,
        authSignature, authTimestamp,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    input.value = '5';
    localStorage.removeItem(shieldKey());
    localStorage.removeItem(shieldToleranceKey());
    document.getElementById('swap-shield-reset').style.display = 'none';
    if (shieldTimerInterval) { clearInterval(shieldTimerInterval); shieldTimerInterval = null; }
    document.getElementById('swap-shield-timer').style.display = 'none';
  } catch (err) {
    appendMessage('system', `Failed to reset swap shield tolerance: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.disabled = false;
  }
}

function startShieldTimer(expiry) {
  const timer = document.getElementById('swap-shield-timer');
  timer.style.display = 'inline';
  const update = () => {
    const remaining = Math.max(0, expiry - Date.now());
    if (remaining <= 0) {
      timer.style.display = 'none';
      localStorage.removeItem(shieldKey());
      localStorage.removeItem(shieldToleranceKey());
      clearInterval(shieldTimerInterval);
      shieldTimerInterval = null;
      // Reset to default visually
      const input = document.getElementById('swap-shield-tolerance');
      input.value = '5';
      document.getElementById('swap-shield-reset').style.display = 'none';
      // Re-enable server-side
      if (connectedAddress && vaultInput.value.trim()) {
        fetch('/api/chat', {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify({
            messages: [{ role: 'user', content: '__enable_swap_shield__' }],
            vaultAddress: vaultInput.value.trim(),
            chainId: currentChainId,
            operatorAddress: connectedAddress,
            authSignature, authTimestamp,
          }),
        }).catch(() => {});
      }
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timer.textContent = `Resets in ${mins}:${secs.toString().padStart(2, '0')}`;
  };
  update();
  if (shieldTimerInterval) clearInterval(shieldTimerInterval);
  shieldTimerInterval = setInterval(update, 1000);
}
let shieldTimerInterval = null;

function getNavShieldPct() {
  const stored = localStorage.getItem(navShieldKey());
  if (!stored) return DEFAULT_NAV_SHIELD_PCT;
  const parsed = parseInt(stored, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_NAV_SHIELD_PCT || parsed > MAX_NAV_SHIELD_PCT) {
    return DEFAULT_NAV_SHIELD_PCT;
  }
  return parsed;
}

async function onNavShieldThresholdChange() {
  const input = document.getElementById('nav-shield-threshold');
  const pct = parseInt(input.value, 10);
  if (isNaN(pct) || pct < MIN_NAV_SHIELD_PCT || pct > MAX_NAV_SHIELD_PCT) {
    alert(`NAV Shield threshold must be between ${MIN_NAV_SHIELD_PCT}% and ${MAX_NAV_SHIELD_PCT}%.`);
    input.value = String(getNavShieldPct());
    return;
  }

  if (!connectedAddress || !vaultInput.value.trim()) {
    appendMessage('system', 'Connect a wallet and enter a vault address before changing NAV Shield threshold.');
    input.value = String(getNavShieldPct());
    return;
  }

  input.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        messages: [{ role: 'user', content: `set NAV shield threshold to ${pct}%` }],
        vaultAddress: vaultInput.value.trim(),
        chainId: currentChainId,
        operatorAddress: connectedAddress,
        authSignature, authTimestamp,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    localStorage.setItem(navShieldKey(), String(pct));
    document.getElementById('nav-shield-reset').style.display = 'inline-block';
    appendMessage('system', `NAV Shield threshold set to ${pct}%.`);
  } catch (err) {
    appendMessage('system', `Failed to set NAV shield threshold: ${err instanceof Error ? err.message : String(err)}`);
    input.value = String(getNavShieldPct());
  } finally {
    input.disabled = false;
  }
}

async function resetNavShieldThreshold() {
  if (!connectedAddress || !vaultInput.value.trim()) {
    appendMessage('system', 'Connect a wallet and enter a vault address before resetting NAV Shield threshold.');
    return;
  }

  const input = document.getElementById('nav-shield-threshold');
  input.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'reset NAV shield to default' }],
        vaultAddress: vaultInput.value.trim(),
        chainId: currentChainId,
        operatorAddress: connectedAddress,
        authSignature, authTimestamp,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    input.value = String(DEFAULT_NAV_SHIELD_PCT);
    localStorage.removeItem(navShieldKey());
    document.getElementById('nav-shield-reset').style.display = 'none';
    appendMessage('system', 'NAV Shield threshold reset to default (10%).');
  } catch (err) {
    appendMessage('system', `Failed to reset NAV shield threshold: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.disabled = false;
  }
}

function restoreTradeSettings() {
  // Restore slippage
  const bps = getSlippageBps();
  document.getElementById('slippage-input').value = (bps / 100).toString();

  // Restore swap shield tolerance
  const shieldExpiry = localStorage.getItem(shieldKey());
  const storedTolerance = localStorage.getItem(shieldToleranceKey());
  const toleranceInput = document.getElementById('swap-shield-tolerance');
  if (shieldTimerInterval) { clearInterval(shieldTimerInterval); shieldTimerInterval = null; }
  document.getElementById('swap-shield-timer').style.display = 'none';

  if (shieldExpiry) {
    const expiry = parseInt(shieldExpiry, 10);
    if (expiry > Date.now()) {
      toleranceInput.value = storedTolerance || '5';
      document.getElementById('swap-shield-reset').style.display = 'inline-block';
      startShieldTimer(expiry);
    } else {
      localStorage.removeItem(shieldKey());
      localStorage.removeItem(shieldToleranceKey());
      toleranceInput.value = '5';
      document.getElementById('swap-shield-reset').style.display = 'none';
    }
  } else {
    toleranceInput.value = '5';
    document.getElementById('swap-shield-reset').style.display = 'none';
  }

  // Restore NAV shield threshold
  const navPct = getNavShieldPct();
  document.getElementById('nav-shield-threshold').value = String(navPct);
  document.getElementById('nav-shield-reset').style.display = navPct !== DEFAULT_NAV_SHIELD_PCT ? 'inline-block' : 'none';
}

function toggleTestnet() {
  const on = document.getElementById('testnet-toggle').checked;
  localStorage.setItem('rigoblock_testnet', on);
  setCurrentChainId(on ? 11155111 : 1);
  window.updateChainDisplay();
  window.applyTestnetState(on);
  window.refreshDelegationStatus();
}

function applyTestnetState(on) {
  const label = document.getElementById('network-mode-label');
  if (label) {
    label.textContent = on ? 'Testnet' : 'Mainnet';
    label.style.color = on ? 'var(--warn)' : 'var(--success)';
  }
}

function updateChainDisplay() {
  const el = document.getElementById('chain-display');
  if (el) el.textContent = CHAIN_NAMES[currentChainId] || 'Chain ' + currentChainId;
}

export {
  AI_SETTINGS_KEY, AI_MODELS, AI_BASE_URLS,
  SLIPPAGE_STORAGE_KEY, SLIPPAGE_OVERRIDE_STORAGE_KEY,
  SHIELD_STORAGE_KEY, SHIELD_TOLERANCE_KEY,
  NAV_SHIELD_STORAGE_KEY,
  DEFAULT_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS,
  DEFAULT_NAV_SHIELD_PCT, MIN_NAV_SHIELD_PCT, MAX_NAV_SHIELD_PCT,
  slippageKey, slippageOverrideKey, shieldKey, shieldToleranceKey, navShieldKey,
  getSlippageBps, onSlippageChange,
  onSwapShieldToleranceChange, resetSwapShieldTolerance,
  getNavShieldPct, onNavShieldThresholdChange, resetNavShieldThreshold,
  startShieldTimer, restoreTradeSettings,
  toggleTestnet, applyTestnetState, updateChainDisplay,
  loadAiSettings, saveAiSettings, openSettings, toggleAiSettings,
  onAiProviderChange, getAiRequestParams,
};
