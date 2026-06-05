import {
  connectedAddress, vaultInput, escapeHtml, apiHeaders,
  currentChainId, authSignature, authTimestamp,
} from './state.js';

function openTelegramPairing() {
  if (!connectedAddress) {
    window.appendMessage('system', 'Connect your wallet first.');
    window.openWalletPicker();
    return;
  }
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) {
    window.appendMessage('system', 'Enter a vault address first.');
    return;
  }
  // Reset modal state
  document.getElementById('telegram-pair-code').style.display = 'none';
  document.getElementById('telegram-bot-link').style.display = 'none';
  document.getElementById('telegram-pair-status').textContent = '';
  document.getElementById('telegram-generate-btn').disabled = false;
  document.getElementById('telegram-generate-btn').textContent = 'Generate Code';
  document.getElementById('telegram-modal').classList.add('visible');
}

async function resetTelegramPairing() {
  if (!connectedAddress) {
    window.appendMessage('system', 'Connect your wallet first.');
    return;
  }
  const vault = vaultInput.value.trim();
  if (!vault || vault.length !== 42) {
    window.appendMessage('system', 'Enter a vault address first.');
    return;
  }
  if (!confirm('Reset Telegram pairing? This will disconnect Telegram and clear conversation history.')) return;
  try {
    const authResult = await window.signAuthMessage();
    if (!authResult) { window.appendMessage('system', 'Authentication required to reset Telegram.'); return; }
    const res = await fetch('/api/delegation/telegram-reset', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        operatorAddress: connectedAddress,
        vaultAddress: vault,
        authSignature: authResult.signature,
        authTimestamp: authResult.timestamp,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    window.appendMessage('system', data.message || 'Telegram pairing reset.');
  } catch (err) {
    window.appendMessage('system', 'Reset failed: ' + err.message);
  }
}

async function generateTelegramCode() {
  const vault = vaultInput.value.trim();
  const statusEl = document.getElementById('telegram-pair-status');
  const codeEl = document.getElementById('telegram-pair-code');
  const codeValEl = document.getElementById('telegram-code-value');
  const botLinkEl = document.getElementById('telegram-bot-link');
  const genBtn = document.getElementById('telegram-generate-btn');

  genBtn.disabled = true;
  genBtn.textContent = 'Generating…';
  statusEl.textContent = '';

  // Get vault name from the UI
  const vaultNameEl = document.getElementById('vault-name');
  const vaultName = vaultNameEl ? vaultNameEl.textContent.trim() : vault.slice(0, 10);

  try {
    const res = await fetch('/api/telegram/pair', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        operatorAddress: connectedAddress,
        vaultAddress: vault,
        vaultName,
        chainId: currentChainId,
        authSignature,
        authTimestamp,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();

    // Display the code
    codeValEl.textContent = data.code;
    codeEl.style.display = '';
    genBtn.textContent = 'Regenerate';
    genBtn.disabled = false;

    // Build deep link — clicking opens the bot and auto-pairs
    const botUrl = document.getElementById('telegram-bot-url');
    botUrl.href = `https://t.me/RigoVibeBot?start=${data.code}`;
    botLinkEl.style.display = '';
    statusEl.innerHTML = '<span style="color: var(--success);">Code generated! Click the button to open Telegram and pair automatically.</span>';
  } catch (err) {
    // Use textContent to avoid injecting error message markup into the DOM.
    statusEl.textContent = `Error: ${err.message || err}`;
    statusEl.style.color = 'var(--error)';
    genBtn.textContent = 'Retry';
    genBtn.disabled = false;
  }
}

export { openTelegramPairing, resetTelegramPairing, generateTelegramCode };
