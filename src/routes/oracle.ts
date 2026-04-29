/**
 * Oracle route — build a BackgeoOracle pool refresh transaction without LLM.
 *
 * POST /api/oracle/refresh
 *
 * Body (JSON):
 *   token     string   — ERC-20 symbol or address whose oracle feed is stale (e.g. "GRG", "USDC")
 *   amountEth string   — Amount of ETH to swap (human-readable, e.g. "0.001")
 *   chainId   number   — Chain where the oracle pool lives
 *
 * Returns an unsigned OPERATOR EOA transaction to be signed with the operator's
 * personal wallet (not the vault). The transaction targets the Universal Router,
 * not the vault adapter.
 *
 * Auth: x402 payment OR authenticated browser session.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import { buildOraclePoolSwapTx } from "../services/oraclePool.js";
import { sanitizeError, resolveChainId } from "../config.js";

export const oracle = new Hono<{ Bindings: Env; Variables: AppVariables }>();

oracle.post("/refresh", async (c) => {
  // Auth gate — requires x402 payment OR authenticated browser session.
  if (!c.get("x402Paid") && !c.get("browserVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or sign in as vault owner." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const amountEth = typeof body.amountEth === "string" ? body.amountEth.trim() : "";
  const rawChain = body.chainId ?? body.chain;

  if (!token) {
    return c.json(
      { error: "Missing required field: token (ERC-20 symbol or address, e.g. 'GRG' or 'USDC')" },
      400,
    );
  }
  if (!amountEth) {
    return c.json(
      { error: "Missing required field: amountEth (ETH amount, e.g. '0.001')" },
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

  // Validate amountEth is a positive number
  const parsedAmount = parseFloat(amountEth);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return c.json({ error: "amountEth must be a positive number (e.g. '0.001')" }, 400);
  }

  try {
    const result = await buildOraclePoolSwapTx(token, amountEth, chainId, c.env.ALCHEMY_API_KEY);
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
      msg.includes("ETH/WETH does not need") ||
      msg.includes("cardinality = 0") ||
      msg.includes("Token") ||
      msg.includes("not found");
    return c.json({ error: msg }, isClientError ? 400 : 500);
  }
});
