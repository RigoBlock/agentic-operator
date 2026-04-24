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
import { bazaarResourceServerExtension } from "@x402/extensions";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables } from "../types.js";
import { verifySessionToken, SESSION_HEADER } from "../utils/session.js";

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
      "AI-powered DeFi trading agent for Rigoblock smart vaults. Natural language to safe swap/bridge " +
      "calldata or delegated execution. Supports Uniswap, 0x, GMX perpetuals, Across bridging, " +
      "Uniswap v4 LP, GRG staking, and pool deployment across 7 chains. Protected by NAV Shield " +
      "(10% max loss cap), Swap Shield (oracle price comparison), and 7-point execution validation.",
    mimeType: "application/json",
    // Raw bazaar extension: mirrors the GET/query format that CDP Bazaar indexes
    // successfully. Using queryParams field (like /api/quote) with a permissive
    // method schema so validation passes regardless of what enrichDeclaration sets.
    // Background: createBodyDiscoveryExtension uses enum:["POST","PUT","PATCH"] which
    // CDP's indexer appears to silently reject. GET query-style extensions ARE indexed
    // (confirmed: both /api/quote here and x402-api.aubr.ai/api/chat which uses
    // method:"GET" even for a POST endpoint).
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "POST",
            queryParams: {
              messages: "Array of {role, content} chat messages",
              vaultAddress: "Rigoblock vault contract address (0x...)",
              chainId: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130)",
              executionMode: "manual | delegated (default: manual)",
              confirmExecution: "Set to true for auto-execute in delegated mode",
              operatorAddress: "Vault owner wallet address (optional)",
              authSignature: "EIP-191 signature signed by operatorAddress (optional)",
            },
          },
          output: {
            type: "json",
            example: {
              reply: "I'll swap 1 ETH for USDC on Arbitrum via 0x",
              transaction: {
                to: "0xVaultAddress",
                data: "0xcalldata",
                value: "0x0",
                chainId: 42161,
              },
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string" },
                queryParams: { type: "object" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: {
                type: { type: "string" },
                example: { type: "object" },
              },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
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
    description: "DEX price quotes from Uniswap across 7 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Unichain).",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "GET",
            queryParams: {
              sell: "Token to sell (ETH, USDC, WBTC, or contract address)",
              buy: "Token to buy (ETH, USDC, WBTC, or contract address)",
              amount: "Amount to sell (human-readable, e.g. '1' for 1 ETH)",
              chain: "Chain name or ID (e.g. 'base', '8453', 'arbitrum', '42161')",
            },
          },
          output: {
            type: "json",
            example: {
              sell: "1 ETH",
              buy: "2079.54 USDC",
              price: "1 ETH = 2079.54 USDC",
              routing: "CLASSIC",
              gasFeeUSD: "0.0024",
              gasLimit: "394000",
              chainId: 8453,
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string" },
                queryParams: { type: "object" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: {
                type: { type: "string" },
                example: { type: "object" },
              },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
  },
  "POST /api/tools/*": {
    resource: "https://trader.rigoblock.com/api/tools",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.002",
        network: BASE_NETWORK,
      },
    ],
    description:
      "Direct DeFi tool invocation. POST to /api/tools/{toolName} with arguments object.",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "POST",
            queryParams: {
              toolName: "Tool name (e.g. get_swap_quote, get_vault_info, build_vault_swap)",
              arguments: "Tool arguments object",
              chainId: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130)",
              vaultAddress: "Rigoblock vault address (optional)",
            },
          },
          output: {
            type: "json",
            example: {
              result: {
                sell: "1 ETH",
                buy: "2079.54 USDC",
                price: "1 ETH = 2079.54 USDC",
                chainId: 8453,
              },
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string" },
                queryParams: { type: "object" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: {
                type: { type: "string" },
                example: { type: "object" },
              },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
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

  // Exempt own-frontend requests from payment.
  // When SESSION_SECRET is set (production): validate HMAC session token.
  // When SESSION_SECRET is absent (dev): fall back to Origin/Referer headers.
  server.onProtectedRequest(async (ctx) => {
    const adapter = ctx.adapter;

    if (env.SESSION_SECRET) {
      const token = adapter.getHeader(SESSION_HEADER);
      if (token && await verifySessionToken(token, env.SESSION_SECRET)) {
        return { grantAccess: true };
      }
      // No valid session token → proceed to payment flow
      return;
    }

    // Dev fallback: Origin/Referer (spoofable, acceptable for local development)
    const origin = adapter.getHeader("origin");
    if (origin && EXEMPT_ORIGINS.has(origin)) {
      return { grantAccess: true };
    }
    const referer = adapter.getHeader("referer");
    if (referer) {
      try {
        if (EXEMPT_ORIGINS.has(new URL(referer).origin)) return { grantAccess: true };
      } catch { /* ignore malformed */ }
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
 * Returns true if the request appears to originate from one of our own frontends.
 * Used by routes to allow unauthenticated manual-mode access (browser users viewing
 * a vault they don't own) without requiring x402 payment.
 *
 * ⚠️  Origin and Referer are client-supplied headers and CAN be spoofed by any
 * non-browser HTTP client. The consequence of spoofing is financial (free API calls),
 * NOT a security issue — delegated vault execution still requires a valid EIP-191
 * operator signature + on-chain ownership verification. A proper server-verifiable
 * mechanism (httpOnly session cookie minted by the Worker, or Cloudflare Access JWT)
 * would close this gap; until then this function is a browser-convention heuristic.
 */
export function isExemptBrowserRequest(getHeader: (name: string) => string | undefined): boolean {
  const origin = getHeader("origin");
  if (origin && EXEMPT_ORIGINS.has(origin)) return true;
  const referer = getHeader("referer");
  if (referer) {
    try {
      if (EXEMPT_ORIGINS.has(new URL(referer).origin)) return true;
    } catch {
      // Ignore malformed Referer values
    }
  }
  return false;
}

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
      // Log the error reason so we can see it in wrangler tail
      const hasPaymentSig = !!adapter.getHeader("payment-signature");
      if (hasPaymentSig) {
        // Payment was provided but rejected — log details
        console.error("[x402] Payment rejected", {
          path: adapter.getPath(),
          error: (body as Record<string, unknown>)?.error,
          status,
        });
      }
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
