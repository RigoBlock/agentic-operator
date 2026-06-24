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
import { parseUnits, formatUnits } from "viem";
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
  /** Maximum sell amount required (exact-output quotes only), in base units */
  maxSellAmount?: string;
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

  // 0x Swap API v2 supports both exact-input (sellAmount) and, since May 2026,
  // exact-output (buyAmount) quotes. We pass the caller's intent through
  // verbatim; the 0x router computes the required counter-amount and includes a
  // refund leg for any buy-token surplus on exact-output trades.
  //
  // Note: The /gasless/ endpoints are NOT suitable here. They don't support
  // native tokens (ETH) and use a completely different Permit2 meta-tx flow.

  if (intent.amountOut && !intent.amountIn) {
    params.set("buyAmount", parseUnits(intent.amountOut, decimalsOut).toString());
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
      `If exact-output (buy), liquidity may be too low. ` +
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
  //
  // Exact-output responses (mode: "exact-out") use `estimatedNetSellAmount`
  // instead of `sellAmount`; `maxSellAmount` is the slippage-adjusted worst
  // case. Exact-input responses (mode: "exact-in") include `sellAmount`.
  const rawBuyAmount = data.buyAmount;
  const rawBuyToken = data.buyToken;
  const rawSellToken = data.sellToken;
  const rawEstimatedNetSellAmount = data.estimatedNetSellAmount;
  const rawSellAmount =
    typeof data.sellAmount === "string" && data.sellAmount !== ""
      ? data.sellAmount
      : typeof rawEstimatedNetSellAmount === "string" && rawEstimatedNetSellAmount !== ""
        ? rawEstimatedNetSellAmount
        : undefined;

  if (typeof rawBuyAmount !== "string" || rawBuyAmount === "") {
    throw new Error(
      `0x quote response is missing a valid buyAmount (got ${typeof rawBuyAmount}). ` +
      `The token pair may not be fully supported by 0x on chain ${chainId}. Try Uniswap.`
    );
  }
  if (typeof rawSellAmount !== "string" || rawSellAmount === "") {
    throw new Error(
      `0x quote response is missing a valid sellAmount/estimatedNetSellAmount ` +
      `(got sellAmount=${typeof data.sellAmount}, estimatedNetSellAmount=${typeof rawEstimatedNetSellAmount}). ` +
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

  // Sanity check for exact-output: the API should honor the requested buyAmount.
  // A small rounding/surplus-refund deviation is expected, but a large gap
  // indicates the quote is not usable.
  if (intent.amountOut && !intent.amountIn) {
    const actualBuyRaw = BigInt(rawBuyAmount);
    const desiredBuyRaw = parseUnits(intent.amountOut, decimalsOut);
    // Allow 1% downward deviation (surplus refunds can make it slightly higher)
    if (actualBuyRaw * 100n < desiredBuyRaw * 99n) {
      throw new Error(
        `0x quote output (${formatUnits(actualBuyRaw, decimalsOut)} ${intent.tokenOut}) ` +
        `is below the requested ${intent.amountOut} ${intent.tokenOut}. ` +
        `Liquidity may be too shallow or slippage was exceeded. ` +
        `Try a different DEX (uniswap) or a smaller amount.`
      );
    }
  }

  return {
    buyAmount: rawBuyAmount,
    buyToken: rawBuyToken,
    sellAmount: rawSellAmount,
    sellToken: rawSellToken,
    maxSellAmount: typeof data.maxSellAmount === "string" && data.maxSellAmount !== ""
      ? data.maxSellAmount
      : undefined,
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
