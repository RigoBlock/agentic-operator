/**
 * Uniswap Trading API Service
 *
 * Implements the Uniswap Trading API 2-step flow (skip check_approval since
 * the Rigoblock vault protocol handles approvals internally):
 *
 *   1. POST /quote  → get routing + price + permit data
 *   2. POST /swap   → get ready-to-sign execute() calldata
 *
 * The returned calldata targets the Universal Router's execute(commands, inputs, deadline).
 * Since the Rigoblock vault exposes the same interface (IAUniswapRouter), we
 * ABI-decode the calldata to extract (commands, inputs, deadline) and re-encode
 * it as a call to vault.execute().
 *
 * Gas: We use the Uniswap-returned gasUseEstimate + a 200k overhead to account
 * for the vault adapter context. This avoids requiring an RPC call.
 *
 * Reference: https://github.com/Uniswap/uniswap-ai
 */

import type { Address, Hex } from "viem";
import type { Env, SwapIntent } from "../types.js";
import { resolveTokenAddress } from "../config.js";
import { parseUnits } from "viem";
import { getTokenDecimals } from "./vault.js";

const TRADING_API_URL = "https://trade-api.gateway.uniswap.org/v1";

/** Zero address representing native ETH */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Extra gas added on top of Uniswap's estimate to cover vault adapter overhead */
const VAULT_GAS_OVERHEAD = 200_000n;

