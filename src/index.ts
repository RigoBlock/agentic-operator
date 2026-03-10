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
import type { Address } from "viem";

const app = new Hono<{ Bindings: Env }>();

// ── Middleware ─────────────────────────────────────────────────────────
app.use("*", cors());

// Initialise token resolver KV on every request
app.use("*", async (c, next) => {
  if (c.env.KV) initTokenResolver(c.env.KV);
  await next();
});

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
});

// ── Supported chains ──────────────────────────────────────────────────
app.get("/api/chains", (c) => {
  const includeTestnet = c.req.query("testnet") === "true";
  const chains = includeTestnet
    ? [...SUPPORTED_CHAINS, ...TESTNET_CHAINS]
    : SUPPORTED_CHAINS;
  return c.json({ chains });
});

// ── Health check ──────────────────────────────────────────────────────
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    version: "0.3.2",
    features: ["manual-execution", "vault-delegation", "tx-simulation", "tx-monitoring"],
  }),
);

export default app;
