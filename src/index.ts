/**
 * Agentic Operator — Cloudflare Worker Entry Point
 *
 * AI-powered trading assistant for Rigoblock vaults.
 * The agent builds unsigned transactions; the operator signs from their wallet.
 *
 * Routes:
 *   GET  /                → Chat UI (static HTML)
 *   POST /api/chat        → LLM chat with tool calling (returns unsigned txs)
 *   GET  /api/quote       → Direct Uniswap quote (no LLM)
 *   GET  /api/chains      → Supported chains list
 *   GET  /api/health      → Health check
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { chat } from "./routes/chat.js";
import { quote } from "./routes/quote.js";
import { delegation } from "./routes/delegation.js";
import { gasPolicy } from "./routes/gasPolicy.js";
import { telegram } from "./routes/telegram.js";
import { tools as toolsRoute } from "./routes/tools.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "./config.js";
import { initTokenResolver } from "./services/tokenResolver.js";
import { getVaultInfo } from "./services/vault.js";
import { createX402Middleware } from "./middleware/x402.js";
import { runAllSkills } from "./skills/index.js";
import { getTwapEvents } from "./skills/twap.js";
import { processChat } from "./llm/client.js";
import { ensureWebhookRegistered, getWebhookSecret } from "./services/telegram.js";
import type { Address } from "viem";

const app = new Hono<{ Bindings: Env }>();

// ── Middleware ─────────────────────────────────────────────────────────
app.use("*", cors());

// Initialise token resolver KV on every request
app.use("*", async (c, next) => {
  if (c.env.KV) initTokenResolver(c.env.KV);
  await next();
});

// x402 payment gate — charges external agents for /api/chat and /api/quote.
// Own-user requests (browser UI, Telegram webhook) are exempt.
app.use("*", createX402Middleware());

// ── API Routes ────────────────────────────────────────────────────────
app.route("/api/chat", chat);
app.route("/api/quote", quote);
app.route("/api/tools", toolsRoute);
app.route("/api/delegation", delegation);
app.route("/api/gas-policy", gasPolicy);
app.route("/api/telegram", telegram);

// ── Vault info (no auth, no LLM — simple on-chain read) ──────────────
// Tries the requested chain first, then all other supported chains.
app.get("/api/vault", async (c) => {
  const address = c.req.query("address");
  const preferredChain = Number(c.req.query("chain") || "1");
  if (!address || address.length !== 42) {
    return c.json({ error: "address query param required (0x…)" }, 400);
  }

  try {
    // Fast path: try the requested chain
    try {
      const info = await getVaultInfo(preferredChain, address as Address, c.env.ALCHEMY_API_KEY);
      return c.json({ ...info, chainId: preferredChain });
    } catch {
      // Not found on this chain — try all others in parallel
    }

    const otherChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS].filter(
      (ch) => ch.id !== preferredChain,
    );
    const results = await Promise.allSettled(
      otherChains.map(async (ch) => {
        const info = await getVaultInfo(ch.id, address as Address, c.env.ALCHEMY_API_KEY);
        return { ...info, chainId: ch.id };
      }),
    );
    const found = results.find((r) => r.status === "fulfilled");
    if (found && found.status === "fulfilled") {
      return c.json(found.value);
    }

    return c.json({ error: "Not a valid Rigoblock vault on any supported chain" }, 404);
  } catch (err) {
    console.error("[vault] Error:", err);
    return c.json({ error: "Failed to fetch vault info" }, 500);
  }
});

// ── Supported chains ──────────────────────────────────────────────────
app.get("/api/chains", (c) => {
  const includeTestnet = c.req.query("testnet") === "true";
  const chains = includeTestnet
    ? [...SUPPORTED_CHAINS, ...TESTNET_CHAINS]
    : SUPPORTED_CHAINS;
  return c.json({ chains });
});

// ── Strategy events (polling endpoint for web chat notifications) ──
app.get("/api/strategy-events", async (c) => {
  const vault = c.req.query("vault");
  if (!vault || vault.length !== 42) {
    return c.json({ error: "vault query param required (0x…)" }, 400);
  }
  const since = Number(c.req.query("since") || "0");
  const twapEvents = await getTwapEvents(c.env.KV, vault, since || undefined);

  const normalizedTwapEvents = twapEvents.map((e) => ({
    type: "twap" as const,
    timestamp: e.timestamp,
    success: e.success,
    twapOrderId: e.orderId,
    summary: e.success
      ? `Slice ${e.sliceNumber}/${e.totalSlices}: ${e.sellAmount} → ${e.buyAmount}`
      : `Slice ${e.sliceNumber}/${e.totalSlices} failed: ${e.error || "unknown error"}`,
  }));

  const events = normalizedTwapEvents.sort((a, b) => a.timestamp - b.timestamp);

  return c.json({ events });
});

// ── Health check ──────────────────────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    version: "0.7.0",
    features: [
      "manual-execution",
      "vault-delegation",
      "tx-simulation",
      "tx-monitoring",
      "x402-payments",
      "automated-strategies",
    ],
    x402: {
      accepts: [
        {
          network: "eip155:8453",
          token: "USDC",
          facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
        },
      ],
      payTo: "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
      paidRoutes: {
        "POST /api/chat": "$0.01",
        "GET /api/quote": "$0.002",
        "POST /api/tools/*": "$0.002",
      },
    },
  }),
);

// ── Agent discovery ───────────────────────────────────────────────────

// GET /api — returns 402 so x402 scanners detect our payment-gated API.
// Describes available paid endpoints; any agent can use this as an entry point.
app.get("/api", (c) => {
  c.header(
    "PAYMENT-REQUIRED",
    Buffer.from(
      JSON.stringify({
        x402Version: 2,
        error: "Payment required to access this API",
        resource: { url: "https://trader.rigoblock.com/api", description: "Rigoblock Agentic Operator API", mimeType: "application/json" },
        accepts: [
          { scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xA0F9C380ad1E1be09046319fd907335B2B452B37", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
        ],
      }),
    ).toString("base64"),
  );
  return c.json(
    {
      x402Version: 2,
      error: "Payment required",
      description:
        "Rigoblock Agentic Operator — AI-powered DeFi trading for smart vaults. " +
        "Pay per request in USDC on Base. See /.well-known/x402.json for endpoint list.",
      discoveryUrl: "https://trader.rigoblock.com/.well-known/x402.json",
      openApiUrl: "https://trader.rigoblock.com/openapi.json",
      endpoints: {
        "POST /api/chat": { price: "$0.01", description: "Natural language DeFi agent — swap/bridge/LP/stake calldata" },
        "GET /api/quote": { price: "$0.002", description: "DEX price quote across 7 chains" },
        "POST /api/tools/{toolName}": { price: "$0.002", description: "Direct tool invocation — structured input/output" },
      },
      accepts: [
        { scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xA0F9C380ad1E1be09046319fd907335B2B452B37", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
      ],
    },
    402,
  );
});

// Homepage — serves index.html with Link headers for RFC 8288 agent discovery.
// The [assets] binding would serve it silently without headers; we intercept
// here so agents receive machine-readable API pointers on every page load.
app.get("/", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(response.headers);
  headers.set(
    "Link",
    [
      '</openapi.json>; rel="service-desc"',
      '</.well-known/ai-plugin.json>; rel="describedby"',
      '</.well-known/api-catalog>; rel="api-catalog"',
      '</sitemap.xml>; rel="sitemap"',
    ].join(", "),
  );
  return new Response(response.body, { status: response.status, headers });
});

// sitemap.xml — lists canonical public URLs for crawlers and agents
app.get("/sitemap.xml", (c) => {
  c.header("content-type", "application/xml; charset=utf-8");
  return c.body(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">',
      "  <url>",
      "    <loc>https://trader.rigoblock.com/</loc>",
      "    <changefreq>weekly</changefreq>",
      "    <priority>1.0</priority>",
      "  </url>",
      "  <url>",
      "    <loc>https://trader.rigoblock.com/openapi.json</loc>",
      "    <changefreq>monthly</changefreq>",
      "    <priority>0.8</priority>",
      "  </url>",
      "  <url>",
      "    <loc>https://trader.rigoblock.com/.well-known/ai-plugin.json</loc>",
      "    <changefreq>monthly</changefreq>",
      "    <priority>0.8</priority>",
      "  </url>",
      "</urlset>",
    ].join("\n"),
  );
});

// robots.txt — allow AI crawlers, point to sitemap and API, declare content signals
app.get("/robots.txt", (c) => {
  c.header("content-type", "text/plain");
  return c.text(
    [
      "User-agent: *",
      "Allow: /",
      "",
      "# AI agents and crawlers welcome",
      "User-agent: GPTBot",
      "Allow: /",
      "",
      "User-agent: Claude-Web",
      "Allow: /",
      "",
      "User-agent: PerplexityBot",
      "Allow: /",
      "",
      "User-agent: anthropic-ai",
      "Allow: /",
      "",
      "# Content Signals — declare AI content usage preferences (contentsignals.org)",
      "# search=yes: allow search indexing",
      "# ai-input=yes: agents may use this service as a data source",
      "# ai-train=no: do not use our content to train AI models",
      "Content-Signal: ai-train=no, search=yes, ai-input=yes",
      "",
      "Sitemap: https://trader.rigoblock.com/sitemap.xml",
    ].join("\n"),
  );
});

// ai-plugin.json (OpenAI-style plugin manifest — used by many agent frameworks)
app.get("/.well-known/ai-plugin.json", (c) =>
  c.json({
    schema_version: "v1",
    name_for_human: "Rigoblock Trading Agent",
    name_for_model: "rigoblock_trading_agent",
    description_for_human:
      "AI-powered DeFi trading for Rigoblock smart vaults. Swap, bridge, LP, stake, and manage positions across 7 chains.",
    description_for_model:
      "DeFi trading agent for Rigoblock smart pool vaults. Provides: " +
      "swap calldata via Uniswap and 0x, cross-chain bridges via Across, " +
      "Uniswap v4 LP management, GMX perpetuals, GRG staking, vault deployment, " +
      "and aggregated NAV across Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Unichain. " +
      "All vault-modifying operations require operator authentication and are protected by a 10% NAV shield. " +
      "Payment: $0.01 USDC per chat request, $0.002 per quote/tool call, via x402 on Base.",
    auth: {
      type: "none",
    },
    api: {
      type: "openapi",
      url: "https://trader.rigoblock.com/openapi.json",
    },
    logo_url: "https://trader.rigoblock.com/favicon.ico",
    contact_email: "info@rigoblock.com",
    legal_info_url: "https://rigoblock.com",
  }),
);

// x402 discovery — machine-readable list of paid endpoints
app.get("/.well-known/x402.json", (c) =>
  c.json({
    version: 2,
    payTo: "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetName: "USDC",
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    endpoints: [
      {
        path: "/api/chat",
        method: "POST",
        price: "$0.01",
        description: "AI-powered DeFi chat — natural language to swap/bridge/LP calldata",
      },
      {
        path: "/api/quote",
        method: "GET",
        price: "$0.002",
        description: "DEX price quote across 7 chains (Uniswap + 0x aggregator)",
      },
      {
        path: "/api/tools/{toolName}",
        method: "POST",
        price: "$0.002",
        description: "Direct tool invocation without LLM — get_swap_quote, get_vault_info, build_vault_swap, etc.",
      },
    ],
  }),
);

// api-catalog — RFC 9727 / RFC 9264 linkset format (Content-Type: application/linkset+json)
app.get("/.well-known/api-catalog", (c) => {
  c.header("content-type", "application/linkset+json");
  return c.json({
    linkset: [
      {
        anchor: "https://trader.rigoblock.com",
        "service-desc": [
          { href: "https://trader.rigoblock.com/openapi.json", type: "application/openapi+json" },
        ],
        "service-doc": [
          { href: "https://github.com/rigoblock/agentic-operator/blob/main/AGENTS.md" },
        ],
        describedby: [
          { href: "https://trader.rigoblock.com/.well-known/ai-plugin.json", type: "application/json" },
        ],
      },
      {
        anchor: "https://trader.rigoblock.com/api/chat",
        "service-desc": [
          { href: "https://trader.rigoblock.com/openapi.json" },
        ],
        type: [{ href: "https://trader.rigoblock.com/.well-known/x402.json" }],
      },
      {
        anchor: "https://trader.rigoblock.com/api/quote",
        "service-desc": [
          { href: "https://trader.rigoblock.com/openapi.json" },
        ],
      },
      {
        anchor: "https://trader.rigoblock.com/api/tools",
        "service-desc": [
          { href: "https://trader.rigoblock.com/openapi.json" },
        ],
      },
    ],
  });
});

// MCP Server Card — minimal card for MCP-compatible agent discovery
app.get("/.well-known/mcp/server-card.json", (c) =>
  c.json({
    serverInfo: {
      name: "Rigoblock Trading Agent",
      version: "0.7.0",
      description:
        "AI-powered DeFi trading for Rigoblock smart vaults. Swap, bridge, LP, stake, and manage positions across 7 chains.",
    },
    transport: {
      endpoint: "https://trader.rigoblock.com/api/chat",
      protocol: "http",
    },
    capabilities: ["tools"],
    payment: {
      scheme: "x402",
      network: "eip155:8453",
      price: "$0.01 USDC per request",
    },
  }),
);

// OAuth Protected Resource metadata (RFC 9728) — describes how to authenticate.
// Note: this service uses x402 (USDC micropayments) instead of OAuth bearer tokens.
// This stub exists for agent compatibility frameworks that probe /.well-known/oauth-protected-resource.
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: "https://trader.rigoblock.com",
    authorization_servers: [],
    bearer_methods_supported: [],
    resource_documentation: "https://trader.rigoblock.com/.well-known/ai-plugin.json",
    resource_policy_uri: "https://trader.rigoblock.com/.well-known/x402.json",
    x402: {
      description:
        "This resource uses x402 micropayments (USDC on Base) instead of OAuth bearer tokens.",
      discovery_url: "https://trader.rigoblock.com/.well-known/x402.json",
    },
  }),
);

// OAuth 2.0 Authorization Server Metadata (RFC 8414) — discovery stub for agent frameworks.
// This service does NOT use OAuth bearer tokens; it uses x402 micropayments.
// Returning a valid RFC 8414 document prevents 404s from confusing agent frameworks
// that probe this endpoint before deciding how to authenticate. The document
// accurately describes the available grant types (none, since payment is via x402).
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: "https://trader.rigoblock.com",
    authorization_endpoint: "https://trader.rigoblock.com/.well-known/oauth-authorization-server",
    token_endpoint: "https://trader.rigoblock.com/.well-known/oauth-authorization-server",
    jwks_uri: "https://trader.rigoblock.com/.well-known/oauth-authorization-server",
    grant_types_supported: [],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: [],
    scopes_supported: [],
    x402: {
      description:
        "This service uses x402 micropayments (USDC on Base) instead of OAuth. " +
        "See /.well-known/x402.json for endpoint pricing and payment instructions.",
      discovery_url: "https://trader.rigoblock.com/.well-known/x402.json",
    },
  }),
);

// OpenID Connect Discovery (OIDC Core 1.0 §4) — discovery stub for agent frameworks.
// Same rationale as oauth-authorization-server above: valid JSON prevents 404 confusion.
app.get("/.well-known/openid-configuration", (c) =>
  c.json({
    issuer: "https://trader.rigoblock.com",
    authorization_endpoint: "https://trader.rigoblock.com/.well-known/openid-configuration",
    token_endpoint: "https://trader.rigoblock.com/.well-known/openid-configuration",
    jwks_uri: "https://trader.rigoblock.com/.well-known/openid-configuration",
    response_types_supported: [],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [],
    grant_types_supported: [],
    x402: {
      description:
        "This service uses x402 micropayments (USDC on Base) instead of OpenID Connect. " +
        "See /.well-known/x402.json for endpoint pricing and payment instructions.",
      discovery_url: "https://trader.rigoblock.com/.well-known/x402.json",
    },
  }),
);

// Agent Skills Discovery index (RFC v0.2.0) — machine-readable list of reusable agent skills.
// See https://github.com/cloudflare/agent-skills-discovery-rfc
app.get("/.well-known/agent-skills/index.json", (c) =>
  c.json({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "rigoblock-trading",
        type: "skill-md",
        description:
          "DeFi trading skill for Rigoblock smart vaults: swaps, bridges, LP, staking, NAV queries " +
          "across Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, and Unichain via x402 payments.",
        url: "https://trader.rigoblock.com/rigoblock-skill/SKILL.md",
        digest:
          "sha256:acc3fd047093b12c5e16860b5f3ae15d457c0a8b041151ac80170d23730aec75",
      },
    ],
  }),
);

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    // Re-register the Telegram webhook every cron run so it stays in sync with
    // the current CDP_WALLET_SECRET. This self-heals broken webhook registrations
    // without any manual operator action.
    const telegramRefresh = env.TELEGRAM_BOT_TOKEN
      ? (async () => {
          const secret = await getWebhookSecret(env);
          return ensureWebhookRegistered(env.TELEGRAM_BOT_TOKEN!, env.KV, secret);
        })().catch(err => console.warn("[cron] Telegram webhook refresh failed:", err))
      : Promise.resolve();

    ctx.waitUntil(Promise.all([
      runAllSkills(env, processChat),
      telegramRefresh,
    ]));
  },
};
