/**
 * Payment UI — the ONE payment interaction in the app.
 *
 * The web chat is paid per call from the operator's USDC deposit (auto-pay).
 * When the deposit can no longer cover a call, this modal asks for a top-up:
 * the top-up transaction IS PREPARED — the operator just confirms it in their
 * wallet (we switch them to Base and back). If they funded the deposit from
 * another interface instead, "Check again" picks it up. Below 0.5 USDC a
 * non-blocking toast warns; the deposit remains usable until it runs out.
 */

import { activeProvider, connectedAddress, apiHeaders } from './state.js';
import { setTopUpHandler, refreshBillingCache, noteBalance } from './x402.js';

const BASE_CHAIN_ID = '0x2105'; // 8453
const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_ID,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};
const LOW_BALANCE_USDC = 0.5;
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 90_000;

let modalEl = null;

function closeModal() {
  if (modalEl) { modalEl.remove(); modalEl = null; }
}

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "2.000000" → "2"; "0.500000" → "0.5". */
function formatUSDC(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(parseFloat(n.toFixed(6)));
}

function provider() {
  return activeProvider?.provider;
}

async function currentChainId() {
  const id = await provider()?.request({ method: 'eth_chainId' }).catch(() => null);
  return id ? String(id).toLowerCase() : null;
}

/** Switch the wallet to Base, adding the network first if the wallet lacks it. */
async function switchToBase() {
  try {
    await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID }] });
    return;
  } catch (err) {
    // 4902 = chain not added yet
    if (err?.code !== 4902) throw new Error(`Please switch your wallet to Base: ${err?.message || err}`);
  }
  await provider().request({ method: 'wallet_addEthereumChain', params: [BASE_CHAIN_PARAMS] });
  await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID }] });
}

/** Best-effort switch back to the chain the wallet was on before the top-up. */
async function switchBack(chainId) {
  if (!chainId || chainId === BASE_CHAIN_ID) return;
  await provider()?.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }).catch(() => {});
}

/** Submit the prepared top-up transaction (wallet must be on Base). */
async function sendTopUpTx(topUp) {
  if (!provider() || !connectedAddress) throw new Error('Connect your wallet first.');
  await switchToBase();
  try {
    return await provider().request({
      method: 'eth_sendTransaction',
      params: [{ from: connectedAddress, to: topUp.to, data: topUp.data, value: '0x0' }],
    });
  } finally {
    // Fire-and-forget: return the wallet to its previous network.
    switchBack(startChainId);
  }
}

let startChainId = null;

async function fetchBillingStatus() {
  const res = await fetch('/api/billing/status', { headers: apiHeaders() });
  if (res.status === 401) throw new Error('Sign in with your operator wallet first.');
  if (!res.ok) throw new Error('Billing is temporarily unavailable — retry in a moment.');
  return res.json();
}

function showModal({ title, body, actions }) {
  closeModal();
  const overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;');
  const box = el('div', 'background:var(--bg,#14161b);color:var(--text,#e8eaed);border:1px solid var(--border,#2a2e37);border-radius:12px;padding:24px;max-width:480px;width:92%;font-size:15px;line-height:1.5;');
  box.appendChild(el('h3', 'margin:0 0 12px;font-size:18px;', title));
  if (body) box.appendChild(body);
  const row = el('div', 'display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;');
  for (const a of actions) {
    const btn = el('button',
      'padding:8px 14px;border-radius:8px;border:1px solid var(--border,#2a2e37);background:var(--accent,#4c8dff);color:#fff;cursor:pointer;font-size:14px;' + (a.secondary ? 'background:transparent;color:inherit;' : ''),
      a.label);
    btn.onclick = () => a.onClick();
    row.appendChild(btn);
  }
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  document.body.appendChild(overlay);
  modalEl = overlay;
  return box;
}

/**
 * The top-up modal — shown when a paid call finds the deposit empty or too
 * low. Resolves 'proceed' once the deposit can cover the call, 'abort' when
 * the operator cancels.
 */
