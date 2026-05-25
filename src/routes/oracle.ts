/**
 * Oracle route — build a BackgeoOracle pool refresh transaction without LLM.
 *
 * POST /api/oracle/refresh
 *
 * Body (JSON):
 *   token        string   — ERC-20 symbol or address whose oracle feed is stale (e.g. "GRG", "USDC")
 *   amountEth    string|number — Amount of native token to swap (human-readable, e.g. "0.001" or 0.001). Optional; defaults to 0.001.
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
import { buildOraclePoolSwapTx, getNativeTokenSymbol } from "../services/oraclePool.js";
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
  let amountEth =
    typeof body.amountEth === "string"
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

  const nativeSymbol = getNativeTokenSymbol(chainId);

  // Default amount if not provided
  if (!amountEth) {
    amountEth = "0.001";
  }

  // Validate amountEth: parseFloat accepts "0.01abc" → 0.01 and "1e-3" → 0.001,
  // both of which later fail inside buildOraclePoolSwapTx/parseUnits with a 500.
  // Validate strictly with parseUnits so those cases return a clear 400.
  try {
    const parsed = parseUnits(amountEth, 18);
    if (parsed <= 0n) throw new Error("non-positive");
  } catch {
    return c.json({ error: `amountEth must be a positive decimal number of ${nativeSymbol} (e.g. '0.001'). Scientific notation is not supported.` }, 400);
  }

  if (rawVault !== undefined && (typeof rawVault !== "string" || !isAddress(rawVault) || rawVault === "0x0000000000000000000000000000000000000000")) {
    return c.json({ error: "vaultAddress must be a valid non-zero EVM address (0x-prefixed, 42 hex characters)." }, 400);
  }
  const vaultAddress = typeof rawVault === "string" ? (rawVault as Address) : undefined;

  try {
    const result = await buildOraclePoolSwapTx(token, amountEth, chainId, c.env.ALCHEMY_API_KEY, vaultAddress);
    return c.json({
      transaction: result.transaction,
      poolInfo: result.poolInfo,
      message: result.message,
    });
  } catch (err) {
    const msg = sanitizeError(err);
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
