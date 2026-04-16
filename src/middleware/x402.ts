/**
 * x402 v2 Payment Middleware
 *
 * Gates premium API endpoints behind x402 micropayments (USDC on Base mainnet).
 * Own-user requests (browser UI, Telegram) are exempt via the onProtectedRequest hook.
 * External AI agents pay per call using the x402 v2 protocol.
 *
 * Pricing:
 *   POST /api/chat  → $0.01  (LLM-powered trading chat)
 *   GET  /api/quote → $0.002 (DEX price quote)
 *
 * Uses @x402/core v2 SDK with ExactEvmScheme (server-side) and the CDP
 * facilitator at api.cdp.coinbase.com for Base mainnet support.
 * Bazaar discovery metadata is declared via @x402/extensions declareDiscoveryExtension.
 *
 * @see https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
 */

import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
} from "@x402/core/server";
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPProcessResult,
  RoutesConfig,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables } from "../types.js";

// ── Payment configuration ─────────────────────────────────────────────

/** Wallet receiving x402 payments (same EOA on all chains) */
const PAY_TO = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

/** Base mainnet — USDC payments (CAIP-2) */
const BASE_NETWORK = "eip155:8453";

// ── Exempt origins (our own frontends) ────────────────────────────────

const EXEMPT_ORIGINS = new Set([
  "https://trader.rigoblock.com",
  "https://agentic-operator.gabriele-rigo.workers.dev",
  "http://localhost:8787",  // wrangler dev
  "http://localhost:5173",  // vite dev
]);

// ── Protected route config (v2 format) ────────────────────────────────

const PROTECTED_ROUTES: RoutesConfig = {
  "POST /api/chat": {
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.01",
        network: BASE_NETWORK,
      },
    ],
    description:
      "AI-powered trading assistant for Rigoblock vaults. Supports swaps (Uniswap, 0x), " +
      "perpetual positions (GMX), cross-chain bridging (Across), pool deployment, and " +
      "delegated execution. Protected by STAR (Stupid Transaction Automated Rejector).",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        messages: "Array of {role, content} chat messages",
        vaultAddress: "Rigoblock vault contract address (0x…)",
        chainId: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130)",
        operatorAddress: "Operator wallet address (optional)",
        executionMode: "manual | delegated (optional, default: manual)",
      },
      output: {
        example: {
          reply: "I'll swap 1 ETH → USDC on Arbitrum via 0x…",
          suggestions: ["Check balance", "Swap ETH to USDC"],
          transaction: {
            to: "0xVaultAddress",
            data: "0xcalldata…",
            value: "0x0",
            chainId: 42161,
            description: "Swap 1 ETH → 3,456.78 USDC via 0x",
          },
        },
      },
    }),
  },
  "GET /api/quote": {
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.002",
        network: BASE_NETWORK,
      },
    ],
    description: "DEX price quotes from Uniswap and 0x aggregator across all supported chains.",
    mimeType: "application/json",
    extensions: declareDiscoveryExtension({
      input: {
        sell: "Token to sell (ETH, USDC, WBTC, … or contract address)",
        buy: "Token to buy (ETH, USDC, WBTC, … or contract address)",
        amount: "Amount to sell (human-readable, e.g. '1' for 1 ETH)",
        chain: "Chain name or ID (e.g. 'base', '8453', 'arbitrum', '42161')",
      },
      output: {
        example: {
          sell: "ETH",
          buy: "USDC",
          amountIn: "1.0",
          amountOut: "3456.78",
          priceImpact: "0.03%",
          source: "uniswap",
          chainId: 8453,
        },
      },
    }),
  },
};

// ── Build x402 v2 server (lazy-initialized) ───────────────────────────

let httpServer: x402HTTPResourceServer | null = null;
let initPromise: Promise<void> | null = null;

