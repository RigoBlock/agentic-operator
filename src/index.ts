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
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "./config.js";
import { initTokenResolver } from "./services/tokenResolver.js";
import { getVaultInfo } from "./services/vault.js";
import { createX402Middleware } from "./middleware/x402.js";
import { runDueStrategies } from "./services/strategy.js";
import { getStrategyEvents } from "./services/strategy.js";
import { processChat } from "./llm/client.js";
import { ensureWebhookRegistered, deriveWebhookSecret } from "./services/telegram.js";
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
  const events = await getStrategyEvents(c.env.KV, vault, since || undefined);
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
      },
    },
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
          const secret = env.CDP_WALLET_SECRET
            ? await deriveWebhookSecret(env.CDP_WALLET_SECRET)
            : undefined;
          return ensureWebhookRegistered(env.TELEGRAM_BOT_TOKEN!, env.KV, secret);
        })().catch(err => console.warn("[cron] Telegram webhook refresh failed:", err))
      : Promise.resolve();

    ctx.waitUntil(Promise.all([
      runDueStrategies(env, processChat),
      telegramRefresh,
    ]));
  },
};
