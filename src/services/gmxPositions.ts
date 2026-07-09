/**
 * GMX v2 Positions Service
 *
 * Reads open GMX positions for a Rigoblock vault on Arbitrum. By default we use
 * the GMX v2 HTTP API, which returns full computed position data (`liquidationPrice`,
 * PnL, fees, leverage, and price impact) in a single HTTP request. If the API is
 * unavailable or fails, we fall back to the optimized `@gmx-io/sdk` path, which
 * itself only queries markets that actually hold positions.
 */

import { type Address, getAddress, zeroAddress } from "viem";
import { getClient } from "./rpcClient.js";
import { GMX_READER_ABI, GMX_ADDRESSES } from "../abi/gmx.js";
import {
  getGmxTickers,
  getGmxMarkets,
  getGmxTokenDecimals,
  warmTokenDecimalsCache,
  type GmxTickerPrice,
  type GmxMarketInfo,
} from "./gmxTrading.js";
import { createGmxSdk } from "./gmxSdk.js";
import type { PositionInfo, PositionsInfoData } from "@gmx-io/sdk/utils/positions";
import type { TokenData, TokensData } from "@gmx-io/sdk/utils/tokens";
import type { MarketsInfoData } from "@gmx-io/sdk/utils/markets";

export interface GmxPosition {
  market: string;
  collateralToken: string;
  isLong: boolean;
  sizeInUsd: string;
  sizeInUsdRaw: string;
  sizeInTokens: string;
  sizeInTokensRaw: string;
  collateralAmount: string;
  collateralAmountRaw: string;
  entryPrice: string;
  markPrice: string;
  leverage: string;
  unrealizedPnl: string;
  unrealizedPnlPercent: string;
  grossPnl: string;
  netValue: string;
  fundingFee: string;
  borrowingFee: string;
  closeFee: string;
  uiFee: string;
  priceImpact: string;
  totalCosts: string;
  liquidationPrice: string;
  marketSymbol: string;
  collateralSymbol: string;
  indexTokenSymbol: string;
  indexToken: string;
  longToken: string;
  shortToken: string;
}

export interface GmxPendingOrder {
  orderKey: string;
  market: string;
  collateralToken: string;
  isLong: boolean;
  orderType: string;
  sizeDeltaUsd: string;
  triggerPrice: string;
  acceptablePrice: string;
  marketSymbol: string;
}

export interface GmxPositionsSummary {
  positions: GmxPosition[];
  pendingOrders: GmxPendingOrder[];
  totalUnrealizedPnl: string;
  totalCollateralUsd: string;
  totalNetValueUsd: string;
  totalSizeUsd: string;
  formattedReport: string;
}

const GMX_API_BASE_URL = "https://arbitrum.gmxapi.io";

const ORDER_TYPE_LABELS: Record<number, string> = {
  0: "Market Swap",
  1: "Limit Swap",
  2: "Market Increase",
  3: "Limit Increase",
  4: "Market Decrease",
  5: "Limit Decrease",
  6: "Stop-Loss",
  7: "Liquidation",
};

/** Normalize isLong to boolean, handling both boolean and string inputs from LLMs. */
function normalizeIsLong(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

export function computeGmxLeverage(sizeUsd: number, positionCollateralUsd: number): number {
  return positionCollateralUsd > 0 ? sizeUsd / positionCollateralUsd : 0;
}

export function computeEffectiveCollateral(sizeUsd: number, leverage: number): number {
  return leverage > 0 ? sizeUsd / leverage : 0;
}

function rawToUsd(value: bigint): number {
  return Number(value) / 1e30;
}

function rawToTokenAmount(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatUsd(Math.abs(value))}`;
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function formatTokenValue(value: number): string {
  if (value < 0.001) return value.toExponential(4);
  if (value < 1) return value.toFixed(6);
  if (value < 1000) return value.toFixed(4);
  return value.toFixed(2);
}

/** GMX-style 4-decimal price formatting for entry, mark, and liquidation prices. */
function formatPrice4(value: number): string {
  if (value >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toExponential(4)}`;
}

function parseUsdString(s: string): number {
  return parseFloat(s.replace(/[+$,KM]/g, (m) => {
    if (m === "K") return "e3";
    if (m === "M") return "e6";
    return "";
  })) || 0;
}

