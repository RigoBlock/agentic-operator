/**
 * x402 Payment Middleware
 *
 * Gates premium API endpoints behind x402 micropayments (USDC on Base mainnet).
 * Own-user requests (browser UI, Telegram) are exempt via the onProtectedRequest hook.
 * External AI agents pay per call using the x402 protocol.
 *
 * Pricing:
 *   POST /api/chat          → upto $0.10 USDC (actual cost billed; ~$0.003–$0.015 typical)
 *   GET  /api/quote         → exact $0.0020 USDC (DEX price quote)
 *   POST /api/quote/uniswap → exact $0.0021 USDC (Uniswap Trading API quote)
 *   GET  /api/quote/0x      → exact $0.0022 USDC (0x API quote)
 *   POST /api/oracle/refresh → exact $0.0023 USDC (oracle refresh tx builder)
 *   GET  /api/tools         → exact $0.0024 USDC (tool discovery)
 *   POST /api/tools         → exact $0.0025 USDC (direct tool invocation)
 *
 * The /api/chat endpoint uses the "upto" scheme — clients authorise up to $0.10
 * but are only charged the actual inference cost (determined by token usage).
 * The Settlement-Overrides response header carries the exact dollar amount back
 * to the x402 facilitator. Callers never pay more than $0.10 per call.
 *
 * Uses @x402/core SDK with ExactEvmScheme (quotes) and UptoEvmScheme (chat).
 * CDP facilitator at api.cdp.coinbase.com handles verification and settlement.
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
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { bazaarResourceServerExtension } from "@x402/extensions";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables } from "../types.js";
import { verifyOperatorSignatureOnly } from "../services/auth.js";

// ── Payment configuration ─────────────────────────────────────────────

/** Wallet receiving x402 payments (same EOA on all chains) */
const PAY_TO = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

/** Base mainnet — USDC payments (CAIP-2) */
const BASE_NETWORK = "eip155:8453";

// ── Public API routes (free by design) ────────────────────────────────
// These /api/* routes are intentionally unprotected. All OTHER /api/* routes
// must be explicitly listed in PROTECTED_ROUTES or they are blocked (fail closed).
export const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/health",
  "GET /api/chains",
  "GET /api/vault",
  "GET /api/strategy-events",
  "GET /api/gas-policy",
  "POST /api/gas-policy",
]);

// Public route prefixes — any method+path matching these is exempt from x402.
// Used for sub-routers that handle their own auth (delegation, telegram).
const PUBLIC_API_PREFIXES: ReadonlyArray<{ method: string; prefix: string }> = [
  { method: "POST", prefix: "/api/delegation/" },
  { method: "GET", prefix: "/api/delegation/" },
  { method: "POST", prefix: "/api/telegram/" },
  { method: "GET", prefix: "/api/telegram/" },
  { method: "POST", prefix: "/api/settings/" },
];

export function isPublicApiRoute(method: string, path: string): boolean {
  if (PUBLIC_API_ROUTES.has(`${method} ${path}`)) return true;
  return PUBLIC_API_PREFIXES.some((p) => method === p.method && path.startsWith(p.prefix));
}

export function isProtectedRoute(method: string, path: string): boolean {
  return `${method} ${path}` in PROTECTED_ROUTES;
}

// ── Protected route config (v2 format) ────────────────────────────────

