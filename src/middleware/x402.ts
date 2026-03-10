/**
 * x402 Payment Middleware
 *
 * Gates premium API endpoints behind x402 micropayments (USDC on Base).
 * Own-user requests (browser UI, Telegram) are exempt via origin / Sec-Fetch checks.
 * External AI agents pay per call using the x402 protocol.
 *
 * Pricing:
 *   POST /api/chat  → $0.01  (LLM-powered trading chat)
 *   GET  /api/quote → $0.002 (DEX price quote)
 *
 * Uses the `x402-hono` v1 middleware (same as Cloudflare's x402-proxy template)
 * with `"base"` mainnet and the default CDP facilitator.
 *
 * @see https://developers.cloudflare.com/agents/x402/charge-for-http-content/
 * @see https://x402.org
 */

import { paymentMiddleware } from "x402-hono";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

// ── Payment configuration ─────────────────────────────────────────────

/** Wallet receiving x402 payments (USDC on Base) */
const PAY_TO = "0xA0F9C380ad1E1be09046319fd907335B2B452B37" as `0x${string}`;

/** Base mainnet. Use "base-sepolia" for testnet. */
const NETWORK = "base" as const;

// ── Exempt origins (our own frontends) ────────────────────────────────

const EXEMPT_ORIGINS = new Set([
  "https://trader.rigoblock.com",
  "https://agentic-operator.gabriele-rigo.workers.dev",
  "http://localhost:8787",  // wrangler dev
  "http://localhost:5173",  // vite dev
]);

// ── Protected route config ────────────────────────────────────────────

/** Routes that require x402 payment from external agents */
const PROTECTED_ROUTES: Record<string, { price: string; network: string; config: { description: string } }> = {
  "POST /api/chat": {
    price: "$0.01",
    network: NETWORK,
    config: { description: "AI-powered trading chat for Rigoblock vaults" },
  },
  "GET /api/quote": {
    price: "$0.002",
    network: NETWORK,
    config: { description: "DEX price quotes via Uniswap / 0x aggregator" },
  },
};

// Pre-compile route patterns for efficient matching
const compiledRoutes = Object.entries(PROTECTED_ROUTES).map(([key, cfg]) => {
  const spaceIdx = key.indexOf(" ");
  const verb = key.slice(0, spaceIdx).toUpperCase();
  const pathPattern = key.slice(spaceIdx + 1);
  // Convert "/api/chat" → exact, "/api/quote/*" → prefix
  const regex = pathPattern.endsWith("/*")
    ? new RegExp(`^${pathPattern.slice(0, -2)}(/|$)`)
    : new RegExp(`^${pathPattern}$`);
  return { verb, regex, cfg };
});

// ── Middleware factory ─────────────────────────────────────────────────

/**
 * Creates the x402 payment middleware for Hono.
 *
 * Flow for each request:
 * 1. Check exempt origins (browser UI, Telegram) → skip payment
 * 2. Match against protected routes → if no match, skip payment
 * 3. Apply x402 `paymentMiddleware` from `x402-hono` → returns 402 with
 *    payment instructions. Client pays USDC on Base, retries with
 *    X-PAYMENT header → access granted.
 *
 * Uses the default CDP facilitator (no custom facilitator URL needed).
 */
export function createX402Middleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    // ── 1. Exempt our own frontend users ───────────────────────────

    // Sec-Fetch-Site is set by the browser and cannot be spoofed via JS.
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite === "same-origin") {
      return next();
    }

    // Fallback: check Origin / Referer for known frontends
    const origin = c.req.header("origin");
    if (origin && EXEMPT_ORIGINS.has(origin)) {
      return next();
    }

    const referer = c.req.header("referer");
    if (referer) {
      for (const o of EXEMPT_ORIGINS) {
        if (referer.startsWith(o)) {
          return next();
        }
      }
    }

    // ── 2. Check if this route is protected ────────────────────────

    const method = c.req.method.toUpperCase();
    const path = new URL(c.req.url).pathname;
    const matched = compiledRoutes.find(
      (r) => r.verb === method && r.regex.test(path),
    );

    if (!matched) {
      // Not a protected route — proceed without payment
      return next();
    }

    // ── 3. Apply x402 payment middleware ───────────────────────────

    // Build route config keyed by the matched path (x402-hono matches on path)
    const routeKey = path;
    const paymentMw = paymentMiddleware(
      PAY_TO,
      {
        [routeKey]: {
          price: matched.cfg.price,
          network: NETWORK,
          config: { description: matched.cfg.config.description },
        },
      },
      // undefined = use default CDP facilitator (supports Base mainnet)
    );

    // paymentMiddleware returns (c, next) => Promise<void | Response>
    return paymentMw(c, next);
  };
}