function displaySymbol(token?: TokenData): string {
  return (token?.symbol || "???").replace(/\.v\d+$/i, "");
}

/**
 * Map an SDK PositionInfo object into our consumer-facing GmxPosition shape.
 */
export function buildGmxPositionFromSdk(info: PositionInfo): GmxPosition {
  const market = info.market;
  const indexToken = info.indexToken;
  const collateralToken = info.collateralToken;

  const indexSymbol = displaySymbol(indexToken);
  const collateralSymbol = displaySymbol(collateralToken);

  const indexDecimals = indexToken?.decimals ?? 18;
  const collateralDecimals = collateralToken?.decimals ?? 18;

  const sizeInUsd = info.sizeInUsd;
  const sizeInTokens = info.sizeInTokens;
  const collateralAmount = info.collateralAmount;

  const sizeUsdNum = rawToUsd(sizeInUsd);
  const entryPrice = info.entryPrice ? rawToUsd(info.entryPrice) : 0;
  const markPrice = rawToUsd(info.markPrice);
  const liquidationPrice = info.liquidationPrice ? rawToUsd(info.liquidationPrice) : 0;

  const collateralNum = rawToTokenAmount(collateralAmount, collateralDecimals);

  const grossPnl = rawToUsd(info.pnl);
  const netPnl = rawToUsd(info.pnlAfterAllFees);
  const netValue = rawToUsd(info.netValue);
  const pnlPercent = info.pnlAfterAllFeesPercentage
    ? Number(info.pnlAfterAllFeesPercentage) / 100
    : 0;
  const leverage = info.leverage ? Number(info.leverage) / 10_000 : 0;

  const borrowingFeeUsd = rawToUsd(info.pendingBorrowingFeesUsd);
  const fundingFeeUsd = rawToUsd(info.pendingFundingFeesUsd);
  const closeFeeUsd = rawToUsd(info.closingFeeUsd);
  const uiFeeUsd = rawToUsd(info.uiFeeUsd);
  const priceImpactUsd = rawToUsd(info.netPriceImapctDeltaUsd);

  const totalCostUsd = borrowingFeeUsd + fundingFeeUsd + closeFeeUsd + uiFeeUsd - priceImpactUsd;

  return {
    market: market.marketTokenAddress,
    collateralToken: info.collateralTokenAddress,
    isLong: info.isLong,
    sizeInUsd: formatUsd(sizeUsdNum),
    sizeInUsdRaw: sizeInUsd.toString(),
    sizeInTokens: formatTokenValue(rawToTokenAmount(sizeInTokens, indexDecimals)),
    sizeInTokensRaw: sizeInTokens.toString(),
    collateralAmount: formatTokenValue(collateralNum),
    collateralAmountRaw: collateralAmount.toString(),
    entryPrice: formatPrice4(entryPrice),
    markPrice: formatPrice4(markPrice),
    leverage: `${leverage.toFixed(1)}x`,
    unrealizedPnl: formatSignedUsd(netPnl),
    unrealizedPnlPercent: formatPercent(pnlPercent),
    grossPnl: formatSignedUsd(grossPnl),
    netValue: formatUsd(netValue),
    fundingFee: fundingFeeUsd > 0 ? formatSignedUsd(-fundingFeeUsd) : "$0.00",
    borrowingFee: borrowingFeeUsd > 0 ? formatSignedUsd(-borrowingFeeUsd) : "$0.00",
    closeFee: closeFeeUsd > 0 ? formatSignedUsd(-closeFeeUsd) : "$0.00",
    uiFee: uiFeeUsd > 0 ? formatSignedUsd(-uiFeeUsd) : "$0.00",
    priceImpact: formatSignedUsd(priceImpactUsd),
    totalCosts: totalCostUsd !== 0 ? formatSignedUsd(-totalCostUsd) : "$0.00",
    liquidationPrice: liquidationPrice > 0 ? formatPrice4(liquidationPrice) : "N/A",
    marketSymbol: `${indexSymbol}/USD`,
    collateralSymbol,
    indexTokenSymbol: indexSymbol,
    indexToken: market.indexTokenAddress,
    longToken: market.longTokenAddress,
    shortToken: market.shortTokenAddress,
  };
}

