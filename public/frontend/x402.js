/**
 * x402 Payment Client — hand-rolled for the no-bundler frontend.
 *
 * THE payment model (there is exactly one): the operator funds a USDC deposit
 * on Base once, and every paid API call (/api/chat, /api/quotes, /api/tools,
 * /api/oracle/refresh — pool deployment included) is paid automatically from
 * it via POST /api/billing/payment-header. The worker signs standard x402
 * payment payloads server-side (USDC EIP-3009 for exact endpoints, Permit2
 * witness for the chat "upto" scheme, which bills actual cost not the max);
 * the facilitator verifies and settles a normal x402 payment on every call.
 * No per-call wallet signatures — the wallet is only used to top up the
 * deposit (and optionally withdraw it back).
 *
 * On HTTP 402 from billing (deposit empty/too low), the onboarding UI asks
 * the operator to top up; the call then retries automatically.
 */

import { apiHeaders } from './state.js';

/** Thrown when a call cannot be paid (top-up declined/cancelled, billing down). */
export class X402PaymentError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'X402PaymentError';
    Object.assign(this, extra);
  }
}

/** Ask the worker to sign this call's payment from the operator's deposit. */
async function signViaDeposit(method, path) {
  const res = await fetch('/api/billing/payment-header', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ method, path }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) noteBalance(data.balanceUSDC);
  if (res.status === 402 && data.error === 'insufficient_deposit') {
    noteBalance(data.balanceUSDC);
    throw new X402PaymentError('Deposit is empty or too low for this call.', {
      code: 'insufficient_deposit',
      balanceUSDC: data.balanceUSDC,
    });
  }
  if (!res.ok) {
    throw new X402PaymentError(data.detail || data.error || 'Payment could not be prepared.', { code: data.error });
  }
  return data; // { paymentSignature, amountUSDC, balanceUSDC, network }
}

const LOW_BALANCE_USDC = 0.5;

// Last known deposit balance (from payment-header / billing status). Used to
// skip the predictable 402 round-trip when we already know the deposit is empty.
let cachedBalanceUSDC = null;
export function noteBalance(balanceUSDC) {
  if (balanceUSDC !== undefined && balanceUSDC !== null) cachedBalanceUSDC = Number(balanceUSDC);
}

/** Fresh balance straight from the billing status endpoint. */
export async function refreshBillingCache() {
  try {
    const res = await fetch('/api/billing/status', { headers: apiHeaders() });
    if (res.ok) {
      const data = await res.json();
      noteBalance(data.balanceUSDC);
    }
  } catch {
    // Keep the previous cache on failure; the payment flow degrades to the modal.
  }
  return cachedBalanceUSDC;
}

/** Fire a non-blocking warning when the deposit drops below the threshold. */
function maybeWarnLowBalance(balanceUSDC) {
  const balance = Number(balanceUSDC);
  if (Number.isFinite(balance) && balance > 0 && balance < LOW_BALANCE_USDC) {
    window.dispatchEvent(new CustomEvent('rigoblock:low-balance', { detail: { balanceUSDC } }));
  }
}

let topUpHandler = null;
/** Installed by payment-ui.js: asks the operator to top up the deposit.
 *  Resolves 'proceed' after a successful top-up, 'abort' to cancel the call. */
export function setTopUpHandler(fn) {
  topUpHandler = fn;
}

/**
 * fetch() that pays from the deposit. The operator is prompted to top up
 * only when the deposit cannot cover a call.
 */
// Most expensive single call (chat, upto $0.20). Everything else is ≤ $0.0025.
function maxCostForPath(path) {
  return path.startsWith('/api/chat') ? 0.2 : 0.0025;
}

export async function fetchWithPayment(url, options = {}) {
  const u = new URL(url, location.origin);
  const method = options.method || 'GET';
  const path = u.pathname + u.search;
  const attempt = (extraHeaders) =>
    fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), ...extraHeaders },
    });

  const askTopUp = async () => {
    if (!topUpHandler) {
      throw new X402PaymentError('Deposit is empty or too low — top it up in the payment panel.', { code: 'insufficient_deposit' });
    }
    const decision = await topUpHandler({ method, path });
    if (decision !== 'proceed') {
      throw new X402PaymentError('Payment cancelled — the API call was not paid.', { code: 'cancelled' });
    }
  };

  // Never invoke the paid endpoint without a payment attached. Readiness is
  // proven first, then the payment is signed and sent in the SAME request.
  const needed = maxCostForPath(path);
  if (cachedBalanceUSDC === null || cachedBalanceUSDC < needed) {
    await refreshBillingCache();
  }
  if (cachedBalanceUSDC === null || cachedBalanceUSDC < needed) {
    await askTopUp();
  }

  const payment = await signViaDeposit(method, path);
  const paid = await attempt({ 'PAYMENT-SIGNATURE': payment.paymentSignature });
  if (paid.status === 402) {
    // A funded deposit can still be rejected for protocol/config reasons. Do
    // NOT show a top-up modal in that case — surface the actual failure.
    const data = await paid.clone().json().catch(() => ({}));
    throw new X402PaymentError(
      `Payment rejected: ${data.error || 'the server could not match the payment requirements'}`,
      { code: 'payment_rejected' },
    );
  }
  maybeWarnLowBalance(payment.balanceUSDC);
  return paid;
}
