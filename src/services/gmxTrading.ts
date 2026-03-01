/**
 * GMX v2 Perpetuals Trading Service
 *
 * Builds unsigned transactions for GMX perpetual operations through the
 * Rigoblock vault adapter. Operations are sent TO the vault address;
 * the Rigoblock protocol routes them to GMX via the AGmxV2 adapter.
 *
 * Key differences from direct GMX interaction:
 *   - No multicall: The adapter handles WETH wrapping + collateral transfer internally.
 *   - Execution fee is auto-computed on-chain by the adapter.
 *   - Security fields (receiver, cancellationReceiver, etc.) are overridden by the adapter.
 *   - Only perps (no swaps on GMX) — use Uniswap/0x for swaps.
 *   - Arbitrum only (chainId 42161).
 *
 * Flow: user asks agent → agent builds calldata → vault.createIncreaseOrder(params)
 *       → adapter validates + transfers collateral to GMX OrderVault
 *       → GMX keeper executes at next oracle update
 */

import {
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  RIGOBLOCK_GMX_ABI,
  GMX_API_URL,
  GMX_ADDRESSES,
  GmxOrderType,
  GmxDecreasePositionSwapType,
  ARBITRUM_CHAIN_ID,
} from "../abi/gmx.js";
import type { Env } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface GmxMarketInfo {
  marketToken: string;
  indexToken: string;
  longToken: string;
  shortToken: string;
  indexTokenSymbol?: string;
  longTokenSymbol?: string;
  shortTokenSymbol?: string;
}

