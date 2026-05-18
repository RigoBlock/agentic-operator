/**
 * 0x Swap API Service (AllowanceHolder)
 *
 * Uses the 0x Swap API v2 AllowanceHolder endpoint to get quotes and
 * executable swap calldata. The flow:
 *
 *   1. GET /swap/allowance-holder/price  → indicative price (optional)
 *   2. GET /swap/allowance-holder/quote  → firm quote with tx data
 *
 * The returned transaction data targets the AllowanceHolder contract.
 * For Rigoblock vaults, the calldata is sent to the vault address
 * (the vault's A0xRouter adapter routes it through AllowanceHolder internally).
 *
 * Reference: https://docs.0x.org/docs/0x-swap-api/introduction
 */

import type { Address, Hex } from "viem";
import type { Env, SwapIntent } from "../types.js";
import { resolveTokenAddress } from "../config.js";
import { parseUnits } from "viem";
import { getTokenDecimals } from "./vault.js";

const ZEROX_API_URL = "https://api.0x.org";

/**
 * AllowanceHolder contract address (same on all Cancun-hardfork chains).
 * Mantle uses a different address — not currently supported.
 */
export const ALLOWANCE_HOLDER_ADDRESS =
  "0x0000000000001fF3684f28c67538d4D072C22734" as Address;

// ── Types ──────────────────────────────────────────────────────────────

export interface ZeroXQuote {
  buyAmount: string;
  buyToken: string;
  sellAmount: string;
  sellToken: string;
  gas: string;
  gasPrice: string;
  totalNetworkFee: string;
  transaction: {
    to: Address;
    data: Hex;
    gas: string;
    gasPrice: string;
    value: string;
  };
  decimalsIn: number;
  decimalsOut: number;
  /** The full raw response */
  _raw: Record<string, unknown>;
}

// ── Headers ────────────────────────────────────────────────────────────

function getHeaders(env: Env): Record<string, string> {
  return {
    "0x-api-key": env.ZEROX_API_KEY,
    "0x-version": "v2",
  };
}

