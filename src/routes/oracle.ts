/**
 * Oracle route — build a BackgeoOracle pool refresh transaction without LLM.
 *
 * POST /api/oracle/refresh
 *
 * Body (JSON):
 *   token        string   — ERC-20 symbol or address whose oracle feed is stale (e.g. "GRG", "USDC")
 *   amount       string|number — Amount to swap (human-readable). Default is "0.001" for both directions (small enough to not matter financially, large enough to create a price observation).
 *   direction    string   — "buy" (native → token, default) or "sell" (token → native).
 *   chainId      number   — Chain where the oracle pool lives
 *   vaultAddress string   — Optional. If provided, routes through the vault adapter (value=0, supports delegation).
 *                           Omit for EOA path (direct to Universal Router).
 *
 * Returns an unsigned transaction in one of two forms:
 * - EOA path (default, no vaultAddress): operator signs with personal wallet; targets Universal Router directly.
 * - Vault path (vaultAddress provided): routes through the vault adapter (value=0, supports delegation).
 *
 * Auth: x402 payment OR authenticated browser session.
 */

import { Hono } from "hono";
import { parseUnits, isAddress, type Address } from "viem";
import type { Env, AppVariables } from "../types.js";
import { buildOraclePoolSwapTx } from "../services/oraclePool.js";
import { sanitizeError, resolveChainId } from "../config.js";

export const oracle = new Hono<{ Bindings: Env; Variables: AppVariables }>();

oracle.post("/refresh", async (c) => {
  // Auth gate — requires x402 payment OR authenticated browser session.
  if (!c.get("x402Paid") && !c.get("browserVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or a verified browser session." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  // Accept numeric amountEth (e.g. 0.001 from JSON) by coercing to string.
  // Use toFixed(18) for numbers instead of String() to avoid scientific-notation
  // output (e.g. String(0.0000001) → "1e-7") which parseUnits rejects.
  const rawDirection =
    body.direction === undefined
      ? "buy"
      : typeof body.direction === "string"
        ? body.direction.trim().toLowerCase()
        : null;
  if (rawDirection !== "buy" && rawDirection !== "sell") {
    return c.json({ error: "direction must be 'buy' or 'sell'" }, 400);
  }
  const direction = rawDirection as "buy" | "sell";
  let amount =
    typeof body.amount === "string"
      ? body.amount.trim()
      : typeof body.amount === "number"
        ? body.amount.toFixed(18)
        : typeof body.amountEth === "string"
          ? body.amountEth.trim()
          : typeof body.amountEth === "number"
            ? body.amountEth.toFixed(18)
            : "";
  const rawVault = body.vaultAddress;
  const rawChain = body.chainId ?? body.chain;

  if (!token) {
    return c.json(
      { error: "Missing required field: token (ERC-20 symbol or address, e.g. 'GRG' or 'USDC')" },
      400,
    );
  }
  if (!rawChain) {
    return c.json(
      { error: "Missing required field: chainId (e.g. 42161 for Arbitrum, 8453 for Base)" },
      400,
    );
  }

  let chainId: number;
  try {
    chainId = resolveChainId(String(rawChain));
  } catch {
    return c.json(
      {
        error: `Unknown chain: ${rawChain}`,
        supported: "ethereum (1), optimism (10), bsc (56), unichain (130), polygon (137), base (8453), arbitrum (42161)",
      },
      400,
    );
  }

  // Default amount: 0.001 units is small enough to be financially insignificant for
  // every token (0.001 ETH ≈ $2–6, 0.001 WBTC ≈ $100, 0.001 USDC ≈ $0.001), while
  // being non-zero — which is the only requirement for creating a BackgeoOracle
  // price observation (the tick is recorded at swap time regardless of size).
  if (!amount) {
    amount = "0.001";
  }

  // Validate amount: parseFloat accepts "0.01abc" → 0.01 and "1e-3" → 0.001,
  // both of which later fail inside buildOraclePoolSwapTx/parseUnits with a 500.
  // Validate strictly with parseUnits so those cases return a clear 400.
  // We use 18 decimals as a safe upper-bound for the loose positivity check
  // (covers all ERC-20s); the exact decimal check happens inside buildOraclePoolSwapTx.
  try {
    const parsed = parseUnits(amount, 18);
    if (parsed <= 0n) throw new Error("non-positive");
  } catch {
    return c.json({ error: `amount must be a positive decimal number (e.g. '0.001'). Scientific notation is not supported.` }, 400);
  }

  if (rawVault !== undefined && (typeof rawVault !== "string" || !isAddress(rawVault) || rawVault === "0x0000000000000000000000000000000000000000")) {
    return c.json({ error: "vaultAddress must be a valid non-zero EVM address (0x-prefixed, 42 hex characters)." }, 400);
  }
  const vaultAddress = typeof rawVault === "string" ? (rawVault as Address) : undefined;

  try {
    const result = await buildOraclePoolSwapTx(token, amount, chainId, c.env.ALCHEMY_API_KEY, vaultAddress, direction);
    return c.json({
      transaction: result.transaction,
      poolInfo: result.poolInfo,
      message: result.message,
    });
  } catch (err) {
    const msg = sanitizeError(err instanceof Error ? err.message : String(err));
    // Distinguish client errors (bad token, unsupported chain) from server errors
    const isClientError =
      msg.includes("not deployed on chain") ||
      msg.includes("not available on chain") ||
      msg.includes("does not need an oracle update") ||
      msg.includes("cardinality = 0") ||
      msg.includes("Invalid decimal") ||
      msg.includes("Token") ||
      msg.includes("not found");
    return c.json({ error: msg }, isClientError ? 400 : 500);
  }
});