/**
 * Fetch with retry + exponential backoff for 429 / 5xx errors.
 * Max 3 attempts, 500ms → 1s → 2s delays.
 */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === maxRetries - 1) return res; // last attempt, return as-is
    const delay = Math.min(500 * Math.pow(2, attempt) + Math.random() * 100, 5000);
    console.log(`[uniswap] Retry ${attempt + 1}/${maxRetries} after ${res.status}, waiting ${Math.round(delay)}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error("Unreachable");
}

/**
 * Headers required for all Trading API requests.
 */
function getHeaders(env: Env): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": env.UNISWAP_API_KEY,
    "x-universal-router-version": "2.0",
  };
}

// ── Types ──────────────────────────────────────────────────────────────

export interface UniswapQuote {
  routing: string; // "CLASSIC" | "DUTCH_V2" | "PRIORITY" | "WRAP" | "UNWRAP" | ...
  quote: {
    input: { token: string; amount: string };
    output: { token: string; amount: string };
    slippage: number;
    gasFee: string;
    gasFeeUSD: string;
    gasUseEstimate: string;
    route: unknown[];
  };
  permitData?: Record<string, unknown> | null;
  /** Token decimals resolved on-chain */
  decimalsIn: number;
  decimalsOut: number;
  /** The full raw response, used to pass into /swap */
  _raw: Record<string, unknown>;
}

export interface UniswapSwapTx {
  to: Address;
  from: Address;
  data: Hex;
  value: string;
  chainId: number;
  gasLimit?: string;
}

// ── Quote ──────────────────────────────────────────────────────────────

/**
 * Get a swap quote from the Uniswap Trading API.
 *
 * @param env - Worker env (for API key)
 * @param intent - what to swap
 * @param chainId - chain the vault lives on
 * @param swapper - vault address (the entity whose tokens are traded)
 */
export async function getUniswapQuote(
  env: Env,
  intent: SwapIntent,
  chainId: number,
  swapper: string,
): Promise<UniswapQuote> {
  const tokenIn = await resolveTokenAddress(chainId, intent.tokenIn);
  const tokenOut = await resolveTokenAddress(chainId, intent.tokenOut);

  // Native ETH is the zero address — pass it through as-is.
  // Uniswap v4 supports native ETH pools (distinct from WETH pools),
  // and vaults may hold ETH or WETH at their discretion.
  const tokenInIsNative = tokenIn.toLowerCase() === ZERO_ADDR;
  const tokenOutIsNative = tokenOut.toLowerCase() === ZERO_ADDR;

  // Fetch actual on-chain decimals (cached after first call).
  // Native tokens are always 18 decimals — skip RPC call.
  const [decimalsIn, decimalsOut] = await Promise.all([
    tokenInIsNative ? Promise.resolve(18) : getTokenDecimals(chainId, tokenIn, env.ALCHEMY_API_KEY),
    tokenOutIsNative ? Promise.resolve(18) : getTokenDecimals(chainId, tokenOut, env.ALCHEMY_API_KEY),
  ]);

  // Determine swap type and resolve amount
  const isExactOutput = !!intent.amountOut;
  let amount: string;
  let type: string;

  if (isExactOutput) {
    amount = parseUnits(intent.amountOut!, decimalsOut).toString();
    type = "EXACT_OUTPUT";
  } else {
    amount = parseUnits(intent.amountIn!, decimalsIn).toString();
    type = "EXACT_INPUT";
  }

  // If no vault set yet, use a well-known address for price-only queries
  const effectiveSwapper = swapper || "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  // Validate slippage to prevent NaN serialization
  const rawSlippage = intent.slippageBps ?? 100;
  const slippageTolerance = Number.isFinite(rawSlippage)
    ? Math.round(rawSlippage) / 100
    : 1; // fallback to 1%

  // Uniswap Trading API expects chainId as integers
  const body: Record<string, unknown> = {
    type,
    amount,
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    tokenIn,
    tokenOut,
    swapper: effectiveSwapper,
    slippageTolerance,
    routingPreference: "BEST_PRICE",
  };

  const res = await fetchWithRetry(`${TRADING_API_URL}/quote`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let detail = `HTTP ${res.status}`;
    try {
      const errData = JSON.parse(errText);
      detail = errData.detail || errData.errorCode || errData.message || errText.slice(0, 300);
    } catch {
      detail = errText.slice(0, 300) || detail;
    }
    console.error(`[uniswap] Quote error ${res.status}:`, errText.slice(0, 800));
    console.error(`[uniswap] Request body:`, JSON.stringify(body));
    throw new Error(
      `Uniswap quote failed (${res.status}): ${detail}. ` +
      `Requested ${intent.amountOut ? "buy " + intent.amountOut : "sell " + intent.amountIn} ` +
      `${intent.tokenIn}→${intent.tokenOut} on chain ${chainId}.`,
    );
  }

  const data = await res.json() as Record<string, unknown>;

  // Extract the quote object — field name depends on routing type
  const routing = data.routing as string;
  const quoteData =
    data.quote ??
    data.classicQuote ??
    data.wrapUnwrapQuote ??
    data.bridgeQuote ??
    data.dutchLimitV2Quote ??
    data.dutchLimitV3Quote ??
    data.priorityQuote ??
    data.chainedQuote;

  return {
    routing,
    quote: quoteData as UniswapQuote["quote"],
    permitData: data.permitData as Record<string, unknown> | null,
    decimalsIn,
    decimalsOut,
    _raw: data,
  };
}

// ── Swap calldata ──────────────────────────────────────────────────────

/**
 * Get executable swap calldata from the Uniswap Trading API.
 *
 * Takes the full quote response and sends it to /swap to get the
 * ready-to-sign transaction. The returned `data` field contains the
 * encoded execute(commands, inputs, deadline) call to the Universal Router.
 *
 * CRITICAL: The quote response is spread into the request body (not wrapped).
 * Null permitData/permitTransaction fields must be stripped.
 */
export async function getUniswapSwapCalldata(
  env: Env,
  quoteResponse: Record<string, unknown>,
): Promise<UniswapSwapTx> {
  // Strip null fields that the API rejects
  const { permitData, permitTransaction, ...cleanQuote } = quoteResponse;

  const swapRequest: Record<string, unknown> = { ...cleanQuote };

  const res = await fetchWithRetry(`${TRADING_API_URL}/swap`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify(swapRequest),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let detail = `HTTP ${res.status}`;
    try {
      const errData = JSON.parse(errText);
      detail = (errData as { detail?: string; message?: string }).detail
        || (errData as { message?: string }).message
        || `HTTP ${res.status}`;
    } catch {
      detail = errText.slice(0, 300) || detail;
    }
    console.error(`[uniswap] Swap error ${res.status}:`, errText.slice(0, 800));
    throw new Error(`Uniswap swap calldata failed: ${detail}`);
  }

  const data = await res.json() as { swap: UniswapSwapTx };

  // Validate response before returning
  if (!data.swap?.data || (data.swap.data as string) === "0x") {
    throw new Error("Uniswap returned empty swap data — the quote may have expired. Please retry.");
  }

  return data.swap;
}

// ── Gas estimation ────────────────────────────────────────────────────

/**
 * Calculate gas limit for a vault swap using Uniswap's gasUseEstimate
 * plus a fixed overhead for the vault adapter context.
 *
 * This avoids needing an RPC call for gas estimation.
 */
export function calculateVaultGasLimit(uniswapGasEstimate: string): bigint {
  const base = BigInt(uniswapGasEstimate || "300000");
  return base + VAULT_GAS_OVERHEAD;
}

// ── Format for display ─────────────────────────────────────────────────

/**
 * Format a Uniswap quote for display in the chat.
 */
export function formatUniswapQuoteForDisplay(
  intent: SwapIntent,
  quote: UniswapQuote,
): string {
  const isExactOutput = !!intent.amountOut;
  const output = quote.quote.output;
  const input = quote.quote.input;
  const outputAmount = formatTokenAmount(output.amount, quote.decimalsOut);
  const inputAmount = formatTokenAmount(input.amount, quote.decimalsIn);
  const gasLimit = calculateVaultGasLimit(quote.quote.gasUseEstimate);

  // Derive price from amounts
  const sellNum = parseFloat(inputAmount);
  const buyNum = parseFloat(outputAmount);
  let priceLine = "";
  if (sellNum > 0 && buyNum > 0) {
    const pricePerSell = buyNum / sellNum;
    const pricePerBuy = sellNum / buyNum;
    priceLine = `Price:    1 ${intent.tokenIn} = ${pricePerSell.toFixed(6)} ${intent.tokenOut}  (1 ${intent.tokenOut} = ${pricePerBuy.toFixed(6)} ${intent.tokenIn})`;
  }

  // For EXACT_OUTPUT, the buy amount is fixed and sell is estimated
  // For EXACT_INPUT, the sell amount is fixed and buy is estimated
  const sellLine = isExactOutput
    ? `Sell:     ~${inputAmount} ${intent.tokenIn} (estimated)`
    : `Sell:     ${intent.amountIn} ${intent.tokenIn}`;
  const buyLine = isExactOutput
    ? `Buy:      ${intent.amountOut} ${intent.tokenOut}`
    : `Buy:      ~${outputAmount} ${intent.tokenOut}`;

  const lines = [
    `📊 Swap Quote (${quote.routing})`,
    `─────────────────────────`,
    sellLine,
    buyLine,
    ...(priceLine ? [priceLine] : []),
    `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
    `Gas:      ~${quote.quote.gasFeeUSD ? "$" + quote.quote.gasFeeUSD : "estimating..."} (limit: ${gasLimit.toString()})`,
    `Route:    ${quote.routing}`,
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
  const frac = (value % divisor).toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${frac}`;
}
