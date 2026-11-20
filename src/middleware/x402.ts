/**
 * x402 Payment Middleware — NO exemptions. Everyone pays.
 *
 * Gates premium API endpoints behind x402 micropayments (USDC on Base mainnet).
 * There is deliberately NO payment bypass in this middleware: the first-party
 * UI pays through the x402 client (public/frontend/x402.js) like any external
 * agent, and the Telegram bot never passes through here (in-worker processChat
 * calls + public /api/telegram/* routes). Operator authentication (sessions,
 * signature redemption) lives in middleware/operatorAuth.ts and has no effect
 * on payment — this split exists so the "authenticated users skip payment"
 * bug class cannot reappear.
 *
 * Pricing:
 *   POST /api/chat          → upto $0.20 USDC (actual cost billed; ~$0.01–$0.06 typical)
 *   GET  /api/quote         → exact $0.0020 USDC (DEX price quote)
 *   POST /api/quote/uniswap → exact $0.0021 USDC (Uniswap Trading API quote)
 *   GET  /api/quote/0x      → exact $0.0022 USDC (0x API quote)
 *   POST /api/oracle/refresh → exact $0.0023 USDC (oracle refresh tx builder)
 *   GET  /api/tools         → exact $0.0024 USDC (tool discovery)
 *   POST /api/tools         → exact $0.0025 USDC (direct tool invocation)
 *
 * The /api/chat endpoint uses the "upto" scheme — clients authorise up to $0.20
 * but are only charged the actual inference cost (determined by token usage).
 * The Settlement-Overrides response header carries the exact dollar amount back
 * to the facilitator. Callers never pay more than $0.20 per call.
 *
 * The hosted CDP facilitator verifies and settles everything, INCLUDING upto
 * (usage-based). Its /supported document is pinned in KV (services/cdpFacilitator.ts)
 * because CDP rotates the upto facilitatorAddress per call and each worker
 * isolate otherwise caches its own — unmatchable across isolates. With the pin,
 * every isolate signs and validates against the same address for 24h.
 *
 * Uses @x402/core SDK with ExactEvmScheme + UptoEvmScheme. Bazaar discovery
 * metadata is declared via @x402/extensions declareDiscoveryExtension.
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
import { pinSupportedInKv } from "../services/cdpFacilitator.js";
import { getToolX402Price, DEFAULT_TOOL_X402_PRICE } from "../llm/tools.js";
import { bazaarResourceServerExtension, declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { MiddlewareHandler, Context } from "hono";
import type { Env, AppVariables } from "../types.js";
// Auth (sessions, signature redemption) is handled by middleware/operatorAuth.ts.
// This middleware is payment-only by design.
import { isDevEscapeHatchEnabled } from "../services/devMode.js";

// ── Payment configuration ─────────────────────────────────────────────

/** Wallet receiving x402 payments (same EOA on all chains) */
export const PAY_TO = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

/** Base mainnet — USDC payments (CAIP-2) */
const BASE_NETWORK = "eip155:8453";

// ── Public API routes (free by design) ────────────────────────────────
// These /api/* routes are intentionally unprotected. All OTHER /api/* routes
// must be explicitly listed in getProtectedRoutes() or they are blocked (fail closed).
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
  { method: "GET", prefix: "/api/settings/" },
  // Billing: operator-scoped deposit status / payment signing / withdrawals.
  // Authenticated via operatorAuth middleware — NEVER a payment exemption.
  { method: "POST", prefix: "/api/billing/" },
  { method: "GET", prefix: "/api/billing/" },
];

export function isPublicApiRoute(method: string, path: string): boolean {
  if (PUBLIC_API_ROUTES.has(`${method} ${path}`)) return true;
  return PUBLIC_API_PREFIXES.some((p) => method === p.method && path.startsWith(p.prefix));
}

export function isProtectedRoute(method: string, path: string): boolean {
  return `${method} ${path}` in getProtectedRoutes();
}

