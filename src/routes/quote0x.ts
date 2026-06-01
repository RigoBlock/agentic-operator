/**
 * 0x Quote Route — Oracle-Protected 0x Swap API Proxy
 *
 * GET /api/quote/0x
 *
 * Accepts the exact same query parameters as the 0x API
 * /swap/allowance-holder/quote endpoint.
 * Forwards to 0x, then enriches the response with oracle spot-price metadata:
 *   - priceFeedExists: boolean
 *   - deltaBps: divergence from oracle in basis points
 *   - oracleAmount: expected output from oracle spot price
 *
 * Optional query param: requirePriceFeed (default false)
 *   - When true, returns 422 if no oracle feed exists for the token pair.
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
  if (!c.get("x402Paid") && !c.get("browserVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or a verified browser session." }, 401);
  }

  const requirePriceFeed = c.req.query("requirePriceFeed") === "true";

  // Build upstream query params (strip requirePriceFeed)
  const upstreamParams = new URLSearchParams();
  for (const [key, value] of Object.entries(c.req.query())) {
    if (key !== "requirePriceFeed" && value !== undefined) {
      upstreamParams.set(key, value);
    }
  }

  // Forward to 0x API
  const upstreamUrl = `${ZEROX_API_URL}/swap/allowance-holder/quote?${upstreamParams.toString()}`;
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
  const chainId = Number(upstreamParams.get("chainId") || "1");
  const tokenIn = (upstreamParams.get("sellToken") || "") as Address;
  const tokenOut = (upstreamParams.get("buyToken") || "") as Address;
  const amountIn = upstreamParams.get("sellAmount") || "0";
  const dexExpectedOut = String(data.buyAmount || "0");

  let enrichment;
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

  if (requirePriceFeed && !enrichment.priceFeedExists) {
    return c.json(
      {
        ...data,
        ...enrichment,
        error: "Oracle price feed not available for this token pair",
        code: "NO_PRICE_FEED",
      },
      422,
    );
  }

  return c.json({ ...data, ...enrichment });
});