export interface GmxTickerPrice {
  tokenAddress: string;
  tokenSymbol: string;
  minPrice: string;
  maxPrice: string;
  updatedAt: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/** GMX uses 10^30 for USD amounts (sizeDeltaUsd, acceptablePrice, etc.) */
const USD_DECIMALS = 30;

/** Default gas limit for GMX order transactions via the vault adapter */
const GMX_GAS_LIMIT = 3_000_000n;

// ── Market cache ───────────────────────────────────────────────────────

let marketsCache: GmxMarketInfo[] | null = null;
let marketsCacheTime = 0;
const MARKETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Ticker/price cache ─────────────────────────────────────────────────

let tickersCache: GmxTickerPrice[] | null = null;
let tickersCacheTime = 0;
const TICKERS_CACHE_TTL = 10 * 1000; // 10 seconds

// ── Fetch helpers ──────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  maxRetries = 2,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (attempt === maxRetries) return res;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error("Unreachable");
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Fetch GMX markets from the REST API.
 */
export async function getGmxMarkets(): Promise<GmxMarketInfo[]> {
  const now = Date.now();
  if (marketsCache && now - marketsCacheTime < MARKETS_CACHE_TTL) {
    return marketsCache;
  }

  const res = await fetchWithRetry(`${GMX_API_URL}/markets`);
  if (!res.ok) {
    throw new Error(`Failed to fetch GMX markets: ${res.status}`);
  }

  const data = (await res.json()) as { markets: GmxMarketInfo[] } | GmxMarketInfo[];
  marketsCache = Array.isArray(data) ? data : data.markets;
  marketsCacheTime = now;
  return marketsCache;
}

/**
 * Fetch GMX ticker prices from the REST API.
 */
export async function getGmxTickers(): Promise<GmxTickerPrice[]> {
  const now = Date.now();
  if (tickersCache && now - tickersCacheTime < TICKERS_CACHE_TTL) {
    return tickersCache;
  }

  const res = await fetchWithRetry(`${GMX_API_URL}/prices/tickers`);
  if (!res.ok) {
    throw new Error(`Failed to fetch GMX tickers: ${res.status}`);
  }

  const data = (await res.json()) as GmxTickerPrice[];
  tickersCache = data;
  tickersCacheTime = now;
  return tickersCache;
}

/**
 * Find a GMX market by index token symbol (e.g. "ETH", "BTC", "ARB").
 * Returns the market with the highest liquidity for that index token.
 */
export async function findGmxMarket(
  indexTokenSymbol: string,
): Promise<GmxMarketInfo> {
  const markets = await getGmxMarkets();
  const tickers = await getGmxTickers();

  // Build token symbol map from tickers
  const tokenSymbolMap = new Map<string, string>();
  for (const t of tickers) {
    tokenSymbolMap.set(t.tokenAddress.toLowerCase(), t.tokenSymbol);
  }

  // Find matching markets — strip trailing USD/USDC/PERP suffixes
  const symbol = indexTokenSymbol.toUpperCase().replace(/(?:USD[CT]?|PERP)$/i, "");
  const matching = markets.filter((m) => {
    const idxSymbol = tokenSymbolMap.get(m.indexToken.toLowerCase());
    return idxSymbol?.toUpperCase() === symbol;
  });

  if (matching.length === 0) {
    // List available markets for the error message
    const available = new Set<string>();
    for (const m of markets) {
      const s = tokenSymbolMap.get(m.indexToken.toLowerCase());
      if (s) available.add(s);
    }
    throw new Error(
      `No GMX market found for "${indexTokenSymbol}". Available: ${[...available].sort().join(", ")}`,
    );
  }

  // Enrich with symbols
  for (const m of matching) {
    m.indexTokenSymbol = tokenSymbolMap.get(m.indexToken.toLowerCase());
    m.longTokenSymbol = tokenSymbolMap.get(m.longToken.toLowerCase());
    m.shortTokenSymbol = tokenSymbolMap.get(m.shortToken.toLowerCase());
  }

  // Prefer market where collateral = WETH or USDC for simplicity
  const preferred = matching.find(
    (m) =>
      m.longToken.toLowerCase() === GMX_ADDRESSES.WETH.toLowerCase() ||
      m.shortTokenSymbol?.toUpperCase() === "USDC",
  );

  return preferred || matching[0];
}

/**
 * Get the current price for a token from GMX tickers.
 * Returns price in USD with standard precision.
 */
export async function getGmxTokenPrice(
  tokenAddress: string,
): Promise<{ min: number; max: number; mid: number }> {
  const tickers = await getGmxTickers();
  const ticker = tickers.find(
    (t) => t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
  );

  if (!ticker) {
    throw new Error(`No GMX price found for token ${tokenAddress}`);
  }

  // GMX prices are in 10^30 format
  const min = Number(BigInt(ticker.minPrice)) / 1e30;
  const max = Number(BigInt(ticker.maxPrice)) / 1e30;
  return { min, max, mid: (min + max) / 2 };
}

/**
 * Resolve a token symbol to its collateral address on Arbitrum for GMX.
 * Common mappings: ETH/WETH → WETH, USDC → USDC, etc.
 */
export function resolveGmxCollateral(
  symbol: string,
): Address {
  const s = symbol.toUpperCase();
  const TOKEN_MAP: Record<string, Address> = {
    ETH: GMX_ADDRESSES.WETH,
    WETH: GMX_ADDRESSES.WETH,
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
    "USDC.E": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" as Address,
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address,
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" as Address,
    WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" as Address,
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548" as Address,
    LINK: "0xf97f4df75e6c8e0ce7fec36ad7c4e12f3a1c33d8" as Address,
    UNI: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0" as Address,
    SOL: "0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07" as Address,
  };
  const addr = TOKEN_MAP[s];
  if (!addr) {
    throw new Error(
      `Unknown GMX collateral token: ${symbol}. Supported: ${Object.keys(TOKEN_MAP).join(", ")}`,
    );
  }
  return addr;
}

// ── Order building ─────────────────────────────────────────────────────

/**
 * Build params for createIncreaseOrder (open or add to a long/short position).
 *
 * @param market - GMX market address
 * @param collateralToken - Collateral token address
 * @param collateralAmount - Amount of collateral in human-readable units (e.g. "0.5" ETH)
 * @param collateralDecimals - Decimals of collateral token
 * @param sizeDeltaUsd - Position size in USD (human-readable, e.g. "5000")
 * @param isLong - true for long, false for short
 * @param acceptablePriceUsd - Max acceptable execution price for longs, min for shorts (human-readable USD)
 */
export function buildCreateIncreaseOrderCalldata(params: {
  market: Address;
  collateralToken: Address;
  collateralAmount: string;
  collateralDecimals: number;
  sizeDeltaUsd: string;
  isLong: boolean;
  acceptablePriceUsd?: string;
}): Hex {
  const collateralRaw = parseUnits(params.collateralAmount, params.collateralDecimals);
  const sizeRaw = parseUnits(params.sizeDeltaUsd, USD_DECIMALS);

  // Acceptable price: for longs, set very high (type(uint256).max in practice);
  // for shorts, set 0 — GMX will use market price.
  // If user specifies, convert to 10^30.
  let acceptablePrice: bigint;
  if (params.acceptablePriceUsd) {
    acceptablePrice = parseUnits(params.acceptablePriceUsd, USD_DECIMALS);
  } else {
    // For longs: max acceptable price (willing to pay up to market)
    // For shorts: 0 (willing to sell at market or better)
    acceptablePrice = params.isLong
      ? BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") // type(uint256).max
      : 0n;
  }

  const createOrderParams = {
    addresses: {
      receiver: ZERO_ADDRESS,           // overridden by adapter
      cancellationReceiver: ZERO_ADDRESS, // overridden by adapter
      callbackContract: ZERO_ADDRESS,    // overridden by adapter
      uiFeeReceiver: ZERO_ADDRESS,       // overridden by adapter
      market: params.market,
      initialCollateralToken: params.collateralToken,
      swapPath: [] as Address[],         // overridden by adapter
    },
    numbers: {
      sizeDeltaUsd: sizeRaw,
      initialCollateralDeltaAmount: collateralRaw,
      triggerPrice: 0n,
      acceptablePrice,
      executionFee: 0n,                  // auto-computed by adapter
      callbackGasLimit: 0n,              // overridden by adapter
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: GmxOrderType.MarketIncrease,
    decreasePositionSwapType: GmxDecreasePositionSwapType.NoSwap,
    isLong: params.isLong,
    shouldUnwrapNativeToken: false,       // overridden by adapter
    autoCancel: false,
    referralCode: ZERO_BYTES32,           // overridden by adapter
    dataList: [] as Hex[],                // overridden by adapter
  };

  return encodeFunctionData({
    abi: RIGOBLOCK_GMX_ABI,
    functionName: "createIncreaseOrder",
    args: [createOrderParams],
  });
}

/**
 * Build params for createDecreaseOrder (reduce or close a long/short position).
 *
 * @param market - GMX market address
 * @param collateralToken - Collateral token address used in the position
 * @param collateralDeltaAmount - Amount of collateral to withdraw (human-readable). Set "0" to decrease size only.
 * @param collateralDecimals - Decimals of collateral token
 * @param sizeDeltaUsd - Position size to decrease in USD (human-readable)
 * @param isLong - true for long, false for short (must match existing position)
 * @param orderType - MarketDecrease, LimitDecrease, or StopLossDecrease
 * @param triggerPriceUsd - Trigger price for limit/stop-loss orders (human-readable USD)
 * @param acceptablePriceUsd - Acceptable execution price (human-readable USD)
 */
export function buildCreateDecreaseOrderCalldata(params: {
  market: Address;
  collateralToken: Address;
  collateralDeltaAmount: string;
  collateralDecimals: number;
  sizeDeltaUsd: string;
  isLong: boolean;
  orderType?: GmxOrderType;
  triggerPriceUsd?: string;
  acceptablePriceUsd?: string;
}): Hex {
  const collateralRaw = parseUnits(params.collateralDeltaAmount, params.collateralDecimals);
  const sizeRaw = parseUnits(params.sizeDeltaUsd, USD_DECIMALS);

  const orderType = params.orderType ?? GmxOrderType.MarketDecrease;

  // Validate order type
  if (
    orderType !== GmxOrderType.MarketDecrease &&
    orderType !== GmxOrderType.LimitDecrease &&
    orderType !== GmxOrderType.StopLossDecrease
  ) {
    throw new Error("Decrease order type must be MarketDecrease, LimitDecrease, or StopLossDecrease");
  }

  const triggerPrice = params.triggerPriceUsd
    ? parseUnits(params.triggerPriceUsd, USD_DECIMALS)
    : 0n;

  // For decrease/close: longs want min acceptable price = 0 (any price),
  // shorts want max acceptable = type(uint256).max
  let acceptablePrice: bigint;
  if (params.acceptablePriceUsd) {
    acceptablePrice = parseUnits(params.acceptablePriceUsd, USD_DECIMALS);
  } else {
    acceptablePrice = params.isLong
      ? 0n // longs selling: accept any
      : BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"); // shorts closing: accept any
  }

  const createOrderParams = {
    addresses: {
      receiver: ZERO_ADDRESS,
      cancellationReceiver: ZERO_ADDRESS,
      callbackContract: ZERO_ADDRESS,
      uiFeeReceiver: ZERO_ADDRESS,
      market: params.market,
      initialCollateralToken: params.collateralToken,
      swapPath: [] as Address[],
    },
    numbers: {
      sizeDeltaUsd: sizeRaw,
      initialCollateralDeltaAmount: collateralRaw,
      triggerPrice,
      acceptablePrice,
      executionFee: 0n,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType,
    decreasePositionSwapType: GmxDecreasePositionSwapType.NoSwap, // forced by adapter
    isLong: params.isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: orderType === GmxOrderType.StopLossDecrease,
    referralCode: ZERO_BYTES32,
    dataList: [] as Hex[],                // overridden by adapter
  };

  return encodeFunctionData({
    abi: RIGOBLOCK_GMX_ABI,
    functionName: "createDecreaseOrder",
    args: [createOrderParams],
  });
}

/**
 * Build calldata for updateOrder (modify a pending limit/stop-loss order).
 */
export function buildUpdateOrderCalldata(params: {
  orderKey: Hex;
  sizeDeltaUsd: string;
  acceptablePriceUsd: string;
  triggerPriceUsd: string;
  minOutputAmount?: string;
  validFromTime?: number;
  autoCancel?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_GMX_ABI,
    functionName: "updateOrder",
    args: [
      params.orderKey,
      parseUnits(params.sizeDeltaUsd, USD_DECIMALS),
      parseUnits(params.acceptablePriceUsd, USD_DECIMALS),
      parseUnits(params.triggerPriceUsd, USD_DECIMALS),
      params.minOutputAmount ? parseUnits(params.minOutputAmount, USD_DECIMALS) : 0n,
      BigInt(params.validFromTime ?? 0),
      params.autoCancel ?? false,
    ],
  });
}

/**
 * Build calldata for cancelOrder.
 */
export function buildCancelOrderCalldata(orderKey: Hex): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_GMX_ABI,
    functionName: "cancelOrder",
    args: [orderKey],
  });
}