/** Returns all HTTP methods for which a given path is registered in getProtectedRoutes(). */
function getProtectedMethodsForPath(path: string): string[] {
  return Object.keys(getProtectedRoutes())
    .filter((key) => key.endsWith(` ${path}`))
    .map((key) => key.split(" ")[0]);
}

// ── Protected route config (v2 format) ────────────────────────────────
// Every route here requires x402 payment. Prices for tool-backed routes are
// read from the tool definitions at module load — x402Price is the ONLY price
// source. Do not re-declare a different amount here or in settlement code.

function buildProtectedRoutes(): RoutesConfig {
  return {
  "POST /api/chat": {
    resource: "https://trader.rigoblock.com/api/chat",
    accepts: [
      {
        scheme: "upto",
        payTo: PAY_TO,
        price: "$0.20",
        network: BASE_NETWORK,
      },
    ],
    description:
      "AI-powered DeFi trading agent for Rigoblock smart vaults. Natural language to safe swap/bridge " +
      "calldata or delegated execution. Supports Uniswap, 0x, GMX perpetuals, Hyperliquid perpetuals, " +
      "Across bridging, Uniswap v4 LP, GRG staking, and pool deployment across 8 chains. Protected by NAV Shield " +
      "(10% max loss per trade), Swap Shield (oracle vs DEX price divergence check), slippage " +
      "protection, delegation verification, and transaction simulation.",
    mimeType: "application/json",
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "bridge", "lp", "staking", "perps", "hyperliquid"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    // Bazaar discovery extension: declared with the official SDK helper so
    // inputSchema is a real JSON Schema rather than a description map. The
    // bazaarResourceServerExtension enriches the HTTP method at request time.
    extensions: {
      // Allow the facilitator to sponsor the one-time USDC → Permit2 approval
      // via EIP-2612, so a freshly-funded deposit wallet needs no gas token.
      ...declareEip2612GasSponsoringExtension(),
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: {
          messages: [{ role: "user", content: "Swap 1 ETH for USDC on Base" }],
          vaultAddress: "0x0000000000000000000000000000000000000000",
          chainId: 8453,
          executionMode: "manual",
          confirmExecution: false,
          operatorAddress: "0x0000000000000000000000000000000000000000",
          authSignature: "0x",
          authTimestamp: 1741700000000,
        },
        inputSchema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              description: "Array of {role, content} chat messages",
              items: {
                type: "object",
                properties: { role: { type: "string" }, content: { type: "string" } },
                required: ["role", "content"],
              },
            },
            vaultAddress: {
              type: "string",
              description: "Rigoblock vault contract address (optional in manual mode)",
            },
            chainId: {
              type: "integer",
              description: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130)",
            },
            executionMode: {
              type: "string",
              enum: ["manual", "delegated"],
              description: "manual returns unsigned calldata; delegated can auto-execute",
            },
            confirmExecution: {
              type: "boolean",
              description: "Set true for auto-execute in delegated mode",
            },
            operatorAddress: {
              type: "string",
              description: "Vault owner wallet address (required for delegated execution)",
            },
            authSignature: {
              type: "string",
              description: "EIP-191 signature signed by operatorAddress",
            },
            authTimestamp: {
              type: "integer",
              description: "Unix timestamp when the auth message was signed",
            },
          },
          required: ["messages"],
        },
        output: {
          example: {
            reply: "I'll swap 1 ETH for USDC on Base via Uniswap",
            transaction: {
              to: "0xVaultAddress",
              data: "0xcalldata",
              value: "0x0",
              chainId: 8453,
            },
          },
          schema: {
            type: "object",
            properties: {
              reply: { type: "string" },
              transaction: { type: "object" },
              transactions: { type: "array" },
              executionResult: { type: "object" },
              executionResults: { type: "array" },
            },
          },
        },
      }),
    },
  },
  "GET /api/quote": {
    resource: "https://trader.rigoblock.com/api/quote",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: getToolX402Price("get_swap_quote"),
        network: BASE_NETWORK,
      },
    ],
    description:
      "DEX price quote across 7 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Unichain). " +
      "Returns sell/buy amounts, price, routing, and gas estimate.",
    mimeType: "application/json",
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "uniswap", "0x", "bridge", "lp", "staking"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          sell: "ETH",
          buy: "USDC",
          amount: "1",
          chain: "8453",
        },
        inputSchema: {
          type: "object",
          properties: {
            sell: {
              type: "string",
              description: "Token to sell (ETH, USDC, WBTC, or contract address)",
            },
            buy: {
              type: "string",
              description: "Token to buy (ETH, USDC, WBTC, or contract address)",
            },
            amount: {
              type: "string",
              description: "Amount to sell (human-readable, e.g. '1' for 1 ETH)",
            },
            chain: {
              type: "string",
              description: "Chain name or ID (e.g. 'base', '8453', 'arbitrum', '42161')",
            },
            vault: {
              type: "string",
              description: "Optional Rigoblock vault address for gas estimation",
            },
            slippage: {
              type: "string",
              description: "Optional slippage tolerance in basis points (e.g. '100' for 1%)",
            },
            operator: {
              type: "string",
              description: "Optional operator address for browser auth bypass",
            },
            sig: {
              type: "string",
              description: "Optional EIP-191 signature for browser auth bypass",
            },
            ts: {
              type: "string",
              description: "Optional signature timestamp for browser auth bypass",
            },
          },
          required: ["sell", "buy", "amount"],
        },
        output: {
          example: {
            sell: "1 ETH",
            buy: "2079.54 USDC",
            price: "1 ETH = 2079.54 USDC",
            routing: "CLASSIC",
            gasFeeUSD: "0.0024",
            gasLimit: "394000",
            chainId: 8453,
          },
          schema: {
            type: "object",
            properties: {
              sell: { type: "string" },
              buy: { type: "string" },
              price: { type: "string" },
              routing: { type: "string" },
              gasFeeUSD: { type: "string" },
              gasLimit: { type: "string" },
              chainId: { type: "integer" },
            },
          },
        },
      }),
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
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "uniswap", "0x", "bridge", "lp", "staking"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: {
          type: "EXACT_INPUT",
          amount: "1000000000000000000",
          tokenIn: "0x0000000000000000000000000000000000000000",
          tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          tokenInChainId: 8453,
          tokenOutChainId: 8453,
          swapper: "0x0000000000000000000000000000000000000000",
        },
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["EXACT_INPUT", "EXACT_OUTPUT"],
              description: "Quote type",
            },
            amount: {
              type: "string",
              description: "Amount in base units (e.g. '1000000000000000000')",
            },
            tokenIn: {
              type: "string",
              description: "Token to sell (address or symbol)",
            },
            tokenOut: {
              type: "string",
              description: "Token to buy (address or symbol)",
            },
            tokenInChainId: {
              type: "integer",
              description: "Chain ID for tokenIn (e.g. 8453)",
            },
            tokenOutChainId: {
              type: "integer",
              description: "Chain ID for tokenOut (e.g. 8453)",
            },
            swapper: {
              type: "string",
              description: "Swapper address (required by Uniswap Trading API)",
            },
          },
          required: [
            "type",
            "amount",
            "tokenIn",
            "tokenOut",
            "tokenInChainId",
            "tokenOutChainId",
            "swapper",
          ],
        },
        output: {
          example: {
            routing: "CLASSIC",
            priceFeedExists: true,
            deltaBps: 12,
            oracleAmount: "2079548076",
          },
          schema: {
            type: "object",
            properties: {
              routing: { type: "string" },
              priceFeedExists: { type: "boolean" },
              deltaBps: { type: "integer" },
              oracleAmount: { type: "string" },
            },
          },
        },
      }),
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
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "uniswap", "0x", "bridge", "lp", "staking"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          chainId: "8453",
          sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          buyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          sellAmount: "1000000000000000000",
          slippageBps: "100",
          taker: "0x0000000000000000000000000000000000000000",
        },
        inputSchema: {
          type: "object",
          properties: {
            chainId: {
              type: "string",
              description: "Chain ID (e.g. '8453')",
            },
            sellToken: {
              type: "string",
              description: "Token to sell (address or symbol)",
            },
            buyToken: {
              type: "string",
              description: "Token to buy (address or symbol)",
            },
            sellAmount: {
              type: "string",
              description: "Amount to sell in base units. Provide either sellAmount (exact-input) or buyAmount (exact-output).",
            },
            buyAmount: {
              type: "string",
              description: "Amount to buy in base units. Provide either sellAmount (exact-input) or buyAmount (exact-output).",
            },
            slippageBps: {
              type: "string",
              description: "Slippage tolerance in basis points (e.g. '100' for 1%)",
            },
            taker: {
              type: "string",
              description: "Address that will execute the swap",
            },
          },
          required: ["chainId", "sellToken", "buyToken"],
        },
        output: {
          example: {
            buyAmount: "2079548076",
            priceFeedExists: true,
            deltaBps: -8,
            oracleAmount: "2081500000",
          },
          schema: {
            type: "object",
            properties: {
              buyAmount: { type: "string" },
              priceFeedExists: { type: "boolean" },
              deltaBps: { type: "integer" },
              oracleAmount: { type: "string" },
            },
          },
        },
      }),
    },
  },
  "POST /api/oracle/refresh": {
    resource: "https://trader.rigoblock.com/api/oracle/refresh",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: getToolX402Price("refresh_oracle_feed"),
        network: BASE_NETWORK,
      },
    ],
    description:
      "Build an unsigned operator EOA transaction that swaps ETH on the on-chain oracle's " +
      "dedicated Uniswap V4 pool to create a fresh price observation and fix a stale TWAP feed. " +
      "Use when the Swap Shield blocks a trade due to oracle price divergence.",
    mimeType: "application/json",
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "uniswap", "0x", "bridge", "lp", "staking"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: {
          token: "GRG",
          tokenIn: "ETH",
          tokenOut: "GRG",
          amount: "0.001",
          chainId: 8453,
        },
        inputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "ERC-20 token symbol or address whose oracle feed is stale. Never the native token.",
            },
            tokenIn: {
              type: "string",
              description: "Token the trader pays: the chain native token (ETH/POL/BNB) or the ERC-20 'token'.",
            },
            tokenOut: {
              type: "string",
              description: "Token the trader receives: the chain native token (ETH/POL/BNB) or the ERC-20 'token'.",
            },
            amount: {
              type: "string",
              description: "Exact INPUT amount in tokenIn units (e.g. '0.001'). Required; no default.",
            },
            chainId: {
              type: "integer",
              description: "EVM chain ID where the oracle pool lives (e.g. 42161, 8453)",
            },
          },
          required: ["token", "tokenIn", "tokenOut", "amount", "chainId"],
        },
        output: {
          example: {
            transaction: {
              to: "0xUniversalRouter",
              data: "0xcalldata",
              value: "0x38d7ea4c68000",
              chainId: 42161,
              gas: "0x61a80",
              description: "Oracle pool refresh: swap ETH → GRG on BackgeoOracle V4 pool",
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
          schema: {
            type: "object",
            properties: {
              transaction: { type: "object" },
              poolInfo: { type: "object" },
            },
          },
        },
      }),
    },
  },
  "GET /api/tools": {
    resource: "https://trader.rigoblock.com/api/tools",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: getToolX402Price("get_tool_menu"),
        network: BASE_NETWORK,
      },
    ],
    description:
      "Rigoblock DeFi tool discovery. Returns the full catalog with JSON schemas, categories, " +
      "and access requirements for all direct-invocation tools.",
    mimeType: "application/json",
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "uniswap", "0x", "bridge", "lp", "staking"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    extensions: {
      ...declareDiscoveryExtension({
        input: {},
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        output: {
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
          schema: {
            type: "object",
            properties: {
              toolCount: { type: "integer" },
              tools: { type: "array" },
            },
          },
        },
      }),
    },
  },
  "POST /api/tools": {
    resource: "https://trader.rigoblock.com/api/tools",
    accepts: [
      {
        scheme: "exact",
        payTo: PAY_TO,
        price: DEFAULT_TOOL_X402_PRICE,
        network: BASE_NETWORK,
      },
    ],
    description:
      "Rigoblock direct DeFi tool invocation. POST to /api/tools?toolName={name} with arguments object.",
    mimeType: "application/json",
    serviceName: "Rigoblock",
    tags: ["defi", "trading", "rigoblock", "vault", "swap", "uniswap", "0x", "bridge", "lp", "staking"],
    iconUrl: "https://trader.rigoblock.com/favicon.png",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: {
          toolName: "get_swap_quote",
          arguments: { tokenIn: "ETH", tokenOut: "USDC", amountIn: "1" },
          chainId: 8453,
          vaultAddress: "0x0000000000000000000000000000000000000000",
        },
        inputSchema: {
          type: "object",
          properties: {
            toolName: {
              type: "string",
              description: "Tool name (e.g. get_swap_quote, get_vault_info, build_vault_swap)",
            },
            arguments: {
              type: "object",
              description: "Tool arguments object",
            },
            chainId: {
              type: "integer",
              description: "EVM chain ID (1, 42161, 8453, 137, 10, 56, 130)",
            },
            vaultAddress: {
              type: "string",
              description: "Rigoblock vault address, optional",
            },
            operatorAddress: {
              type: "string",
              description: "Vault owner wallet address, optional",
            },
            authSignature: {
              type: "string",
              description: "EIP-191 signature signed by operatorAddress, optional",
            },
            authTimestamp: {
              type: "integer",
              description: "Unix timestamp when the auth message was signed, optional",
            },
            executionMode: {
              type: "string",
              enum: ["manual", "delegated"],
              description: "manual returns unsigned calldata; delegated can auto-execute",
            },
            confirmExecution: {
              type: "boolean",
              description: "Set true for auto-execute in delegated mode",
            },
          },
          required: ["toolName", "arguments", "chainId"],
        },
        output: {
          example: {
            tool: "get_swap_quote",
            message: "Quote for 1 ETH → 2079.54 USDC",
            result: {
              sell: "1 ETH",
              buy: "2079.54 USDC",
              price: "1 ETH = 2079.54 USDC",
              chainId: 8453,
            },
          },
          schema: {
            type: "object",
            properties: {
              tool: { type: "string" },
              message: { type: "string" },
              result: { type: "object" },
              transaction: { type: "object" },
              executionResult: { type: "object" },
              chainSwitch: { type: "object" },
              suggestions: { type: "array" },
              metadata: { type: "object" },
            },
          },
        },
      }),
    },
  },
  };
}

