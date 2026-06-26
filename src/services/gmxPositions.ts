/**
 * GMX v2 Positions Service
 *
 * Uses the official `@gmx-io/sdk` v1 client to read open GMX positions for a
 * Rigoblock vault on Arbitrum. The SDK returns `liquidationPrice`, PnL, fees,
 * leverage, and price impact directly, so we no longer need to maintain a
 * manual reimplementation of the GMX liquidation math or DataStore parameter
 * fetching.
 */

import { type Address } from "viem";
import { getClient } from "./vault.js";
import { GMX_READER_ABI, GMX_ADDRESSES } from "../abi/gmx.js";
import {
  getGmxTickers,
  getGmxMarkets,
  getGmxTokenDecimals,
  warmTokenDecimalsCache,
  type GmxTickerPrice,
} from "./gmxTrading.js";
import { createGmxSdk } from "./gmxSdk.js";
import type { PositionInfo, PositionsInfoData } from "@gmx-io/sdk/utils/positions";
import type { TokenData } from "@gmx-io/sdk/utils/tokens";

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

/**
 * Fetch all open GMX positions for a vault (Arbitrum only) using the official SDK.
 */
export async function getGmxPositions(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPosition[]> {
  const sdk = createGmxSdk(vaultAddress, alchemyKey);

  const marketsInfo = await sdk.markets.getMarketsInfo();
  if (!marketsInfo.marketsInfoData || !marketsInfo.tokensData) {
    return [];
  }

  const positionsInfoData: PositionsInfoData = await sdk.positions.getPositionsInfo({
    marketsInfoData: marketsInfo.marketsInfoData,
    tokensData: marketsInfo.tokensData,
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
