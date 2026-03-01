/**
 * Quote route — direct Uniswap Trading API quote, no LLM required.
 *
 * GET /api/quote?sell=ETH&buy=USDC&amount=1&chain=8453
 * GET /api/quote?sell=USDC&buy=ETH&amount=100&chain=1
 */

import { Hono } from "hono";
import type { Env } from "../types.js";
import { getUniswapQuote, formatUniswapQuoteForDisplay, calculateVaultGasLimit } from "../services/uniswapTrading.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { sanitizeError } from "../config.js";
import type { SwapIntent } from "../types.js";

export const quote = new Hono<{ Bindings: Env }>();

quote.get("/", async (c) => {
  const sell = c.req.query("sell")?.toUpperCase();
  const buy = c.req.query("buy")?.toUpperCase();
  const amount = c.req.query("amount");
  const chain = c.req.query("chain") || "8453";
  const vault = c.req.query("vault") || "";
  const slippage = c.req.query("slippage"); // bps, optional
  const operator = c.req.query("operator") || "";
  const sig = c.req.query("sig") || "";
  const ts = c.req.query("ts") || "0";

  if (!sell || !buy || !amount) {
    return c.json(
      {
        error: "Missing required query params: sell, buy, amount",
        example: "/api/quote?sell=ETH&buy=USDC&amount=1&chain=8453",
      },
      400,
    );
  }

  // Auth gate
  try {
    await verifyOperatorAuth({
      operatorAddress: operator,
      vaultAddress: vault,
      authSignature: sig,
      authTimestamp: Number(ts),
      preferredChainId: Number(chain),
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    return c.json({ error: "Auth failed" }, 401);
  }

  const chainId = Number(chain);
  const intent: SwapIntent = {
    tokenIn: sell,
    tokenOut: buy,
    amountIn: amount,
    slippageBps: slippage ? Number(slippage) : 100,
  };

  try {
    const uniQuote = await getUniswapQuote(c.env, intent, chainId, vault);
    const display = formatUniswapQuoteForDisplay(intent, uniQuote);
    const gasLimit = calculateVaultGasLimit(uniQuote.quote.gasUseEstimate);

    // Calculate human-readable price
    const inputAmt = Number(uniQuote.quote.input.amount);
    const outputAmt = Number(uniQuote.quote.output.amount);
    const decimalsIn = ["USDC", "USDT"].includes(sell) ? 6 : 18;
    const decimalsOut = ["USDC", "USDT"].includes(buy) ? 6 : 18;
    const inFloat = inputAmt / 10 ** decimalsIn;
    const outFloat = outputAmt / 10 ** decimalsOut;
    const price = inFloat > 0 ? outFloat / inFloat : 0;

    return c.json({
      sell: `${amount} ${sell}`,
      buy: `${outFloat.toFixed(6)} ${buy}`,
      price: `1 ${sell} = ${price.toFixed(4)} ${buy}`,
      routing: uniQuote.routing,
      gasFeeUSD: uniQuote.quote.gasFeeUSD,
      gasLimit: gasLimit.toString(),
      chainId,
      display,
    });
  } catch (err) {
    const message = sanitizeError(err instanceof Error ? err.message : "Quote failed");
    return c.json({ error: message }, 500);
  }
});