let protectedRoutesCache: RoutesConfig | undefined;

/** Derived from the tool definitions — the single pricing registry. */
export function getProtectedRoutes(): RoutesConfig {
  if (!protectedRoutesCache) protectedRoutesCache = buildProtectedRoutes();
  return protectedRoutesCache;
}

// ── Build x402 v2 server (lazy-initialized) ───────────────────────────

let httpServer: x402HTTPResourceServer | null = null;
let initPromise: Promise<void> | null = null;

function buildHttpServer(env: Env): x402HTTPResourceServer {
  // CDP facilitator (Base mainnet — USDC payments) with its /supported
  // document pinned in KV: every isolate sees the same upto facilitatorAddress,
  // so deposit-signed payments validate in any isolate while verification and
  // settlement stay with the hosted facilitator.
  const facilitatorConfig = createFacilitatorConfig(
    env.CDP_API_KEY_ID,
    env.CDP_API_KEY_SECRET,
  );
  const cdpFacilitator = pinSupportedInKv(
    env.KV,
    new HTTPFacilitatorClient(facilitatorConfig) as any,
  );

  const resourceServer = new x402ResourceServer([cdpFacilitator])
    .register(BASE_NETWORK, new ExactEvmScheme())
    .register(BASE_NETWORK, new UptoEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const server = new x402HTTPResourceServer(resourceServer, getProtectedRoutes());
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

/**
 * Build the EXACT payment requirements the x402 gate will validate a payment
 * against for a protected route — same singleton server, same requirement
 * pipeline (normalizePaymentOptions → buildPaymentRequirementsFromOptions →
 * createPaymentRequiredResponse with scheme enrichment).
 *
 * Used by the billing service to sign deposit payments: the signed payload
 * (incl. facilitator metadata) is derived from these requirements, so a
 * deposit-signed payment always matches what findMatchingRequirements checks.
 * Never trusts client-supplied terms.
 */
export async function getRoutePaymentRequirements(
  env: Env,
  method: string,
  pathname: string,
): Promise<{
  accepts: Array<Record<string, unknown>>;
  resource: Record<string, unknown>;
  extensions: Record<string, unknown>;
}> {
  const server = (await getHttpServer(env)) as any;
  const routeMatch = server.getRouteConfig(pathname, method);
  if (!routeMatch) {
    throw Object.assign(new Error(`${method} ${pathname} is not a paid route`), { code: "unknown_route" });
  }
  const { config: routeConfig } = routeMatch;
  const context = {
    method,
    path: pathname,
    adapter: {
      getHeader: () => undefined,
      getMethod: () => method,
      getPath: () => pathname,
      getUrl: () => `https://trader.rigoblock.com${pathname}`,
      getAcceptHeader: () => "",
      getUserAgent: () => "rigoblock-billing",
      getQueryParams: () => ({}),
      getQueryParam: () => undefined,
    },
  };
  const paymentOptions = server.normalizePaymentOptions(routeConfig);
  const requirements = await server.ResourceServer.buildPaymentRequirementsFromOptions(
    paymentOptions,
    context,
  );
  // Must match the resourceInfo used by processHTTPRequest exactly — the
  // payment payload echoes this object, and any missing fields fail the
  // facilitator's echo validation.
  const resourceInfo = {
    url: routeConfig.resource || context.adapter.getUrl(),
    description: routeConfig.description || "",
    mimeType: routeConfig.mimeType || "",
    ...(routeConfig.serviceName !== undefined && { serviceName: routeConfig.serviceName }),
    ...(routeConfig.tags !== undefined && { tags: routeConfig.tags }),
    ...(routeConfig.iconUrl !== undefined && { iconUrl: routeConfig.iconUrl }),
  };
  let extensions = routeConfig.extensions;
  if (extensions) {
    extensions = server.ResourceServer.enrichExtensions(extensions, context);
  }
  const paymentRequired = await server.ResourceServer.createPaymentRequiredResponse(
    requirements,
    resourceInfo,
    undefined,
    extensions,
    { request: context },
  );
  return {
    accepts: paymentRequired.accepts as Array<Record<string, unknown>>,
    resource: paymentRequired.resource as Record<string, unknown>,
    extensions: (paymentRequired.extensions || {}) as Record<string, unknown>,
  };
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

/**
 * Fail-closed helper for payment-verification outages.
 *
 * Paid endpoints must never be served for free just because payment cannot be
 * VERIFIED (missing CDP credentials, facilitator unreachable, processing error).
 * For routes in getProtectedRoutes() this returns a 503; public routes are
 * unaffected. X402_RELAXED=1 restores the old fail-open behavior, but only
 * together with APP_ENV=development — the gate in devMode.ts cannot be
 * bypassed by the flag alone.
 *
 * Returns null when the request may proceed (non-protected route or relaxed mode).
 */
function blockIfPaymentUnverifiable(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  method: string,
  path: string,
  reason: string,
): Response | null {
  if (!isProtectedRoute(method, path)) return null; // public/unlisted routes — let through
  if (isDevEscapeHatchEnabled("X402_RELAXED", c.env)) {
    console.warn(`[x402] APP_ENV=development + X402_RELAXED=1 — allowing ${method} ${path} despite ${reason}`);
    return null;
  }
  console.error(`[x402] Payment cannot be verified (${reason}) — failing closed for ${method} ${path}`);
  return c.json(
    {
      error: "Payment verification unavailable",
      detail:
        `This endpoint requires x402 payment, but payment could not be verified: ${reason}. ` +
        "Please retry later.",
    },
    503,
  );
}

export function createX402Middleware(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    // Fast path: discovery/health routes and public API routes don't need x402 at all.
    const reqPath = new URL(c.req.url).pathname;
    const reqMethod = c.req.method;
    if (reqPath.startsWith("/.well-known/") || isPublicApiRoute(reqMethod, reqPath)) {
      return next();
    }

    // Skip x402 when CDP credentials are missing or clearly invalid (test/dev envs).
    // FAIL CLOSED for paid endpoints: without credentials payment cannot be
    // verified, so PROTECTED_ROUTES return 503 rather than being served for free.
    // X402_RELAXED=1 (with APP_ENV=development) restores fail-open behavior
    // for local development only.
    const hasCdpCreds =
      typeof c.env.CDP_API_KEY_ID === "string" && c.env.CDP_API_KEY_ID.length > 0 &&
      typeof c.env.CDP_API_KEY_SECRET === "string" && c.env.CDP_API_KEY_SECRET.length > 0;
    if (!hasCdpCreds) {
      const blocked = blockIfPaymentUnverifiable(c, reqMethod, reqPath, "missing CDP facilitator credentials");
      if (blocked) return blocked;
      return next();
    }

    let server: x402HTTPResourceServer;
    try {
      server = await getHttpServer(c.env);
    } catch (err) {
      // x402 server init failed (facilitator unreachable, bad credentials, etc.).
      // Fail closed for paid endpoints — an outage must not make them free.
      // Suppress noisy logs in test environments (Vitest).
      const isTest = typeof process !== "undefined" && (process.env?.VITEST || process.env?.NODE_ENV === "test");
      if (!isTest) {
        console.error("[x402] Server initialization failed:", err);
      }
      const blocked = blockIfPaymentUnverifiable(c, reqMethod, reqPath, "facilitator initialization failed");
      if (blocked) return blocked;
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
      // Payment processing failed — fail closed for paid endpoints so an outage
      // cannot be leveraged to reach them without paying.
      console.error("[x402] processHTTPRequest failed:", err);
      const blocked = blockIfPaymentUnverifiable(
        c, adapter.getMethod(), adapter.getPath(), "payment processing error");
      if (blocked) return blocked;
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
        // Some discovery validators (e.g., agentic.market) probe POST endpoints with
        // GET requests. If the path is registered under a different method, re-process
        // using the registered method so the probe still gets a 402 instead of 503.
        const protectedMethods = getProtectedMethodsForPath(path);
        if (protectedMethods.length > 0 && !protectedMethods.includes(method)) {
          const registeredMethod = protectedMethods[0];
          const fallbackAdapter: HTTPAdapter = {
            ...adapter,
            getMethod: () => registeredMethod,
          };
          const fallbackContext: HTTPRequestContext = {
            adapter: fallbackAdapter,
            path: fallbackAdapter.getPath(),
            method: registeredMethod,
            paymentHeader: fallbackAdapter.getHeader("x-payment"),
          };
          try {
            const fallbackResult = await server.processHTTPRequest(fallbackContext);
            if (fallbackResult.type === "payment-error") {
              result = fallbackResult;
            } else {
              return next();
            }
          } catch (err) {
            console.error("[x402] method fallback processing failed:", err);
            return next();
          }
        } else {
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
      } else {
        return next();
      }
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
    // with the actual inference cost, which the SDK resolves into the requirements
    // amount before invoking the (local) facilitator's settle.
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
