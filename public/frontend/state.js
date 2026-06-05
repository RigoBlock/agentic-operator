/**
 * Global state, DOM references, constants, and shared helpers.
 * This is the single source of truth for all frontend modules.
 */

// ── DOM References ────────────────────────────────────────────────────
export const chatEl = document.getElementById('chat');
export const inputEl = document.getElementById('input');
export const sendBtn = document.getElementById('send');
export const sendIcon = document.getElementById('send-icon');
export const stopIcon = document.getElementById('stop-icon');
export const vaultInput = document.getElementById('vault-input');

// ── Mutable State ─────────────────────────────────────────────────────
export let activeAbortController = null;
export let currentChainId = 1;
export let conversationHistory = [];
export let pendingTx = null; // unsigned transaction awaiting signature
export const discoveredProviders = [];
export let activeProvider = null;
export let connectedAddress = null;
export let authSignature = null;  // EIP-191 sig proving wallet ownership
export let authTimestamp = null;  // timestamp used in signed message
export let providerListenersAttached = false; // prevent duplicate event listeners
export let strategyPollTimer = null; // strategy events polling interval
export let lastEventTimestamp = 0;  // last seen strategy event timestamp
export let multiStepActive = false; // true when agent response indicates a multi-step plan
export let executionMode = 'manual'; // 'manual' | 'delegated'
export let delegationState = null;   // cached delegation status from backend

// Command history for up/down arrow navigation in chat input
export const commandHistory = [];
export let historyIndex = -1;
export let historyDraft = '';
export function setHistoryIndex(v) { historyIndex = v; }
export function setHistoryDraft(v) { historyDraft = v; }

// Hook for delegation modules to run after vault validation
export let afterValidateVault = null;
export function setAfterValidateVault(fn) { afterValidateVault = fn; }

// Setters for mutable state (modules must use these to update shared state)
export function setActiveAbortController(v) { activeAbortController = v; }
export function setCurrentChainId(v) { currentChainId = v; }
export function setConversationHistory(v) { conversationHistory = v; }
export function setPendingTx(v) { pendingTx = v; }
export function setActiveProvider(v) { activeProvider = v; }
export function setConnectedAddress(v) { connectedAddress = v; }
export function setAuthSignature(v) { authSignature = v; }
export function setAuthTimestamp(v) { authTimestamp = v; }
export function setProviderListenersAttached(v) { providerListenersAttached = v; }
export function setStrategyPollTimer(v) { strategyPollTimer = v; }
export function setLastEventTimestamp(v) { lastEventTimestamp = v; }
export function setMultiStepActive(v) { multiStepActive = v; }
export function setExecutionMode(v) { executionMode = v; }
export function setDelegationState(v) { delegationState = v; }

// ── Constants ─────────────────────────────────────────────────────────
export const CHAIN_NAMES = {
  1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism',
  137: 'Polygon', 56: 'BNB Chain', 130: 'Unichain', 11155111: 'Sepolia',
};

export const MAINNET_CHAINS_LIST = [
  { id: 1, name: 'Ethereum' },
  { id: 8453, name: 'Base' },
  { id: 42161, name: 'Arbitrum' },
  { id: 10, name: 'Optimism' },
  { id: 137, name: 'Polygon' },
  { id: 56, name: 'BNB Chain' },
  { id: 130, name: 'Unichain' },
];

export const TESTNET_CHAINS_LIST = [
  { id: 11155111, name: 'Sepolia' },
];

// ── Helpers ───────────────────────────────────────────────────────────

export function enterStoppingMode(controller, onStop) {
  activeAbortController = controller;
  sendBtn.disabled = false;
  sendBtn.classList.add('stopping');
  sendBtn.title = 'Stop';
  sendBtn.onclick = onStop || (() => controller.abort());
  sendIcon.style.display = 'none';
  stopIcon.style.display = '';
}

export function exitStoppingMode() {
  activeAbortController = null;
  sendBtn.disabled = false;
  sendBtn.classList.remove('stopping');
  sendBtn.title = 'Send';
  sendBtn.onclick = window.sendMessage || null;
  sendIcon.style.display = '';
  stopIcon.style.display = 'none';
}

// ── Chat persistence (sessionStorage — survives refresh, clears on tab close) ──
const CHAT_STORAGE_KEY = 'rigoblock_chat_history';
const GMX_CACHE_KEY = 'rigoblock_last_gmx_positions';

export function setLastGmxPositions(positions) {
  try {
    sessionStorage.setItem(GMX_CACHE_KEY, JSON.stringify(positions));
  } catch { /* quota exceeded — ignore */ }
}

export function getLastGmxPositions() {
  try {
    return JSON.parse(sessionStorage.getItem(GMX_CACHE_KEY) || '[]');
  } catch { return []; }
}

export function persistChat() {
  try {
    const vault = vaultInput.value.trim();
    if (!vault) return;
    const deduped = [];
    for (const msg of conversationHistory) {
      const last = deduped[deduped.length - 1];
      if (!last || last.role !== msg.role || last.content !== msg.content) {
        deduped.push(msg);
      }
    }
    conversationHistory = deduped;
    sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
      vault, chainId: currentChainId, messages: conversationHistory.slice(-40),
    }));
  } catch { /* quota exceeded — ignore */ }
}

export function restoreChat() {
  try {
    const raw = sessionStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    const vault = vaultInput.value.trim();
    if (saved.vault?.toLowerCase() !== vault?.toLowerCase()) return false;
    conversationHistory = saved.messages || [];
    if (conversationHistory.length === 0) return false;
    const onboarding = document.getElementById('pool-onboarding');
    chatEl.innerHTML = '';
    if (onboarding) chatEl.appendChild(onboarding);
    const rendered = new Set();
    const cachedPositions = getLastGmxPositions();
    for (const msg of conversationHistory) {
      const key = `${msg.role}:${msg.content}`;
      if (rendered.has(key)) continue;
      rendered.add(key);
      const isGmxPositions = msg.role === 'assistant' && msg.content.includes('📊 GMX Positions');
      const extras = isGmxPositions && cachedPositions.length > 0
        ? { gmxPositions: cachedPositions }
        : null;
      window.appendMessage(msg.role, msg.content, extras, true);
    }
    return true;
  } catch { return false; }
}

export function apiHeaders(extra) {
  const headers = { 'Content-Type': 'application/json' };
  if (connectedAddress) headers['X-Operator-Address'] = connectedAddress;
  if (authSignature) {
    headers['X-Auth-Signature'] = authSignature;
    headers['X-Auth-Timestamp'] = String(authTimestamp);
  }
  return Object.assign(headers, extra);
}

export function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showCopyToast('Copied!');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showCopyToast('Copied!');
  }
}

function showCopyToast(msg) {
  const existing = document.querySelector('.copy-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'copy-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

export function getExplorerUrl(chainId, txHash) {
  const explorers = {
    1: 'https://etherscan.io/tx/',
    8453: 'https://basescan.org/tx/',
    42161: 'https://arbiscan.io/tx/',
    10: 'https://optimistic.etherscan.io/tx/',
    137: 'https://polygonscan.com/tx/',
    56: 'https://bscscan.com/tx/',
    130: 'https://uniscan.xyz/tx/',
    11155111: 'https://sepolia.etherscan.io/tx/',
  };
  return (explorers[chainId] || 'https://etherscan.io/tx/') + txHash;
}