// ── Retry helper ───────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === maxRetries - 1) return res;
    const delay = Math.min(
      500 * Math.pow(2, attempt) + Math.random() * 100,
      5000,
    );
    console.log(
      `[0x] Retry ${attempt + 1}/${maxRetries} after ${res.status}, waiting ${Math.round(delay)}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error("Unreachable");
}

// ── Quote ──────────────────────────────────────────────────────────────

/**
 * Get a firm quote from the 0x Swap API (AllowanceHolder endpoint).
 *
 * Returns executable transaction data ready to submit.
 */
export async function getZeroXQuote(
  env: Env,
  intent: SwapIntent,
  chainId: number,
  taker: string,
): Promise<ZeroXQuote> {
  // 0x API uses 0xEeee...EEeE for native ETH, not the zero address
  const NATIVE_ETH_0X = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

  let sellToken = await resolveTokenAddress(chainId, intent.tokenIn);
  let buyToken = await resolveTokenAddress(chainId, intent.tokenOut);

  // Map zero-address ETH to the 0x native token sentinel
  const sellIsNative = sellToken.toLowerCase() === ZERO_ADDR;
  const buyIsNative = buyToken.toLowerCase() === ZERO_ADDR;
  if (sellIsNative) sellToken = NATIVE_ETH_0X as `0x${string}`;
  if (buyIsNative) buyToken = NATIVE_ETH_0X as `0x${string}`;

  // Native ETH is 18 decimals; for ERC-20s fetch on-chain decimals
  const [decimalsIn, decimalsOut] = await Promise.all([
    sellIsNative ? Promise.resolve(18) : getTokenDecimals(chainId, sellToken, env.ALCHEMY_API_KEY),
    buyIsNative ? Promise.resolve(18) : getTokenDecimals(chainId, buyToken, env.ALCHEMY_API_KEY),
  ]);

  // Build query parameters
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    // The zero address (0x000...000) is invalid for 0x API. External agents calling
    // get_swap_quote without a vault selection pass the zero address sentinel. Fall
    // back to a known valid address so price-only queries succeed.
    taker: (taker && taker.toLowerCase() !== "0x0000000000000000000000000000000000000000")
      ? taker
      : "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth — safe for price-only queries
    // Exclude RFQ liquidity: the Rigoblock vault's A0xRouter adapter only allows
    // on-chain AMM settler actions (UniswapV2/V3/V4, Balancer, Curve, etc.).
    // RFQ fills use a settler action not in the allowlist, so they'd revert.
    excludedSources: "0x_RFQ",
  });

  // 0x API only supports sellAmount (exact input). Both getPrice and getQuote
  // require sellAmount — there is no buyAmount parameter.
  //
  // Note: The /gasless/ endpoints are NOT suitable here. They don't support
  // native tokens (ETH) and use a completely different Permit2 meta-tx flow.
  //
  // For exact-output (user wants to buy N tokens), we:
  //   1. Call /swap/allowance-holder/price with a small probe sellAmount to get
  //      the indicative market rate, then compute the required sellAmount.
  //   2. Call /swap/allowance-holder/quote with that sellAmount for the firm
  //      quote with executable transaction data.
  //
  // Probe sizing uses token decimals to stay small but avoid rounding to 0:
  //   - max(0, decimalsIn - decimalsOut) compensates for the raw→raw decimal
  //     shift. When sellToken has MORE decimals, each raw unit is tinier so we
  //     need proportionally more. When sellToken has FEWER decimals (e.g.,
  //     USDC→ETH), the conversion naturally amplifies output, so no extra needed.
  //   - +3 safety handles price ratios up to ~1000:1 (covers USDC→WBTC at $60k).
  //   - If buyAmount still rounds to 0 (extreme ratios like memecoin→WBTC),
  //     a single retry with a much larger probe handles it. The price endpoint
  //     is indicative only (no funds move), so larger probes are safe.
  if (intent.amountOut && !intent.amountIn) {
    // 0x API v2 only supports exact-input (sellAmount). For exact-output,
    // we probe with a small exact-input /quote to get the reliable market rate,
    // then compute the required sellAmount for the desired buy amount.
    // Using /quote instead of /price avoids distorted indicative rates for
    // low-liquidity or exotic token pairs.
    //
    // Probe sizing uses decimalGap to compensate for raw-unit differences between
    // tokens. If the first probe returns buyAmount=0 (extreme price ratios like
    // cheap memecoin → WBTC), a single retry with a substantially larger probe
    // handles it.
    const decimalGap = Math.max(0, decimalsIn - decimalsOut);
    const probeExponent = decimalGap + 3;
    let probeSellAmount = 10n ** BigInt(probeExponent);
    let probeBuyAmountBn = 0n;
    let probeSellAmountBn = 0n;

    for (let attempt = 0; attempt < 2; attempt++) {
      const probeParams = new URLSearchParams(params);
      probeParams.set("sellAmount", probeSellAmount.toString());
      probeParams.set("slippageBps", String(intent.slippageBps ?? 100));

      console.log(`[0x] Exact-output probe: sellAmount=${probeSellAmount} (10^${probeExponent}${attempt > 0 ? " + retry" : ""}, decGap=${decimalGap})`);
      const probeUrl = `${ZEROX_API_URL}/swap/allowance-holder/quote?${probeParams.toString()}`;
      const probeRes = await fetchWithRetry(probeUrl, {
        method: "GET",
        headers: getHeaders(env),
      });

      if (!probeRes.ok) {
        console.warn(`[0x] Probe quote failed (${probeRes.status}), trying next probe amount`);
        if (attempt === 0) {
          const retryBump = BigInt(Math.max(8, Math.ceil(decimalsIn / 2)));
          probeSellAmount = probeSellAmount * (10n ** retryBump);
        }
        continue;
      }

      const probeData = await probeRes.json() as Record<string, unknown>;
      const probeBuyAmount = probeData.buyAmount as string;

      if (probeBuyAmount && probeBuyAmount !== "0") {
        probeBuyAmountBn = BigInt(probeBuyAmount);
        probeSellAmountBn = probeSellAmount;
        console.log(`[0x] Probe result: ${probeSellAmount} ${intent.tokenIn} → ${probeBuyAmount} ${intent.tokenOut}`);
        break;
      }

      if (attempt === 0) {
        // Retry with a substantially larger probe. Scale by ~10^(half of decimalsIn)
        // so high-decimal tokens (18-dec memecoins) get enough headroom while
        // low-decimal tokens (6-dec stables) stay reasonable.
        const retryBump = BigInt(Math.max(8, Math.ceil(decimalsIn / 2)));
        probeSellAmount = probeSellAmount * (10n ** retryBump);
        console.log(`[0x] buyAmount=0, retrying with probe=${probeSellAmount}`);
      }
    }

    if (probeBuyAmountBn === 0n || probeSellAmountBn === 0n) {
      throw new Error(
        `0x could not determine a market price for ${intent.tokenIn}→${intent.tokenOut} on chain ${chainId}. ` +
        `The exact-output probe failed for all probe amounts. ` +
        `Try a different DEX (uniswap) or a smaller amount.`
      );
    }

    // Compute required sellAmount from the probe rate
    // rate = probeBuyAmount / probeSellAmount
    // needed = desiredBuyAmount * probeSellAmount / probeBuyAmount
    const desiredBuyAmountRaw = parseUnits(intent.amountOut, decimalsOut);

    // Add 2% buffer to account for price movement between probe and final quote
    const estimatedSellAmount = (desiredBuyAmountRaw * probeSellAmountBn * 102n) / (probeBuyAmountBn * 100n);

    // Defensive: estimatedSellAmount must be > 0
    if (estimatedSellAmount === 0n) {
      throw new Error(
        `0x could not compute a valid sell amount for ${intent.amountOut} ${intent.tokenOut} on chain ${chainId}. ` +
        `The probe returned ${probeBuyAmountBn.toString()} buy tokens for ${probeSellAmountBn.toString()} sell tokens, ` +
        `which produced a zero estimated input. Try a different DEX (uniswap) or a smaller amount.`
      );
    }

    console.log(`[0x] Estimated sellAmount=${estimatedSellAmount.toString()} (+2% buffer) for target ${intent.amountOut} ${intent.tokenOut}`);
    params.set("sellAmount", estimatedSellAmount.toString());
  } else if (intent.amountIn) {
    params.set(
      "sellAmount",
      parseUnits(intent.amountIn, decimalsIn).toString(),
    );
  } else {
    throw new Error("Either amountIn or amountOut must be specified for 0x swaps.");
  }

  // Slippage: 0x uses a decimal (0.01 = 1%), Rigoblock default is 100 bps = 1%
  const slippageBps = intent.slippageBps ?? 100;
  params.set("slippageBps", String(slippageBps));

  const url = `${ZEROX_API_URL}/swap/allowance-holder/quote?${params.toString()}`;

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: getHeaders(env),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let detail = `HTTP ${res.status}`;
    try {
      const errData = JSON.parse(errText);
      detail =
        errData.reason ||
        errData.description ||
        errData.message ||
        errText.slice(0, 300);
    } catch {
      detail = errText.slice(0, 300) || detail;
    }
    console.error(`[0x] Quote error ${res.status}:`, errText.slice(0, 800));
    const requestDesc = intent.amountOut
      ? `buy ${intent.amountOut} ${intent.tokenOut} with ${intent.tokenIn}`
      : `sell ${intent.amountIn} ${intent.tokenIn} for ${intent.tokenOut}`;
    throw new Error(
      `0x quote failed (${res.status}): ${detail}. ` +
      `Requested ${requestDesc} on chain ${chainId}. ` +
      `If exact-output (buy), the price probe may have failed or returned an extreme rate. ` +
      `Try switching DEX (uniswap) or reducing the amount.`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  // Check if liquidity is available
  if (data.liquidityAvailable === false) {
    throw new Error(
      `No liquidity found on 0x for ${intent.tokenIn} → ${intent.tokenOut} on chain ${chainId}. ` +
      `The token pair may not be supported by 0x on this chain. Try Uniswap or a different chain.`
    );
  }

  // Validate response has transaction data
  const txData = data.transaction as
    | { to: string; data: string; gas: string; gasPrice: string; value: string }
    | undefined;
  if (!txData?.data || txData.data === "0x") {
    throw new Error("0x returned empty transaction data. The quote may not be available.");
  }

  // Defensive: validate that buyAmount and sellAmount are present and are non-empty strings.
  // Some 0x API versions or edge conditions can return these as numbers or omit them.
  const rawBuyAmount = data.buyAmount;
  const rawSellAmount = data.sellAmount;
  const rawBuyToken = data.buyToken;
  const rawSellToken = data.sellToken;

  if (typeof rawBuyAmount !== "string" || rawBuyAmount === "") {
    throw new Error(
      `0x quote response is missing a valid buyAmount (got ${typeof rawBuyAmount}). ` +
      `The token pair may not be fully supported by 0x on chain ${chainId}. Try Uniswap.`
    );
  }
  if (typeof rawSellAmount !== "string" || rawSellAmount === "") {
    throw new Error(
      `0x quote response is missing a valid sellAmount (got ${typeof rawSellAmount}). ` +
      `The token pair may not be fully supported by 0x on chain ${chainId}. Try Uniswap.`
    );
  }
  if (typeof rawBuyToken !== "string" || rawBuyToken === "") {
    throw new Error(
      `0x quote response is missing a valid buyToken (got ${typeof rawBuyToken}). ` +
      `The token pair may not be fully supported by 0x on chain ${chainId}. Try Uniswap.`
    );
  }
  if (typeof rawSellToken !== "string" || rawSellToken === "") {
    throw new Error(
      `0x quote response is missing a valid sellToken (got ${typeof rawSellToken}). ` +
      `The token pair may not be fully supported by 0x on chain ${chainId}. Try Uniswap.`
    );
  }

  return {
    buyAmount: rawBuyAmount,
    buyToken: rawBuyToken,
    sellAmount: rawSellAmount,
    sellToken: rawSellToken,
    gas: (data.gas as string) || txData.gas || "300000",
    gasPrice: (data.gasPrice as string) || txData.gasPrice || "0",
    totalNetworkFee: (data.totalNetworkFee as string) || "0",
    transaction: {
      to: txData.to as Address,
      data: txData.data as Hex,
      gas: txData.gas,
      gasPrice: txData.gasPrice,
      value: txData.value || "0",
    },
    decimalsIn,
    decimalsOut,
    _raw: data,
  };
}

// ── Format for display ─────────────────────────────────────────────────

/**
 * Format a 0x quote for display in the chat.
 */
export function formatZeroXQuoteForDisplay(
  intent: SwapIntent,
  quote: ZeroXQuote,
): string {
  const isExactOutput = !!intent.amountOut;
  const outputAmount = formatTokenAmount(quote.buyAmount, quote.decimalsOut);
  const inputAmount = formatTokenAmount(quote.sellAmount, quote.decimalsIn);

  // Derive price from amounts
  const sellNum = parseFloat(inputAmount);
  const buyNum = parseFloat(outputAmount);
  let priceLine = "";
  if (sellNum > 0 && buyNum > 0) {
    const pricePerSell = buyNum / sellNum;
    const pricePerBuy = sellNum / buyNum;
    priceLine = `Price:    1 ${intent.tokenIn} = ${pricePerSell.toFixed(6)} ${intent.tokenOut}  (1 ${intent.tokenOut} = ${pricePerBuy.toFixed(6)} ${intent.tokenIn})`;
  }

  const sellLine = isExactOutput
    ? `Sell:     ~${inputAmount} ${intent.tokenIn} (estimated)`
    : `Sell:     ${intent.amountIn} ${intent.tokenIn}`;
  const buyLine = isExactOutput
    ? `Buy:      ${intent.amountOut} ${intent.tokenOut}`
    : `Buy:      ~${outputAmount} ${intent.tokenOut}`;

  const gasEstimate = BigInt(quote.gas || "300000");
  const gasWithOverhead = gasEstimate + 200_000n; // vault adapter overhead

  const lines = [
    `📊 Swap Quote (0x Aggregator)`,
    `─────────────────────────`,
    sellLine,
    buyLine,
    ...(priceLine ? [priceLine] : []),
    `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
    `Gas:      ~${quote.totalNetworkFee ? "$" + (parseFloat(quote.totalNetworkFee) / 1e18).toFixed(4) : "estimating..."} (limit: ${gasWithOverhead.toString()})`,
    `Route:    0x AllowanceHolder`,
    `─────────────────────────`,
    `Ready to sign. You will confirm the transaction in your wallet.`,
  ];
  return lines.join("\n");
}

/**
 * Format a raw token amount to human-readable using actual decimals.
 */
function formatTokenAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .slice(0, 6);
  return `${whole}.${frac}`;
}
