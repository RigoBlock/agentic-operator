/**
 * Main entry point — imports all modules, wires event listeners,
 * and attaches cross-module functions to window for backward compatibility.
 */

import './state.js';
import './api.js';

import {
  chatEl, inputEl, sendBtn, vaultInput,
  setCurrentChainId,
  setConnectedAddress, setAuthSignature, setAuthTimestamp,
  setProviderListenersAttached,
  setExecutionMode, setDelegationState,
  currentChainId,
  connectedAddress,
} from './state.js';

import {
  appendMessage, renderRichContent, makeReasoningBlock,
  linkifyMarkdownInCell, linkifyUrls,
} from './chat-ui.js';

import {
  sendMessage, handleChatResponse, autoProgressAfterTx,
} from './chat-stream.js';

import {
  parseDirectToolCall, invokeDirectTool,
} from './chat-ui.js';

import {
  showTransactionModal, confirmTransaction,
} from './tx-modal.js';

import {
  showTxReceiptCard, pollPendingTx,
  showManualTxCard, signManualTxCard, pollManualTxReceipt,
} from './tx-receipt.js';

import {
  showDelegatedConfirmation, confirmDelegatedExecution,
  rejectDelegatedExecution,
  showMultiDelegatedConfirmation, confirmMultiDelegatedExecution,
} from './tx-delegated.js';

import {
  renderWalletList, openWalletPicker,
  connectWithProvider, attachProviderListeners,
  restoreCachedAuth, signAuthMessage,
  authKey, disconnectWallet, closeModal,
} from './wallet.js';

import {
  slippageKey, slippageOverrideKey, shieldKey, shieldToleranceKey,
  getSlippageBps, onSlippageChange, onSwapShieldToleranceChange,
  resetSwapShieldTolerance, startShieldTimer, restoreTradeSettings,
  toggleTestnet, applyTestnetState, updateChainDisplay,
  loadAiSettings, saveAiSettings, openSettings, toggleAiSettings,
  onAiProviderChange, getAiRequestParams,
} from './settings.js';

import {
  getSavedVaults, saveVault, removeVault, toggleSavedVaults,
  renderSavedVaults, loadVault, startStrategyPoller,
  stopStrategyPoller, validateVault, updateOnboardingVisibility,
} from './vault.js';

import {
  syncExecutionMode, fetchAllDelegationStatuses,
  refreshDelegationStatus, updateDelegationHint, updateDelegationUI,
  toggleSponsoredGas, toggleExecMode, loadExecMode,
} from './delegation-status.js';

import {
  openDelegationSetup, startDelegationSetup,
} from './delegation-setup.js';

import {
  openRevokeModal, executeRevoke, revokeDelegation,
} from './delegation-revoke.js';

import {
  openTelegramPairing, resetTelegramPairing, generateTelegramCode,
} from './telegram.js';

import {
  openDeployPoolModal, encodeCreatePoolArgs, deploySmartPool,
} from './pool-deploy.js';

// ── Attach cross-module functions to window for backward compat ───────
// Modules still reference each other via global names; main.js bridges them.

// Chat & TX
window.appendMessage = appendMessage;
window.sendMessage = sendMessage;
window.handleChatResponse = handleChatResponse;
window.autoProgressAfterTx = autoProgressAfterTx;
window.showTransactionModal = showTransactionModal;
window.showDelegatedConfirmation = showDelegatedConfirmation;
window.showMultiDelegatedConfirmation = showMultiDelegatedConfirmation;
window.showTxReceiptCard = showTxReceiptCard;
window.showManualTxCard = showManualTxCard;
window.pollPendingTx = pollPendingTx;

// Wallet
window.openWalletPicker = openWalletPicker;
window.renderWalletList = renderWalletList;
window.connectWithProvider = connectWithProvider;
window.attachProviderListeners = attachProviderListeners;
window.restoreCachedAuth = restoreCachedAuth;
window.signAuthMessage = signAuthMessage;
window.disconnectWallet = disconnectWallet;
window.closeModal = closeModal;

// Settings
window.openSettings = openSettings;
window.toggleAiSettings = toggleAiSettings;
window.onAiProviderChange = onAiProviderChange;
window.toggleTestnet = toggleTestnet;
window.onSlippageChange = onSlippageChange;
window.onSwapShieldToleranceChange = onSwapShieldToleranceChange;
window.resetSwapShieldTolerance = resetSwapShieldTolerance;
window.updateChainDisplay = updateChainDisplay;

// Vault
window.toggleSavedVaults = toggleSavedVaults;
window.loadVault = loadVault;
window.validateVault = validateVault;
window.updateOnboardingVisibility = updateOnboardingVisibility;

// Delegation
window.refreshDelegationStatus = refreshDelegationStatus;
window.updateDelegationUI = updateDelegationUI;
window.updateDelegationHint = updateDelegationHint;
window.syncExecutionMode = syncExecutionMode;
window.toggleSponsoredGas = toggleSponsoredGas;
window.toggleExecMode = toggleExecMode;
window.loadExecMode = loadExecMode;
window.openDelegationSetup = openDelegationSetup;
window.startDelegationSetup = startDelegationSetup;
window.openRevokeModal = openRevokeModal;
window.executeRevoke = executeRevoke;
window.revokeDelegation = revokeDelegation;

// Telegram
window.openTelegramPairing = openTelegramPairing;
window.resetTelegramPairing = resetTelegramPairing;
window.generateTelegramCode = generateTelegramCode;

// Pool deploy
window.openDeployPoolModal = openDeployPoolModal;
window.deploySmartPool = deploySmartPool;

// Direct tools
window.parseDirectToolCall = parseDirectToolCall;
window.invokeDirectTool = invokeDirectTool;

// ── Event Listeners ───────────────────────────────────────────────────

// Send button

// Input: auto-resize + Enter to send
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  // Command history (up/down arrow)
  const commandHistory = [];
  let historyIndex = -1;
  let historyDraft = '';
  if (e.key === 'ArrowUp' && inputEl.selectionStart === 0 && !e.shiftKey) {
    if (commandHistory.length === 0) return;
    e.preventDefault();
    if (historyIndex === -1) historyDraft = inputEl.value;
    historyIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    inputEl.value = commandHistory[commandHistory.length - 1 - historyIndex];
  }
  if (e.key === 'ArrowDown' && !e.shiftKey) {
    if (historyIndex === -1) return;
    e.preventDefault();
    historyIndex -= 1;
    inputEl.value = historyIndex === -1 ? historyDraft : commandHistory[commandHistory.length - 1 - historyIndex];
  }
});

// Vault input
vaultInput.addEventListener('input', () => {
  validateVault();
  updateOnboardingVisibility();
});

// Close saved vaults dropdown when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('saved-vaults-dropdown');
  if (!e.target.closest('.saved-vaults-btn') && !e.target.closest('#saved-vaults-dropdown')) {
    dd?.classList.remove('visible');
  }
});

// ── Initialization ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Restore persisted settings
  loadAiSettings();
  restoreTradeSettings();
  updateChainDisplay();

  // Auth
  restoreCachedAuth();

  // Vault / onboarding
  updateOnboardingVisibility();

  // Delegation
  loadExecMode();
  syncExecutionMode();

  // Chat history
  const didRestore = restoreChat();
  if (!didRestore) {
    // First-load greeting
    appendMessage('system', 'Connect your wallet, enter a vault address, and describe a swap.');
  }

  // Start strategy poller if vault is set
  const vault = vaultInput.value.trim();
  if (vault && vault.length === 42) {
    startStrategyPoller();
  }

  // EIP-6963 provider discovery is already wired in wallet.js module load
});