async function showTopUpModal(resolve) {
  let status;
  try {
    status = await fetchBillingStatus();
  } catch (err) {
    showModal({
      title: 'Payment setup',
      body: el('div', '', err.message),
      actions: [{ label: 'Close', onClick: () => { closeModal(); resolve('abort'); } }],
    });
    return;
  }

  startChainId = await currentChainId();

  const body = el('div');
  body.appendChild(el('div', 'margin-bottom:10px;',
    'This service is paid per call in USDC on Base (x402) — chats, quotes, tools and pool deployment. ' +
    'Fund your personal deposit below: the top-up transaction is prepared for you — just confirm it in your wallet ' +
    '(we switch you to Base and back). Every call is then paid automatically, with no further prompts. ' +
    'Unused funds can be withdrawn anytime.'));

  const addrRow = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px;');
  const addr = el('code', 'word-break:break-all;font-size:12px;background:rgba(127,127,127,0.15);padding:6px;border-radius:6px;flex:1;', status.depositAddress);
  const copyBtn = el('button', 'padding:6px 10px;border-radius:6px;border:1px solid var(--border,#2a2e37);background:transparent;color:inherit;cursor:pointer;', 'Copy');
  copyBtn.onclick = () => { navigator.clipboard.writeText(status.depositAddress); copyBtn.textContent = 'Copied'; };
  addrRow.appendChild(addr);
  addrRow.appendChild(copyBtn);
  body.appendChild(addrRow);

  const balanceLine = el('div', 'margin-bottom:12px;color:var(--muted,#9aa0a6);',
    `Deposit balance: ${formatUSDC(status.balanceUSDC)} USDC on Base.`);
  body.appendChild(balanceLine);
  const warningLine = el('div', 'margin-bottom:12px;color:#e8a33d;display:none;');
  body.appendChild(warningLine);
  if (Number(status.balanceUSDC) > 0 && Number(status.balanceUSDC) < LOW_BALANCE_USDC) {
    warningLine.style.display = '';
    warningLine.textContent = 'Deposit is running low — top up when convenient.';
  }

  const note = el('div', 'margin-top:10px;font-size:13px;color:var(--muted,#9aa0a6);', '');
  body.appendChild(note);

  const refreshStatus = async () => {
    try {
      status = await fetchBillingStatus();
      noteBalance(status.balanceUSDC); // keep the client's cached balance fresh
      if (Number(status.balanceUSDC) >= ONBOARDING_CHAT_MAX_USDC) removeOnboardingBanner();
      balanceLine.textContent = `Deposit balance: ${formatUSDC(status.balanceUSDC)} USDC on Base.`;
      return status;
    } catch {
      return null;
    }
  };
  noteBalance(status.balanceUSDC);

  // Amount input + ONE Top up button. The transaction is prepared server-side
  // for the entered amount (decimal USDC) and submitted with the wallet.
  const inputRow = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:10px;');
  const amountInput = el('input', 'width:110px;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#2a2e37);background:transparent;color:inherit;font-size:14px;');
  amountInput.type = 'number';
  amountInput.min = '0.1';
  amountInput.step = 'any';
  amountInput.value = '2';
  inputRow.appendChild(amountInput);
  inputRow.appendChild(el('span', 'color:var(--muted,#9aa0a6);', 'USDC on Base'));
  body.appendChild(inputRow);

  const pollUntilFunded = () => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const timer = setInterval(async () => {
      const s = await refreshStatus();
      if (s && Number(s.balanceUSDC) > 0) {
        clearInterval(timer);
        closeModal();
        resolve('proceed');
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        note.textContent = 'Still waiting for confirmation — the chat will resume automatically once the transfer lands (or close and retry).';
      }
    }, POLL_INTERVAL_MS);
  };

  const actions = [
    {
      label: 'Top up',
      onClick: async () => {
        const amount = Number(amountInput.value);
        if (!Number.isFinite(amount) || amount <= 0) {
          note.textContent = 'Enter a valid amount (e.g. 2).';
          return;
        }
        note.textContent = 'Preparing the transaction…';
        try {
          const res = await fetch(`/api/billing/topup?amount=${encodeURIComponent(String(amount))}`, { headers: apiHeaders() });
          const topUp = await res.json();
          if (!res.ok) throw new Error(topUp.detail || topUp.error || 'Could not prepare the top-up.');
          note.textContent = 'Confirm the prepared USDC transfer in your wallet…';
          await sendTopUpTx(topUp);
          note.textContent = 'Top-up submitted — waiting for confirmation on Base…';
          pollUntilFunded();
        } catch (err) {
          note.textContent = `Top-up failed: ${err?.message || err}`;
        }
      },
    },
    {
      label: 'Check again',
      secondary: true,
      onClick: async () => {
        note.textContent = 'Checking the deposit…';
        const s = await refreshStatus();
        if (s && Number(s.balanceUSDC) > 0) {
          closeModal();
          resolve('proceed');
        } else {
          note.textContent = `No USDC received yet on Base at ${status.depositAddress}. Send USDC (Base) there, or use Top up above.`;
        }
      },
    },
    {
      label: 'Withdraw',
      secondary: true,
      onClick: async () => {
        note.textContent = 'Preparing the withdrawal…';
        try {
          const res = await fetch('/api/billing/withdraw', {
            method: 'POST',
            headers: apiHeaders(),
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || data.error || 'Could not prepare the withdrawal.');
          note.textContent = `Confirm the withdrawal of ${formatUSDC(data.amountUSDC)} USDC in your wallet — it returns to your address.`;
          await sendWalletTx(data);
          note.textContent = 'Withdrawal submitted — waiting for confirmation on Base…';
          const deadline = Date.now() + POLL_TIMEOUT_MS;
          const timer = setInterval(async () => {
            const s = await refreshStatus();
            if (s && Number(s.balanceUSDC) === 0) {
              clearInterval(timer);
              note.textContent = 'Withdrawal confirmed — deposit is empty.';
            } else if (Date.now() > deadline) {
              clearInterval(timer);
              note.textContent = 'Withdrawal pending — check your wallet for confirmation.';
            }
          }, POLL_INTERVAL_MS);
        } catch (err) {
          note.textContent = `Withdrawal failed: ${err?.message || err}`;
        }
      },
    },
    {
      label: 'Get USDC on Base ↗',
      secondary: true,
      onClick: () => window.open('https://www.coinbase.com/price/usdc', '_blank', 'noopener'),
    },
    {
      label: 'Cancel',
      secondary: true,
      onClick: () => { closeModal(); resolve('abort'); },
    },
  ];

  showModal({ title: 'Fund your payment deposit', body, actions });
}

