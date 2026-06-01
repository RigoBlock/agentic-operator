/**
 * Uniswap Quote Route — Oracle-Protected Uniswap Trading API Proxy
 *
 * POST /api/quote/uniswap
 *
 * Accepts the exact same request body as the Uniswap Trading API /quote endpoint.
 * Forwards to Uniswap, then enriches the response with oracle spot-price metadata:
 *   - priceFeedExists: boolean
 *   - deltaBps: divergence from oracle in basis points
 *   - oracleAmount: expected output from oracle spot price
 *
 * Optional field: requirePriceFeed (default false)
 *   - When true, returns 422 if no oracle feed exists for the token pair.
 *
 * Auth: x402 payment OR authenticated browser session.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import type { Address } from "viem";
import { enrichQuoteWithOracle } from "../services/quoteEnrichment.js";
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
  if (!c.get("x402Paid") && !c.get("browserVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or a verified browser session." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const requirePriceFeed = body.requirePriceFeed === true || body.requirePriceFeed === "true";
  const bodyToForward = { ...body };
  delete bodyToForward.requirePriceFeed;

  // Forward to Uniswap Trading API
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${TRADING_API_URL}/quote`, {
      method: "POST",
      headers: getHeaders(c.env),
      body: JSON.stringify(bodyToForward),
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
  const chainId = Number(bodyToForward.tokenInChainId || bodyToForward.chainId || 1);
  const tokenIn = String(bodyToForward.tokenIn || "") as Address;
  const tokenOut = String(bodyToForward.tokenOut || "") as Address;
  const amountIn = String(bodyToForward.amount || "");

  // Extract DEX expected output from the response
  const quoteObj =
    (data.quote as Record<string, unknown>) ||
    (data.classicQuote as Record<string, unknown>) ||
    (data.wrapUnwrapQuote as Record<string, unknown>) ||
    {};
  const output = (quoteObj.output as Record<string, string>) || {};
  const dexExpectedOut = output.amount || "0";

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