/** In-process cache for GMX markets metadata. Markets/token configs rarely change,
 *  so reusing them across "Refresh positions" clicks avoids refetching ~15 RPC calls
 *  on every subsequent read. Worker isolates are short-lived, so a 5-minute TTL is
 *  conservative and safe. */
let cachedMarketsInfoData: MarketsInfoData | undefined;
let cachedTokensData: TokensData | undefined;
let cachedMarketsTs = 0;
const GMX_MARKETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getGmxMarketsInfoData(sdk: Awaited<ReturnType<typeof createGmxSdk>>): Promise<{
  marketsInfoData: MarketsInfoData | undefined;
  tokensData: TokensData | undefined;
}> {
  const now = Date.now();
  if (cachedMarketsInfoData && cachedTokensData && now - cachedMarketsTs < GMX_MARKETS_CACHE_TTL) {
    return { marketsInfoData: cachedMarketsInfoData, tokensData: cachedTokensData };
  }

  const marketsInfo = await sdk.markets.getMarketsInfo();
  if (marketsInfo.marketsInfoData && marketsInfo.tokensData) {
    cachedMarketsInfoData = marketsInfo.marketsInfoData;
    cachedTokensData = marketsInfo.tokensData;
    cachedMarketsTs = now;
  }

  return {
    marketsInfoData: marketsInfo.marketsInfoData,
    tokensData: marketsInfo.tokensData,
  };
}

type GmxApiPosition = {
  marketAddress: Address;
  collateralTokenAddress: Address;
  indexName: string;
  poolName: string;
  isLong: boolean;
  sizeInUsd: string;
  sizeInTokens: string;
  collateralAmount: string;
  pnl: string;
  pnlPercentage: string;
  pnlAfterFees: string;
  pnlAfterFeesPercentage: string;
  pnlAfterAllFees: string;
  pnlAfterAllFeesPercentage: string;
  netValue: string;
  netValueAfterAllFees: string;
  leverage: string;
  markPrice: string;
  entryPrice: string;
  liquidationPrice: string;
  closingFeeUsd: string;
  uiFeeUsd: string;
  pendingFundingFeesUsd: string;
  pendingBorrowingFeesUsd: string;
  pendingClaimableFundingFeesUsd: string;
  netPriceImapctDeltaUsd: string;
  priceImpactDiffUsd: string;
  pendingImpactUsd: string;
  closePriceImpactDeltaUsd: string;
  hasLowCollateral: boolean;
};

/**
 * Fetch open GMX positions from the GMX v2 HTTP API.
 *
 * This avoids every RPC call related to position scanning because the API
 * returns full computed position data (mark price, entry price, leverage,
 * liquidation price, PnL, fees, net value) in a single HTTP request.
 */