setTopUpHandler(async () => new Promise(showTopUpModal));

// ── Non-blocking low-balance warning (fires from x402.js after paid calls) ──

window.addEventListener('rigoblock:low-balance', (e) => {
  const balance = formatUSDC(e.detail?.balanceUSDC ?? '0');
  const toast = el('div',
    'position:fixed;bottom:18px;right:18px;z-index:9999;background:var(--bg,#14161b);color:var(--text,#e8eaed);' +
    'border:1px solid #e8a33d;border-radius:10px;padding:12px 14px;font-size:13px;max-width:320px;display:flex;gap:10px;align-items:center;');
  toast.appendChild(el('span', '', `Deposit running low (${balance} USDC) — top up when convenient.`));
  const topUpBtn = el('button', 'padding:6px 10px;border-radius:6px;border:1px solid var(--border,#2a2e37);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;', 'Top up');
  topUpBtn.onclick = () => { toast.remove(); new Promise(showTopUpModal); };
  const dismiss = el('button', 'padding:6px 8px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:15px;', '×');
  dismiss.onclick = () => toast.remove();
  toast.appendChild(topUpBtn);
  toast.appendChild(dismiss);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 30_000);
});

// ── Startup onboarding: prove the payment setup before the user asks anything ──

const ONBOARDING_DISMISS_KEY = 'rigoblock_onboarding_dismissed_session';
const ONBOARDING_CHAT_MAX_USDC = 0.2;
let onboardingBanner = null;

function removeOnboardingBanner() {
  if (onboardingBanner) { onboardingBanner.remove(); onboardingBanner = null; }
}

function showOnboardingBanner(balance) {
  if (onboardingBanner || sessionStorage.getItem(ONBOARDING_DISMISS_KEY) === '1') return;
  onboardingBanner = el('div',
    'position:fixed;bottom:18px;left:18px;z-index:9998;background:var(--bg,#14161b);color:var(--text,#e8eaed);' +
    'border:1px solid var(--accent,#4c8dff);border-radius:10px;padding:14px 16px;max-width:420px;font-size:13px;line-height:1.45;');
  onboardingBanner.appendChild(el('div', 'font-weight:600;margin-bottom:6px;', 'Complete payment setup to use the chat'));
  onboardingBanner.appendChild(el('div', 'color:var(--muted,#9aa0a6);margin-bottom:10px;',
    `Your deposit has ${formatUSDC(balance)} USDC on Base. Fund it once; every call is then paid automatically (chat bills actual cost, up to $0.20).`));
  const row = el('div', 'display:flex;gap:10px;');
  const topUpBtn = el('button', 'padding:7px 12px;border-radius:7px;border:1px solid var(--border,#2a2e37);background:var(--accent,#4c8dff);color:#fff;cursor:pointer;', 'Top up');
  topUpBtn.onclick = () => {
    new Promise((resolve) => showTopUpModal((decision) => {
      if (decision === 'proceed') removeOnboardingBanner();
      resolve(decision);
    }));
  };
  const dismissBtn = el('button', 'padding:7px 12px;border-radius:7px;border:1px solid var(--border,#2a2e37);background:transparent;color:inherit;cursor:pointer;', 'Not now');
  dismissBtn.onclick = () => {
    sessionStorage.setItem(ONBOARDING_DISMISS_KEY, '1');
    removeOnboardingBanner();
  };
  row.appendChild(topUpBtn);
  row.appendChild(dismissBtn);
  onboardingBanner.appendChild(row);
  document.body.appendChild(onboardingBanner);
}

async function initPaymentOnboarding() {
  // A 401 just means the user has not signed in yet — no banner in that case.
  const balance = await refreshBillingCache();
  if (balance !== null && balance < ONBOARDING_CHAT_MAX_USDC) {
    showOnboardingBanner(balance);
  } else {
    removeOnboardingBanner();
  }
}

// Guarded: startup checks must never break app boot.
initPaymentOnboarding().catch(() => {});