/**
 * Build calldata for claimFundingFees.
 */
export function buildClaimFundingFeesCalldata(params: {
  markets: Address[];
  tokens: Address[];
}): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_GMX_ABI,
    functionName: "claimFundingFees",
    args: [
      params.markets,
      params.tokens,
      ZERO_ADDRESS, // receiver — overridden by adapter to pool
    ],
  });
}

/**
 * Build calldata for claimCollateral.
 */
export function buildClaimCollateralCalldata(params: {
  markets: Address[];
  tokens: Address[];
  timeKeys: bigint[];
}): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_GMX_ABI,
    functionName: "claimCollateral",
    args: [
      params.markets,
      params.tokens,
      params.timeKeys,
      ZERO_ADDRESS, // receiver — overridden by adapter to pool
    ],
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute leverage as sizeDeltaUsd / (collateralAmount * collateralPrice).
 */
export function computeLeverage(
  sizeDeltaUsd: number,
  collateralAmount: number,
  collateralPriceUsd: number,
): number {
  const collateralValue = collateralAmount * collateralPriceUsd;
  if (collateralValue <= 0) return 0;
  return sizeDeltaUsd / collateralValue;
}

/**
 * Get the decimals for a known GMX collateral token on Arbitrum.
 */
export function getGmxTokenDecimals(tokenAddress: string): number {
  const addr = tokenAddress.toLowerCase();
  const DECIMALS: Record<string, number> = {
    // WETH
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18,
    // USDC
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6,
    // USDC.e
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": 6,
    // USDT
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6,
    // DAI
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": 18,
    // WBTC
    "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": 8,
    // ARB
    "0x912ce59144191c1204e64559fe8253a0e49e6548": 18,
    // LINK
    "0xf97f4df75e6c8e0ce7fec36ad7c4e12f3a1c33d8": 18,
    // UNI
    "0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0": 18,
    // SOL
    "0x2bcc6d6cdbbdc0a4071e48bb3b969b06b3330c07": 9,
  };
  return DECIMALS[addr] ?? 18;
}

/**
 * Format USD amount from GMX raw format (10^30) to human readable.
 */
export function formatGmxUsd(rawUsd: bigint): string {
  // raw is in 10^30
  const usd = Number(rawUsd) / 1e30;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(2)}K`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format token amount from raw to human readable.
 */
export function formatGmxTokenAmount(raw: bigint, decimals: number): string {
  const value = Number(raw) / 10 ** decimals;
  if (value < 0.001) return value.toExponential(4);
  if (value < 1) return value.toFixed(6);
  if (value < 1000) return value.toFixed(4);
  return value.toFixed(2);
}

/**
 * Get default gas limit for GMX operations via the vault.
 */
export function getGmxGasLimit(): bigint {
  return GMX_GAS_LIMIT;
}