async function fetchGmxApiPositions(
  vaultAddress: Address,
): Promise<GmxApiPosition[]> {
  const url = `${GMX_API_BASE_URL}/v1/positions?address=${vaultAddress.toLowerCase()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GMX API positions request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as GmxApiPosition[];
  return data ?? [];
}

function buildGmxPositionFromApi(
  position: GmxApiPosition,
  marketInfo: GmxMarketInfo | undefined,
  tickerMap: Map<string, GmxTickerPrice>,
): GmxPosition {
  const marketAddress = getAddress(position.marketAddress);
  const collateralToken = getAddress(position.collateralTokenAddress);
  const indexToken = getAddress(marketInfo?.indexToken ?? position.marketAddress);

  const collateralDecimals = getGmxTokenDecimals(collateralToken);
  const indexDecimals = getGmxTokenDecimals(indexToken);

  const sizeInUsd = BigInt(position.sizeInUsd ?? "0");
  const sizeInTokens = BigInt(position.sizeInTokens ?? "0");
  const collateralAmount = BigInt(position.collateralAmount ?? "0");
  const pnl = BigInt(position.pnl ?? "0");
  const pnlAfterAllFees = BigInt(position.pnlAfterAllFees ?? "0");
  const netValue = BigInt(position.netValue ?? "0");
  const leverage = Number(position.leverage ?? "0");
  const markPrice = BigInt(position.markPrice ?? "0");
  const entryPrice = BigInt(position.entryPrice ?? "0");
  const liquidationPrice = BigInt(position.liquidationPrice ?? "0");
  const closingFeeUsd = BigInt(position.closingFeeUsd ?? "0");
  const uiFeeUsd = BigInt(position.uiFeeUsd ?? "0");
  const pendingFundingFeesUsd = BigInt(position.pendingFundingFeesUsd ?? "0");
  const pendingBorrowingFeesUsd = BigInt(position.pendingBorrowingFeesUsd ?? "0");
  const netPriceImpactDeltaUsd = BigInt(position.netPriceImapctDeltaUsd ?? "0");

  const indexName = position.indexName ?? "";
  const marketSymbol = indexName;
  const indexTokenSymbol =
    indexName.split("/")[0] || marketInfo?.indexTokenSymbol || "";
  const collateralSymbol =
    (collateralToken.toLowerCase() === marketInfo?.longToken.toLowerCase()
      ? marketInfo?.longTokenSymbol
      : collateralToken.toLowerCase() === marketInfo?.shortToken.toLowerCase()
        ? marketInfo?.shortTokenSymbol
        : undefined) ||
    tickerMap.get(collateralToken.toLowerCase())?.tokenSymbol ||
    "";

  const sizeUsdNum = rawToUsd(sizeInUsd);
  const entryPriceNum = entryPrice > 0n ? rawToUsd(entryPrice) : 0;
  const markPriceNum = rawToUsd(markPrice);
  const liquidationPriceNum = liquidationPrice > 0n ? rawToUsd(liquidationPrice) : 0;
  const collateralNum = rawToTokenAmount(collateralAmount, collateralDecimals);

  const grossPnl = rawToUsd(pnl);
  const netPnl = rawToUsd(pnlAfterAllFees);
  const netValueNum = rawToUsd(netValue);
  const pnlPercent = position.pnlAfterAllFeesPercentage
    ? Number(position.pnlAfterAllFeesPercentage) / 100
    : 0;
  const leverageNum = leverage / 10_000;

  const borrowingFeeUsd = rawToUsd(pendingBorrowingFeesUsd);
  const fundingFeeUsd = rawToUsd(pendingFundingFeesUsd);
  const closeFeeUsd = rawToUsd(closingFeeUsd);
  const uiFeeUsdNum = rawToUsd(uiFeeUsd);
  const priceImpactUsd = rawToUsd(netPriceImpactDeltaUsd);

  const totalCostUsd = borrowingFeeUsd + fundingFeeUsd + closeFeeUsd + uiFeeUsdNum - priceImpactUsd;

  return {
    market: marketAddress,
    collateralToken,
    isLong: position.isLong,
    sizeInUsd: formatUsd(sizeUsdNum),
    sizeInUsdRaw: sizeInUsd.toString(),
    sizeInTokens: formatTokenValue(rawToTokenAmount(sizeInTokens, indexDecimals)),
    sizeInTokensRaw: sizeInTokens.toString(),
    collateralAmount: formatTokenValue(collateralNum),
    collateralAmountRaw: collateralAmount.toString(),
    entryPrice: formatPrice4(entryPriceNum),
    markPrice: formatPrice4(markPriceNum),
    leverage: `${leverageNum.toFixed(1)}x`,
    unrealizedPnl: formatSignedUsd(netPnl),
    unrealizedPnlPercent: formatPercent(pnlPercent),
    grossPnl: formatSignedUsd(grossPnl),
    netValue: formatUsd(netValueNum),
    fundingFee: fundingFeeUsd > 0 ? formatSignedUsd(-fundingFeeUsd) : "$0.00",
    borrowingFee: borrowingFeeUsd > 0 ? formatSignedUsd(-borrowingFeeUsd) : "$0.00",
    closeFee: closeFeeUsd > 0 ? formatSignedUsd(-closeFeeUsd) : "$0.00",
    uiFee: uiFeeUsdNum > 0 ? formatSignedUsd(-uiFeeUsdNum) : "$0.00",
    priceImpact: formatSignedUsd(priceImpactUsd),
    totalCosts: totalCostUsd !== 0 ? formatSignedUsd(-totalCostUsd) : "$0.00",
    liquidationPrice: liquidationPriceNum > 0 ? formatPrice4(liquidationPriceNum) : "N/A",
    marketSymbol,
    collateralSymbol,
    indexTokenSymbol,
    indexToken,
    longToken: marketInfo?.longToken ?? zeroAddress,
    shortToken: marketInfo?.shortToken ?? zeroAddress,
  };
}

/**
 * Fetch all open GMX positions for a vault (Arbitrum only).
 *
 * By default, positions are read from the GMX v2 HTTP API, which returns full
 * computed position data in a single HTTP request. If the API fails or returns
 * no data, we fall back to the GMX SDK path (which is itself optimized to only
 * query markets that actually hold positions).
 */
export async function getGmxPositions(
  vaultAddress: Address,
  alchemyKey?: string,
  useApi = true,
): Promise<GmxPosition[]> {
  if (useApi) {
    try {
      const apiPositions = await fetchGmxApiPositions(vaultAddress);
      if (apiPositions.length === 0) {
        return [];
      }

      const markets = await getGmxMarkets();
      const marketMap = new Map(markets.map((m) => [m.marketToken.toLowerCase(), m]));
      const tickers = await getGmxTickers();
      const tickerMap = new Map(tickers.map((t) => [t.tokenAddress.toLowerCase(), t]));
      await warmTokenDecimalsCache(tickers, alchemyKey);

      const positions: GmxPosition[] = [];
      for (const position of apiPositions) {
        if (BigInt(position.sizeInUsd ?? "0") === 0n) continue;
        const marketInfo = marketMap.get(position.marketAddress.toLowerCase());
        positions.push(buildGmxPositionFromApi(position, marketInfo, tickerMap));
      }
      return positions;
    } catch (apiError) {
      console.warn(
        "GMX API positions fetch failed, falling back to SDK:",
        apiError instanceof Error ? apiError.message : String(apiError),
      );
    }
  }

  return getGmxPositionsFromSdk(vaultAddress, alchemyKey);
}

/**
 * Fetch open GMX positions using the official SDK.
 *
 * Optimization: instead of asking the SDK to enumerate all possible position keys
 * across every market, we first read the vault's actual positions with
 * `getAccountPositions`, then fetch position info only for the markets that have
 * an open position. For a vault with one position this reduces the position scan
 * from ~100 possible keys to ~4, and skips the SDK's all-markets referral/info
 * overhead.
 */
async function getGmxPositionsFromSdk(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPosition[]> {
  const sdk = createGmxSdk(vaultAddress, alchemyKey);
  const client = getClient(42161, alchemyKey);

  // 1. Discover the vault's actual positions first.
  const accountPositions = await client.readContract({
    address: GMX_ADDRESSES.READER,
    abi: GMX_READER_ABI,
    functionName: "getAccountPositions",
    args: [GMX_ADDRESSES.DATA_STORE, vaultAddress, 0n, 1000n],
  }) as unknown as {
    addresses: { account: Address; market: Address; collateralToken: Address };
    numbers: { sizeInUsd: bigint; sizeInTokens: bigint; collateralAmount: bigint };
    flags: { isLong: boolean };
  }[];

  if (!accountPositions || accountPositions.length === 0) {
    return [];
  }

  // 2. Load markets metadata (cached) so we can build MarketInfo for the
  //    position-specific markets only.
  const { marketsInfoData, tokensData } = await getGmxMarketsInfoData(sdk);
  if (!marketsInfoData || !tokensData) {
    return [];
  }

  const positionMarkets = new Set(
    accountPositions.map((p) => p.addresses.market.toLowerCase()),
  );

  const filteredMarketsInfoData: MarketsInfoData = Object.fromEntries(
    Object.entries(marketsInfoData).filter(
      ([marketAddress]) => positionMarkets.has(marketAddress.toLowerCase()),
    ),
  );

  if (Object.keys(filteredMarketsInfoData).length === 0) {
    return [];
  }

  // 3. Fetch position info only for the markets that have positions.
  //    Passing a filtered marketsInfoData prevents the SDK from enumerating
  //    position keys across every GMX market.
  const positionsInfoData: PositionsInfoData = await sdk.positions.getPositionsInfo({
    marketsInfoData: filteredMarketsInfoData,
    tokensData,
    showPnlInLeverage: true,
  });

  const positions: GmxPosition[] = [];
  for (const info of Object.values(positionsInfoData)) {
    if (!info || info.sizeInUsd === 0n) continue;
    positions.push(buildGmxPositionFromSdk(info));
  }

  return positions;
}

/**
 * Find a specific GMX position by market, direction, and optionally collateral.
 */
export async function findGmxPosition(
  vaultAddress: Address,
  marketSymbol: string,
  isLongArg: unknown,
  alchemyKey?: string,
  collateralSymbolHint?: string,
): Promise<GmxPosition> {
  const positions = await getGmxPositions(vaultAddress, alchemyKey);
  const isLong = normalizeIsLong(isLongArg);
  const sym = marketSymbol.toUpperCase();

  const candidates = positions.filter(
    (p) => p.indexTokenSymbol.toUpperCase() === sym && p.isLong === isLong,
  );

  if (candidates.length === 0) {
    const available = positions
      .map((p) => `${p.indexTokenSymbol} ${p.isLong ? "long" : "short"} (${p.collateralSymbol})`)
      .join(", ") || "none";
    throw new Error(
      `No open ${isLong ? "long" : "short"} ${sym} position found for this vault. ` +
      `Open positions: ${available}.`,
    );
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const hint = (collateralSymbolHint || "").toUpperCase();
  const byCollateral = hint
    ? candidates.find((p) => p.collateralSymbol.toUpperCase() === hint)
    : undefined;

  if (byCollateral) {
    return byCollateral;
  }

  const list = candidates.map(
    (p) => `${p.collateralSymbol} ${p.isLong ? "long" : "short"} ${p.sizeInUsd}`
  ).join(", ");
  throw new Error(
    `Multiple ${isLong ? "long" : "short"} ${sym} positions found: ${list}. ` +
    `Specify collateral token (e.g., collateral="WETH") to disambiguate.`,
  );
}

/**
 * Fetch all pending GMX orders for a vault.
 *
 * This still uses the Reader contract directly because the SDK order helpers are
 * oriented around building new orders; reading existing pending orders is a simple
 * contract call.
 */
export async function getGmxPendingOrders(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPendingOrder[]> {
  const client = getClient(42161, alchemyKey);

  const [rawOrders, markets, tickers] = await Promise.all([
    client.readContract({
      address: GMX_ADDRESSES.READER,
      abi: GMX_READER_ABI,
      functionName: "getAccountOrders",
      args: [GMX_ADDRESSES.DATA_STORE, vaultAddress, 0n, 100n],
    }),
    getGmxMarkets(),
    getGmxTickers(),
  ]);

  if (!rawOrders || rawOrders.length === 0) return [];

  const tickerMap = new Map<string, GmxTickerPrice>();
  for (const t of tickers) {
    tickerMap.set(t.tokenAddress.toLowerCase(), t);
  }

  const marketMap = new Map<string, string>();
  const marketIndexDecimalsMap = new Map<string, number>();
  for (const m of markets) {
    const indexTicker = tickerMap.get(m.indexToken.toLowerCase());
    const displaySymbol = (indexTicker?.tokenSymbol || "???").replace(/\.v\d+$/i, "");
    marketMap.set(m.marketToken.toLowerCase(), `${displaySymbol}/USD`);
    marketIndexDecimalsMap.set(m.marketToken.toLowerCase(), getGmxTokenDecimals(m.indexToken));
  }

  return rawOrders.map((o: any) => {
    const orderType = Number(o.order.numbers.orderType);
    const sizeDelta = Number(o.order.numbers.sizeDeltaUsd) / 1e30;
    const indexDecimals = marketIndexDecimalsMap.get(o.order.addresses.market.toLowerCase()) ?? 18;
    const priceDivisor = 10 ** (30 - indexDecimals);
    const trigger = Number(o.order.numbers.triggerPrice) / priceDivisor;
    const acceptable = Number(o.order.numbers.acceptablePrice) / priceDivisor;

    return {
      orderKey: o.orderKey,
      market: o.order.addresses.market,
      collateralToken: o.order.addresses.initialCollateralToken,
      isLong: o.order.flags.isLong,
      orderType: ORDER_TYPE_LABELS[orderType] || `Type ${orderType}`,
      sizeDeltaUsd: formatUsd(sizeDelta),
      triggerPrice: trigger > 0 ? `$${trigger.toFixed(2)}` : "Market",
      acceptablePrice: acceptable > 0 && acceptable < 1e20 ? `$${acceptable.toFixed(2)}` : "Any",
      marketSymbol: marketMap.get(o.order.addresses.market.toLowerCase()) || "???/USD",
    };
  });
}

/**
 * Fetch a full positions summary with a formatted report for the chat.
 */
export async function getGmxPositionsSummary(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPositionsSummary> {
  // Warm token decimals so pending-order formatting is accurate even though
  // the SDK-based position read no longer does it.
  await warmTokenDecimalsCache(await getGmxTickers(), alchemyKey);

  const [positions, pendingOrders] = await Promise.all([
    getGmxPositions(vaultAddress, alchemyKey),
    getGmxPendingOrders(vaultAddress, alchemyKey),
  ]);

  let totalNetPnl = 0;
  let totalNetValue = 0;
  let totalSize = 0;

  for (const p of positions) {
    totalNetPnl += parseUsdString(p.unrealizedPnl);
    totalNetValue += parseUsdString(p.netValue);
    totalSize += parseUsdString(p.sizeInUsd);
  }

  const totalCollateralUsd = positions.reduce((sum, p) => {
    const netValue = parseUsdString(p.netValue);
    const netPnl = parseUsdString(p.unrealizedPnl);
    return sum + (netValue - netPnl);
  }, 0);

  const formattedReport = formatPositionsReport(
    positions,
    pendingOrders,
    totalNetPnl,
    totalNetValue,
    totalSize,
    vaultAddress,
  );

  return {
    positions,
    pendingOrders,
    totalUnrealizedPnl: formatSignedUsd(totalNetPnl),
    totalCollateralUsd: formatUsd(totalCollateralUsd),
    totalNetValueUsd: formatUsd(totalNetValue),
    totalSizeUsd: formatUsd(totalSize),
    formattedReport,
  };
}

function formatPositionsReport(
  positions: GmxPosition[],
  pendingOrders: GmxPendingOrder[],
  totalNetPnl: number,
  totalNetValue: number,
  totalSize: number,
  vaultAddress?: string,
): string {
  const lines: string[] = [];

  if (positions.length === 0 && pendingOrders.length === 0) {
    return "📋 No open GMX positions or pending orders for this vault.";
  }

  lines.push("📊 GMX Positions");
  lines.push("");

  if (positions.length > 0) {
    const pnlEmoji = totalNetPnl >= 0 ? "🟢" : "🔴";
    lines.push(
      `${pnlEmoji} Total Net PnL: ${formatSignedUsd(totalNetPnl)}  |  Net Value: ${formatUsd(totalNetValue)}  |  Size: ${formatUsd(totalSize)}  |  Positions: ${positions.length}`,
    );
    lines.push("");

    lines.push("| Market | Side | Size | Net Value | Leverage | Net PnL | Entry | Mark | Liq Price |");
    lines.push("|--------|------|------|-----------|----------|---------|-------|------|-----------|");

    for (const pos of positions) {
      const side = pos.isLong ? "LONG" : "SHORT";
      lines.push(
        `| ${pos.marketSymbol} | ${side} | ${pos.sizeInUsd} | ${pos.netValue} | ${pos.leverage} | ${pos.unrealizedPnl} (${pos.unrealizedPnlPercent}) | ${pos.entryPrice} | ${pos.markPrice} | ${pos.liquidationPrice} |`,
      );
    }
    lines.push("");
  }

  if (pendingOrders.length > 0) {
    lines.push(`⏳ Pending Orders (${pendingOrders.length})`);
    lines.push("");
    lines.push("| Market | Side | Type | Size | Trigger |");
    lines.push("|--------|------|------|------|---------|");

    for (const order of pendingOrders) {
      const dir = order.isLong ? "LONG" : "SHORT";
      lines.push(
        `| ${order.marketSymbol} | ${dir} | ${order.orderType} | ${order.sizeDeltaUsd} | ${order.triggerPrice} |`,
      );
    }
    lines.push("");
  }

  if (vaultAddress) {
    const portfolioUrl = `https://app.gmx.io/#/accounts/${vaultAddress}?network=arbitrum&v=2`;
    lines.push(`[View positions on GMX](${portfolioUrl})`);
  }

  return lines.join("\n");
}
