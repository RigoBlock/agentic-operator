/**
 * Billing routes — /api/billing/*
 *
 * x402 auto-pay deposits: the operator pre-funds a server-side CDP billing
 * wallet (TEE-backed keys) with USDC on Base, and the worker signs standard
 * x402 payment payloads from it per call (no per-call wallet prompts in the
 * UI). The facilitator still verifies and settles a normal x402 payment on
 * every call — the deposit is only the funding source.
 *
 *   GET  /api/billing/status           → deposit address + balance + top-up tx
 *   POST /api/billing/payment-header   → signed x402 payment for a paid route
 *   POST /api/billing/withdraw         → signed USDC transfer back to the operator
 *
 * All routes require an authenticated operator (operatorAuth middleware) and
 * are payment-exempt (they are not LLM/quote endpoints; payment-header is
 * rate-limited per operator because each call is a CDP signing round-trip).
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import {
  getBillingWalletAddress,
  getBillingBalance,
  signBillingPayment,
  buildWithdrawal,
  buildTopUpData,
  USDC_BASE,
  BillingError,
} from "../services/billing.js";

const billing = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const LOW_BALANCE_USDC = 0.5; // warn (non-blocking) below this

/** Authenticated operator address from the operatorAuth middleware. */
function operatorFrom(c: { get: (k: string) => unknown }): string | null {
  const auth = c.get("operatorAuth") as { address?: string } | undefined;
  return auth?.address || null;
}

billing.get("/status", async (c) => {
  const operator = operatorFrom(c);
  if (!operator) {
    return c.json({ error: "Authentication required", detail: "Sign in with your operator wallet first." }, 401);
  }
  try {
    const depositAddress = await getBillingWalletAddress(c.env, operator);
    const balance = await getBillingBalance(c.env, operator);
    return c.json({
      depositAddress,
      balanceUSDC: (Number(balance) / 1e6).toFixed(6),
      asset: USDC_BASE,
      network: "eip155:8453",
    });
  } catch (err) {
    console.error("[billing/status] Error:", err);
    return c.json({ error: "Billing status unavailable", detail: "Retry in a moment." }, 503);
  }
});

/**
 * Encode a top-up USDC transfer for an arbitrary amount — the UI renders one
 * "Top up" button with an amount input and submits the returned calldata
 * with the operator's wallet.
 */
billing.get("/topup", async (c) => {
  const operator = operatorFrom(c);
  if (!operator) {
    return c.json({ error: "Authentication required", detail: "Sign in with your operator wallet first." }, 401);
  }
  const amount = Number(c.req.query("amount"));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
    return c.json({ error: "Invalid amount", detail: "amount must be a positive number of USDC (≤ 10000)." }, 400);
  }
  try {
    const depositAddress = await getBillingWalletAddress(c.env, operator);
    const micro = BigInt(Math.round(amount * 1e6));
    return c.json({
      to: USDC_BASE,
      data: buildTopUpData(depositAddress, micro),
      amountUSDC: amount.toString(),
    });
  } catch (err) {
    console.error("[billing/topup] Error:", err);
    return c.json({ error: "Billing unavailable", detail: "Retry in a moment." }, 503);
  }
});

// ── payment-header rate limit (per operator, 4h window) ────────────────
const PH_LIMIT = 300;
const PH_WINDOW_MS = 4 * 60 * 60 * 1000;

async function paymentHeaderRateLimit(kv: KVNamespace, operator: string): Promise<boolean> {
  const key = `billing-phrl:${operator.toLowerCase()}`;
  const now = Date.now();
  const data = await kv.get<{ count: number; windowStart: number }>(key, "json");
  if (!data || now - data.windowStart > PH_WINDOW_MS) {
    await kv.put(key, JSON.stringify({ count: 1, windowStart: now }), { expirationTtl: PH_WINDOW_MS / 1000 + 60 });
    return true;
  }
  if (data.count >= PH_LIMIT) return false;
  await kv.put(key, JSON.stringify({ count: data.count + 1, windowStart: data.windowStart }), {
    expirationTtl: Math.ceil((data.windowStart + PH_WINDOW_MS - now) / 1000) + 60,
  });
  return true;
}

billing.post("/payment-header", async (c) => {
  const operator = operatorFrom(c);
  if (!operator) {
    return c.json({ error: "Authentication required", detail: "Sign in with your operator wallet first." }, 401);
  }
  let body: { method?: string; path?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const method = String(body.method || "GET").toUpperCase();
  const path = String(body.path || "").split("?")[0];
  if (!path.startsWith("/api/")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  if (c.env.KV && !(await paymentHeaderRateLimit(c.env.KV, operator))) {
    return c.json({ error: "Rate limit exceeded", detail: "Too many payment requests — retry later." }, 429);
  }

  try {
    const { paymentSignature, amountUSDC } = await signBillingPayment(c.env, operator, method, path);
    const balance = await getBillingBalance(c.env, operator);
    return c.json({
      paymentSignature,
      amountUSDC,
      network: "eip155:8453",
      balanceUSDC: (Number(balance) / 1e6).toFixed(6),
    });
  } catch (err) {
    if (err instanceof BillingError) {
      if (err.code === "insufficient_deposit") {
        const balance = await getBillingBalance(c.env, operator).catch(() => 0n);
        return c.json(
          { error: err.code, detail: err.message, balanceUSDC: (Number(balance) / 1e6).toFixed(6) },
          402,
        );
      }
      return c.json({ error: err.code, detail: err.message }, 400);
    }
    console.error("[billing/payment-header] Error:", err);
    return c.json({ error: "payment_unavailable", detail: "Could not prepare the payment — retry in a moment." }, 503);
  }
});

billing.post("/withdraw", async (c) => {
  const operator = operatorFrom(c);
  if (!operator) {
    return c.json({ error: "Authentication required", detail: "Sign in with your operator wallet first." }, 401);
  }
  let body: { amountUSDC?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body = withdraw full balance
  }
  try {
    const amount = body.amountUSDC
      ? BigInt(Math.round(Number(body.amountUSDC) * 1e6))
      : undefined;
    const tx = await buildWithdrawal(c.env, operator, amount);
    return c.json({
      ...tx,
      note: "Submit this transaction with your wallet (Base network) to receive the USDC. You pay the gas.",
    });
  } catch (err) {
    if (err instanceof BillingError) {
      const status = err.code === "insufficient_deposit" ? 402 : 400;
      return c.json({ error: err.code, detail: err.message }, status);
    }
    console.error("[billing/withdraw] Error:", err);
    return c.json({ error: "withdraw_unavailable", detail: "Could not prepare the withdrawal — retry in a moment." }, 503);
  }
});

export { billing };
