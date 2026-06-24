/**
 * 0x Quote Route — Oracle-Protected 0x Swap API Proxy
 *
 * GET /api/quote/0x
 *
 * Drop-in replacement for the 0x API v2 `/swap/allowance-holder/quote` endpoint.
 * Forwards query parameters verbatim, then appends oracle spot-price metadata
 * to the upstream response:
 *   - priceFeedExists: boolean
 *   - deltaBps: divergence from oracle in basis points
 *   - oracleAmount: expected output from oracle spot price
 *
 * The caller receives the exact same response they would from 0x, plus
 * three extra fields. No parameters are stripped or modified.
 *
 * Auth: x402 payment OR authenticated browser session.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import type { Address } from "viem";
import { enrichQuoteWithOracle } from "../services/quoteEnrichment.js";
import { sanitizeError } from "../config.js";

const ZEROX_API_URL = "https://api.0x.org";

function getHeaders(env: Env): Record<string, string> {
  return {
    "0x-api-key": env.ZEROX_API_KEY,
    "0x-version": "v2",
  };
}

export const quote0x = new Hono<{ Bindings: Env; Variables: AppVariables }>();

quote0x.get("/", async (c) => {
  // Auth gate — skip when request was paid via x402 (agent access)
  if (!c.get("x402Paid") && !c.get("operatorAuthVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or provide X-Operator-Address, X-Auth-Signature, and X-Auth-Timestamp headers." }, 401);
  }

  // Build upstream URL — pass query params verbatim, no stripping
  const upstreamUrl = `${ZEROX_API_URL}/swap/allowance-holder/quote?${new URLSearchParams(c.req.query()).toString()}`;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers: getHeaders(c.env) });
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
  // For exact-input we compare the oracle output for the quoted sellAmount
  // against the DEX buyAmount. For exact-output (buyAmount) we do the same:
  // the DEX response tells us the required sellAmount, so we compare the
  // oracle output for that input against the requested buyAmount.
  const query = c.req.query();
  let enrichment;
  const hasChainId = !!query.chainId;
  const isExactInput = !!query.sellAmount;
  const isExactOutput = !!query.buyAmount;
  if (!hasChainId || (!isExactInput && !isExactOutput)) {
    enrichment = { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
  } else {
    const chainId = Number(query.chainId);
    const tokenIn = (query.sellToken || "") as Address;
    const tokenOut = (query.buyToken || "") as Address;
    const amountIn = isExactInput
      ? query.sellAmount
      : String(data.estimatedNetSellAmount || data.maxSellAmount || data.sellAmount || "0");
    const dexExpectedOut = String(data.buyAmount || "0");
    try {
      enrichment = await enrichQuoteWithOracle(
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        dexExpectedOut,
        c.env.ALCHEMY_API_KEY,
      );
    } catch {
      enrichment = { priceFeedExists: false, deltaBps: 0, oracleAmount: "0" };
    }
  }

  return c.json({ ...data, ...enrichment });
});