export const PROTECTED_ROUTES: RoutesConfig = {
  "POST /api/chat": {
    resource: "https://trader.rigoblock.com/api/chat",
    accepts: [
      {
        scheme: "upto",
        payTo: PAY_TO,
        price: "$0.10",
        network: BASE_NETWORK,
      },
    ],
    description:
      "AI-powered DeFi trading agent for Rigoblock smart vaults. Natural language to safe swap/bridge " +
      "calldata or delegated execution. Supports Uniswap, 0x, GMX perpetuals, Across bridging, " +
      "Uniswap v4 LP, GRG staking, and pool deployment across 7 chains. Protected by NAV Shield " +
      "(10% max loss per trade), Swap Shield (oracle vs DEX price divergence check), slippage " +
      "protection, delegation verification, and transaction simulation.",
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
            method: "GET",
            queryParams: {
              messages: "Array of {role, content} chat messages (POST body)",
              vaultAddress: "Rigoblock vault contract address (POST body)",
              chainId: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130) (POST body)",
              executionMode: "manual | delegated, default manual (POST body)",
              confirmExecution: "Set true for auto-execute in delegated mode (POST body)",
              operatorAddress: "Vault owner wallet address (POST body)",
              authSignature: "EIP-191 signature signed by operatorAddress (POST body)",
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
    resource: "https://trader.rigoblock.com/api/quote",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.0020",
        network: BASE_NETWORK,
      },
    ],
    description:
      "DEX price quote across 7 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Unichain). " +
      "Returns sell/buy amounts, price, routing, and gas estimate.",
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
  "POST /api/quote/uniswap": {
    resource: "https://trader.rigoblock.com/api/quote/uniswap",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.0021",
        network: BASE_NETWORK,
      },
    ],
    description:
      "Uniswap Trading API quote with on-chain oracle price comparison. Drop-in proxy for Uniswap /quote " +
      "— same request body, response includes priceFeedExists, deltaBps, and oracleAmount.",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "POST",
            queryParams: {
              type: "EXACT_INPUT or EXACT_OUTPUT",
              amount: "Amount in base units (e.g. '1000000000000000000')",
              tokenIn: "Token to sell (address or symbol)",
              tokenOut: "Token to buy (address or symbol)",
              tokenInChainId: "Chain ID (e.g. 8453)",
              tokenOutChainId: "Chain ID (e.g. 8453)",
              swapper: "Swapper address (required by Uniswap Trading API)",
            },
          },
          output: {
            type: "json",
            example: {
              routing: "CLASSIC",
              priceFeedExists: true,
              deltaBps: 12,
              oracleAmount: "2079548076",
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
  "GET /api/quote/0x": {
    resource: "https://trader.rigoblock.com/api/quote/0x",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.0022",
        network: BASE_NETWORK,
      },
    ],
    description:
      "0x API v2 quote with on-chain oracle price comparison. Drop-in proxy for 0x /swap/allowance-holder/quote " +
      "— same query parameters, response includes priceFeedExists, deltaBps, and oracleAmount.",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "GET",
            queryParams: {
              chainId: "Chain ID (e.g. 8453)",
              sellToken: "Token to sell (address or symbol)",
              buyToken: "Token to buy (address or symbol)",
              sellAmount: "Amount to sell in base units. Provide either sellAmount (exact-input) or buyAmount (exact-output).",
              buyAmount: "Amount to buy in base units. Provide either sellAmount (exact-input) or buyAmount (exact-output).",
              slippageBps: "Slippage tolerance in basis points (e.g. 100 for 1%)",
              taker: "Address that will execute the swap",
            },
          },
          output: {
            type: "json",
            example: {
              buyAmount: "2079548076",
              priceFeedExists: true,
              deltaBps: -8,
              oracleAmount: "2081500000",
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
  "POST /api/oracle/refresh": {
    resource: "https://trader.rigoblock.com/api/oracle/refresh",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.0023",
        network: BASE_NETWORK,
      },
    ],
    description:
      "Build an unsigned operator EOA transaction that swaps ETH on the on-chain oracle's " +
      "dedicated Uniswap V4 pool to create a fresh price observation and fix a stale TWAP feed. " +
      "Use when the Swap Shield blocks a trade due to oracle price divergence.",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "POST",
            queryParams: {
              token: "ERC-20 token symbol or address whose oracle feed is stale (e.g. 'GRG', 'USDC')",
              amountEth: "Amount of ETH to swap (e.g. '0.001'). Larger converges TWAP faster.",
              chainId: "EVM chain ID where the oracle pool lives (e.g. 42161, 8453)",
            },
          },
          output: {
            type: "json",
            example: {
              transaction: {
                to: "0xUniversalRouter",
                data: "0xcalldata",
                value: "0x38d7ea4c68000",
                chainId: 42161,
                gas: "0x61a80",
                description: "Oracle pool refresh: swap 0.001 ETH → GRG on BackgeoOracle V4 pool",
              },
              poolInfo: {
                oracle: "0x3043e182047F8696dFE483535785ed1C3681baC4",
                currency0: "0x0000000000000000000000000000000000000000",
                currency1: "0x4De83a33d0d24B9d3C33A67A844A72b41d2E8e86",
                tokenSymbol: "GRG",
                poolId: "0xabc...",
                cardinality: 1,
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
  "GET /api/tools": {
    resource: "https://trader.rigoblock.com/api/tools",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.0024",
        network: BASE_NETWORK,
      },
    ],
    description:
      "Rigoblock DeFi tool discovery. Returns the full catalog with JSON schemas, categories, " +
      "and access requirements for all direct-invocation tools.",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          name: "Rigoblock",
          input: {
            type: "http",
            method: "GET",
            queryParams: {},
          },
          output: {
            type: "json",
            example: {
              toolCount: 41,
              tools: [
                {
                  name: "get_swap_quote",
                  description: "Get a price-only quote...",
                  category: "Spot Trading",
                  parameters: { type: "object", properties: {} },
                  requiresOperatorAuth: false,
                  readOnly: true,
                },
              ],
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
  "POST /api/tools": {
    resource: "https://trader.rigoblock.com/api/tools",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: "$0.0025",
        network: BASE_NETWORK,
      },
    ],
    description:
      "Rigoblock direct DeFi tool invocation. POST to /api/tools?toolName={name} with arguments object.",
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
              arguments: "Tool arguments object (POST body)",
              chainId: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130) (POST body)",
              vaultAddress: "Rigoblock vault address, optional (POST body)",
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
    .register(BASE_NETWORK, new UptoEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const server = new x402HTTPResourceServer(resourceServer, PROTECTED_ROUTES);
  return server;
}

async function getHttpServer(env: Env): Promise<x402HTTPResourceServer> {
  if (!httpServer) {
    httpServer = buildHttpServer(env);
    initPromise = httpServer.initialize().catch((err) => {
      // Clear the singleton so the next request can retry initialization.
      // Without this, every subsequent request would re-throw the same stale error.
      httpServer = null;
      initPromise = null;
      throw err;
    });
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
// ── Rate limiting (non-paid requests only) ────────────────────────────

const RATE_LIMIT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WARNING_THRESHOLD = 10;

interface RateLimitState {
  count: number;
  windowStart: number;
}

async function checkRateLimit(
  kv: KVNamespace | undefined,
  operatorAddress: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  if (!kv) {
    return { allowed: true, remaining: RATE_LIMIT_MAX, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
  }
  const key = `rate-limit:${operatorAddress.toLowerCase()}`;
  const now = Date.now();
  const data = await kv.get<RateLimitState>(key, "json");

  if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    const state: RateLimitState = { count: 1, windowStart: now };
    await kv.put(key, JSON.stringify(state), {
      expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 60,
    });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }

  if (data.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: data.windowStart + RATE_LIMIT_WINDOW_MS };
  }

  const state: RateLimitState = { count: data.count + 1, windowStart: data.windowStart };
  await kv.put(key, JSON.stringify(state), {
    expirationTtl: Math.ceil((data.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000) + 60,
  });
  return { allowed: true, remaining: RATE_LIMIT_MAX - data.count - 1, resetAt: data.windowStart + RATE_LIMIT_WINDOW_MS };
}

function setRateLimitHeaders(
  c: { header: (k: string, v: string) => void },
  remaining: number,
  resetAt: number,
): void {
  c.header("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  if (remaining < RATE_LIMIT_WARNING_THRESHOLD) {
    const resetIso = new Date(resetAt).toISOString();
    c.header("X-RateLimit-Warning", `${remaining} requests remaining before rate limit. Resets at ${resetIso}`);
  }
}

export function createX402Middleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    // Fast path: authenticated operators skip x402 payment.
    // The frontend sends the operator's EIP-191 signature in headers only.
    // If valid (timestamp within 24h + signature verifies), skip x402 entirely.
    const operatorAddress = c.req.header("x-operator-address");
    const authSignature = c.req.header("x-auth-signature");
    const authTimestamp = c.req.header("x-auth-timestamp");

    if (operatorAddress && authSignature && authTimestamp) {
      const ts = Number(authTimestamp);
      if (!isNaN(ts)) {
        let valid = false;
        try {
          valid = await verifyOperatorSignatureOnly(operatorAddress, authSignature, ts);
        } catch {
          // signature verification threw — treat as invalid
        }

        if (valid) {
          // Fail-closed safety: only bypass x402 for explicitly protected routes.
          const path = new URL(c.req.url).pathname;
          const method = c.req.method;
          if (!isProtectedRoute(method, path)) {
            // Signature is valid but route is not protected — fall through to normal flow
          } else {
            // Rate limit check (non-paid requests only)
            const rateLimit = await checkRateLimit(c.env.KV, operatorAddress);
            if (!rateLimit.allowed) {
              setRateLimitHeaders(c, 0, rateLimit.resetAt);
              const retryAfterSec = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
              c.header("Retry-After", String(retryAfterSec));
              return c.json(
                {
                  error: "Rate limit exceeded",
                  detail: `Authenticated operators are limited to ${RATE_LIMIT_MAX} requests per 4-hour window.`,
                  retryAfter: retryAfterSec,
                },
                429,
              );
            }

            c.set("operatorAuthVerified", true);
            setRateLimitHeaders(c, rateLimit.remaining, rateLimit.resetAt);
            return next();
          }
        } else {
          // Auth headers were sent but signature is invalid or expired.
          // Return 401 so the frontend knows to re-authenticate instead of
          // confusing the user with a 402 "Payment Required".
          return c.json(
            {
              error: "Authentication expired",
              detail: "Your session signature is invalid or expired. Please re-authenticate.",
            },
            401,
          );
        }
      }
    }

    // Fast path: discovery/health routes and public API routes don't need x402 at all.
    const reqPath = new URL(c.req.url).pathname;
    const reqMethod = c.req.method;
    if (reqPath.startsWith("/.well-known/") || isPublicApiRoute(reqMethod, reqPath)) {
      return next();
    }

    // Skip x402 when CDP credentials are missing or clearly invalid (test/dev envs).
    const hasCdpCreds =
      typeof c.env.CDP_API_KEY_ID === "string" && c.env.CDP_API_KEY_ID.length > 0 &&
      typeof c.env.CDP_API_KEY_SECRET === "string" && c.env.CDP_API_KEY_SECRET.length > 0;
    if (!hasCdpCreds) {
      return next();
    }

    let server: x402HTTPResourceServer;
    try {
      server = await getHttpServer(c.env);
    } catch (err) {
      // x402 server init failed (facilitator unreachable, bad credentials, etc.)
      // For non-protected routes, let the request through — don't block vault reads
      // because the payment facilitator is down.
      // Suppress noisy logs in test environments (Vitest).
      const isTest = typeof process !== "undefined" && (process.env?.VITEST || process.env?.NODE_ENV === "test");
      if (!isTest) {
        console.error("[x402] Server initialization failed:", err);
      }
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
      // SAFETY: fail closed for /api/* routes.
      // If a developer adds a new /api/ route but forgets to add it to
      // PROTECTED_ROUTES, external agents would get a confusing 401 from
      // the route's own auth check (because x402Paid is never set).
      // Instead, we block explicitly with a clear error.
      const path = adapter.getPath();
      const method = adapter.getMethod();
      if (path.startsWith("/api/") && !isPublicApiRoute(method, path) && !isProtectedRoute(method, path)) {
        console.error(
          `[x402] SECURITY BLOCK: API route ${method} ${path} is not in ` +
          `PROTECTED_ROUTES and not in PUBLIC_API_ROUTES. Blocking request.`,
        );
        return c.json(
          {
            error: "Route not configured for access",
            detail: `The endpoint ${method} ${path} is not registered in the payment or public route configuration. ` +
              "This is a server configuration issue — please contact the operator.",
          },
          503,
        );
      }
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

    // Settle the payment after a successful response.
    // For upto-scheme routes (/api/chat), the route sets a Settlement-Overrides header
    // with the actual inference cost, which the SDK reads from responseHeaders and uses
    // as the settlement amount (always <= maxAmountRequired).
    const responseHeaders = Object.fromEntries(c.res.headers.entries());
    const settleResult = await server.processSettlement(
      paymentPayload,
      paymentRequirements,
      declaredExtensions,
      { request: context, responseHeaders },
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
