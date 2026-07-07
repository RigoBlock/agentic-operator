/**
 * Uniswap Quote Route — Oracle-Protected Uniswap Trading API Proxy
 *
 * POST /api/quote/uniswap
 *
 * Drop-in replacement for the Uniswap Trading API /quote endpoint.
 * Forwards the request body verbatim, then appends oracle spot-price metadata
 * to the upstream response:
 *   - priceFeedExists: boolean
 *   - deltaBps: divergence from oracle in basis points
 *   - oracleAmount: expected output from oracle spot price
 *
 * The caller receives the exact same response they would from Uniswap, plus
 * three extra fields. No parameters are stripped or modified.
 *
 * Auth: x402 payment OR authenticated browser session.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import type { Address } from "viem";
import { getOracleSwapMetrics } from "../services/swapShield.js";
import { sanitizeError } from "../config.js";

const TRADING_API_URL = "https://trade-api.gateway.uniswap.org/v1";

function getHeaders(env: Env): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": env.UNISWAP_API_KEY,
    "x-universal-router-version": "2.0",
  };
}

export const quoteUniswap = new Hono<{ Bindings: Env; Variables: AppVariables }>();

quoteUniswap.post("/", async (c) => {
  // Auth gate — skip when request was paid via x402 (agent access)
  if (!c.get("x402Paid") && !c.get("operatorAuthVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or provide X-Operator-Address, X-Auth-Signature, and X-Auth-Timestamp headers." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  // Forward to Uniswap Trading API — body is passed verbatim, no stripping
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${TRADING_API_URL}/quote`, {
      method: "POST",
      headers: getHeaders(c.env),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return c.json({ error: sanitizeError(err instanceof Error ? err.message : "Upstream request failed") }, 502);
  }

  let data: Record<string, unknown>;
  try {
    data = await upstreamRes.json();
  } catch {
    return c.json({ error: "Invalid upstream response" }, 502);
  }

  if (!upstreamRes.ok) {
    return c.json(data, upstreamRes.status as 400 | 500);
  }

  // ── Oracle enrichment ──
  const tokenIn = String(body.tokenIn || "") as Address;
  const tokenOut = String(body.tokenOut || "") as Address;
  const rawChainId = body.tokenInChainId ?? body.chainId;

  let enrichment;
  try {
    if (!rawChainId) {
      // No chain specified — can't query oracle. Return neutral enrichment.
      enrichment = { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
    } else if (body.type === "EXACT_OUTPUT") {
      // EXACT_OUTPUT: body.amount is the desired output, not the input.
      // Comparing DEX input vs oracle input for the same output requires
      // swapping the token direction in the oracle call. Skip enrichment
      // to avoid producing meaningless deltaBps/oracleAmount.
      enrichment = { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
    } else {
      const chainId = Number(rawChainId);
      const amountIn = String(body.amount || "");

      // Extract DEX expected output from the response
      // Uniswap returns different quote objects depending on routing type
      const quoteObj =
        (data.quote as Record<string, unknown>) ||
        (data.classicQuote as Record<string, unknown>) ||
        (data.wrapUnwrapQuote as Record<string, unknown>) ||
        (data.dutchLimitV2Quote as Record<string, unknown>) ||
        (data.dutchLimitV3Quote as Record<string, unknown>) ||
        (data.priorityQuote as Record<string, unknown>) ||
        (data.chainedQuote as Record<string, unknown>) ||
        {};
      const output = (quoteObj.output as Record<string, string>) || {};
      const dexExpectedOut = output.amount || "0";

      enrichment = await getOracleSwapMetrics(
        chainId,
        tokenIn,
        tokenOut,
        BigInt(amountIn),
        BigInt(dexExpectedOut),
        c.env.ALCHEMY_API_KEY,
      );
    }
  } catch {
    enrichment = { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
  }

  return c.json({ ...data, ...enrichment });
});