function buildHttpServer(env: Env): x402HTTPResourceServer {
  // CDP facilitator (Base mainnet — USDC payments)
  const facilitatorConfig = createFacilitatorConfig(
    env.CDP_API_KEY_ID,
    env.CDP_API_KEY_SECRET,
  );
  const cdpFacilitator = new HTTPFacilitatorClient(facilitatorConfig);

  const resourceServer = new x402ResourceServer([cdpFacilitator])
    .register(BASE_NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const server = new x402HTTPResourceServer(resourceServer, PROTECTED_ROUTES);

  // Exempt own-frontend requests from payment
  server.onProtectedRequest(async (ctx) => {
    const adapter = ctx.adapter;
    const secFetchSite = adapter.getHeader("sec-fetch-site");
    if (secFetchSite === "same-origin") {
      return { grantAccess: true };
    }

    const origin = adapter.getHeader("origin");
    if (origin && EXEMPT_ORIGINS.has(origin)) {
      return { grantAccess: true };
    }

    const referer = adapter.getHeader("referer");
    if (referer) {
      for (const o of EXEMPT_ORIGINS) {
        if (referer.startsWith(o)) {
          return { grantAccess: true };
        }
      }
    }
    // Continue to payment flow
  });

  return server;
}

async function getHttpServer(env: Env): Promise<x402HTTPResourceServer> {
  if (!httpServer) {
    httpServer = buildHttpServer(env);
    initPromise = httpServer.initialize();
  }
  await initPromise;
  return httpServer;
}

// ── Hono HTTPAdapter ──────────────────────────────────────────────────

function honoAdapter(c: { req: { header(name: string): string | undefined; method: string; url: string } }): HTTPAdapter {
  const url = new URL(c.req.url);
  return {
    getHeader: (name: string) => c.req.header(name),
    getMethod: () => c.req.method,
    getPath: () => url.pathname,
    getUrl: () => c.req.url,
    getAcceptHeader: () => c.req.header("accept") ?? "",
    getUserAgent: () => c.req.header("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}

// ── Middleware factory ─────────────────────────────────────────────────

/**
 * Creates the x402 v2 payment middleware for Hono.
 *
 * Flow:
 * 1. Lazy-init the x402HTTPResourceServer (fetches facilitator support once)
 * 2. Build HTTPRequestContext from Hono context
 * 3. processHTTPRequest → returns one of:
 *    - "no-payment-required"  → next()
 *    - "payment-verified"     → next(), then settle
 *    - "payment-error"        → return 402 with payment instructions
 */
export function createX402Middleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    let server: x402HTTPResourceServer;
    try {
      server = await getHttpServer(c.env);
    } catch (err) {
      // x402 server init failed (facilitator unreachable, bad credentials, etc.)
      // For non-protected routes, let the request through — don't block vault reads
      // because the payment facilitator is down.
      console.error("[x402] Server initialization failed:", err);
      return next();
    }

    const adapter = honoAdapter(c);
    const context: HTTPRequestContext = {
      adapter,
      path: adapter.getPath(),
      method: adapter.getMethod(),
      paymentHeader: adapter.getHeader("x-payment"),
    };

    let result: HTTPProcessResult;
    try {
      result = await server.processHTTPRequest(context);
    } catch (err) {
      // Payment processing failed — for non-protected routes, let through
      console.error("[x402] processHTTPRequest failed:", err);
      return next();
    }

    if (result.type === "no-payment-required") {
      return next();
    }

    if (result.type === "payment-error") {
      const { status, headers, body, isHtml } = result.response;
      for (const [k, v] of Object.entries(headers)) {
        c.header(k, v);
      }
      if (isHtml) {
        c.header("content-type", "text/html");
        return c.html(body as string, status as 402);
      }
      return c.json(body as Record<string, unknown>, status as 402);
    }

    // payment-verified → flag context so routes skip their own auth, then run handler
    const { paymentPayload, paymentRequirements, declaredExtensions } = result;
    c.set("x402Paid", true);
    await next();

    // Only settle if the route handler succeeded (2xx).
    // Don't charge agents for our errors (5xx) or their malformed requests (4xx).
    const responseStatus = c.res.status;
    if (responseStatus >= 400) {
      console.warn(`[x402] Skipping settlement — route returned ${responseStatus}`);
      return;
    }

    // Settle the payment after a successful response
    const settleResult = await server.processSettlement(
      paymentPayload,
      paymentRequirements,
      declaredExtensions,
      { request: context },
    );

    if (settleResult.success) {
      for (const [k, v] of Object.entries(settleResult.headers)) {
        c.header(k, v);
      }
      console.log(`[x402] Settlement succeeded, headers:`, Object.keys(settleResult.headers));
    } else {
      // Settlement failed — log but still return the successful response.
      // The agent got the data; settlement failure is between us and the facilitator.
      console.error(`[x402] Settlement failed:`, (settleResult as any).errorReason ?? "unknown");
      // Still set whatever headers came back (may include error info)
      if ((settleResult as any).headers) {
        for (const [k, v] of Object.entries((settleResult as any).headers)) {
          c.header(k, v as string);
        }
      }
    }
  };
}
