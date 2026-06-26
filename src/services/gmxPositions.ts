/**
 * GMX v2 Positions Service
 *
 * Reads open GMX positions for a Rigoblock vault directly from the GMX v2
 * Reader contract on Arbitrum. The Rigoblock vault IS the GMX account.
 *
 * We use Reader.getAccountPositionInfoList() — a single aggregated RPC call —
 * to fetch every open position together with the full GMX fee/PnL breakdown
 * (borrowing, funding, close fee, net price impact). This mirrors the data
 * shown in the GMX UI and avoids spamming the RPC with per-position reads.
 */

import {
  formatUnits,
  keccak256,
  encodeAbiParameters,
  zeroAddress,
  type Address,
} from "viem";
import { getClient } from "./vault.js";
import {
  GMX_READER_ABI,
  GMX_CHAINLINK_PRICE_FEED_ABI,
  GMX_ADDRESSES,
} from "../abi/gmx.js";
import {
  getGmxTickers,
  getGmxMarkets,
  getGmxTokenDecimals,
  warmTokenDecimalsCache,
  type GmxTickerPrice,
  type GmxMarketInfo,
} from "./gmxTrading.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface GmxPosition {
  market: string;
  collateralToken: string;
  isLong: boolean;
  sizeInUsd: string;     // human-readable USD
  sizeInUsdRaw: string;  // exact 10^30 raw value for calldata building
  sizeInTokens: string;  // human-readable tokens
  sizeInTokensRaw: string; // exact raw token amount for calldata
  collateralAmount: string; // human-readable
  collateralAmountRaw: string; // exact raw token amount for calldata
  entryPrice: string;    // human-readable USD
  markPrice: string;     // human-readable USD
  leverage: string;      // e.g. "5.2x"
  unrealizedPnl: string; // net PnL after all fees, with sign
  unrealizedPnlPercent: string; // e.g. "+12.5%"
  grossPnl: string;      // price-only PnL before fees, with sign
  netValue: string;      // collateral + net PnL
  fundingFee: string;    // estimated funding cost (signed)
  borrowingFee: string;  // estimated borrowing cost (signed)
  closeFee: string;      // estimated close fee (signed)
  uiFee: string;         // estimated UI fee (signed)
  priceImpact: string;   // net price impact on full close (signed)
  totalCosts: string;    // borrow + funding + close + ui - net price impact (signed)
  liquidationPrice: string; // estimated liquidation price
  marketSymbol: string;  // e.g. "ETH/USD"
  collateralSymbol: string;
  indexTokenSymbol: string;
  indexToken: string;    // index token address (for price lookup)
  longToken: string;     // long token address
  shortToken: string;    // short token address
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


// ── Order type labels ──────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────

/** Normalize isLong to boolean, handling both boolean and string inputs from LLMs. */
function normalizeIsLong(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

/**
 * GMX v2 leverage formula — single source of truth.
 * leverage = sizeUsd / netValueUsd
 *
 * Net value includes collateral + unrealized PnL + net price impact - fees,
 * matching the GMX UI: the displayed leverage increases as losses and costs
 * erode the position's effective collateral.
 */
export function computeGmxLeverage(sizeUsd: number, positionCollateralUsd: number): number {
  return positionCollateralUsd > 0 ? sizeUsd / positionCollateralUsd : 0;
}

/**
 * Derive effective collateral from size and leverage.
 * Inverse of computeGmxLeverage.
 */
export function computeEffectiveCollateral(sizeUsd: number, leverage: number): number {
  return leverage > 0 ? sizeUsd / leverage : 0;
}

function buildMarketPrices(
  marketInfo: { indexToken: string; longToken: string; shortToken: string } | undefined,
  tickerMap: Map<string, GmxTickerPrice>,
): {
  indexTokenPrice: { min: bigint; max: bigint };
  longTokenPrice: { min: bigint; max: bigint };
  shortTokenPrice: { min: bigint; max: bigint };
} {
  const raw = (addr?: string) => {
    const t = addr ? tickerMap.get(addr.toLowerCase()) : undefined;
    if (!t) return { min: 0n, max: 0n };
    return { min: BigInt(t.minPrice), max: BigInt(t.maxPrice) };
  };
  return {
    indexTokenPrice: raw(marketInfo?.indexToken),
    longTokenPrice: raw(marketInfo?.longToken),
    shortTokenPrice: raw(marketInfo?.shortToken),
  };
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

function formatPrice(value: number): string {
  if (value >= 1000) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(3)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toExponential(4)}`;
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

function tokenToUsd(amount: bigint, price: number, decimals: number): number {
  return (Number(amount) / 10 ** decimals) * price;
}

// ── Core functions ─────────────────────────────────────────────────────

/**
 * Build a single GmxPosition object from raw on-chain data plus the enriched
 * info returned by Reader.getAccountPositionInfoList().
 */
function buildGmxPosition(
  rawPosition: {
    addresses: { account: Address; market: Address; collateralToken: Address };
    numbers: {
      sizeInUsd: bigint;
      sizeInTokens: bigint;
      collateralAmount: bigint;
      borrowingFactor: bigint;
    };
    flags: { isLong: boolean };
  },
  marketInfo: { indexToken: string; longToken: string; shortToken: string } | undefined,
  tickerMap: Map<string, GmxTickerPrice>,
  minCollateralFactorMap: Map<string, bigint>,
  info?: {
    fees: {
      collateralTokenPrice: { min: bigint; max: bigint };
      borrowing: { borrowingFeeUsd: bigint };
      funding: { fundingFeeAmount: bigint };
      ui: { uiFeeAmount: bigint };
      positionFeeAmount: bigint;
      totalDiscountAmount: bigint;
    };
    executionPriceResult: { totalImpactUsd: bigint };
    basePnlUsd: bigint;
  },
): GmxPosition {
  const marketAddr = rawPosition.addresses.market.toLowerCase();
  const collateralAddr = rawPosition.addresses.collateralToken.toLowerCase();
  const isLong = rawPosition.flags.isLong;

  const sizeInUsd = rawPosition.numbers.sizeInUsd;
  const sizeInTokens = rawPosition.numbers.sizeInTokens;
  const collateralAmount = rawPosition.numbers.collateralAmount;

  const indexTokenAddr = marketInfo?.indexToken?.toLowerCase() || "";
  const indexTicker = tickerMap.get(indexTokenAddr);
  const collateralTicker = tickerMap.get(collateralAddr);

  const indexSymbol = (indexTicker?.tokenSymbol || "???").replace(/\.v\d+$/i, "");
  const collateralSymbol = (collateralTicker?.tokenSymbol || "???").replace(/\.v\d+$/i, "");

  const collateralDecimals = getGmxTokenDecimals(collateralAddr);
  const indexDecimals = getGmxTokenDecimals(indexTokenAddr);

  const indexPrice = indexTicker
    ? (Number(BigInt(indexTicker.minPrice)) + Number(BigInt(indexTicker.maxPrice))) / 2 / (10 ** (30 - indexDecimals))
    : 0;

  let entryPrice = 0;
  if (sizeInTokens > 0n) {
    entryPrice = (Number(sizeInUsd) / 1e30) / (Number(sizeInTokens) / 10 ** indexDecimals);
  }

  const sizeUsdNum = Number(sizeInUsd) / 1e30;
  const markValue = (Number(sizeInTokens) / 10 ** indexDecimals) * indexPrice;
  let grossPnl: number;
  if (isLong) {
    grossPnl = markValue - sizeUsdNum;
  } else {
    grossPnl = sizeUsdNum - markValue;
  }

  // Prefer GMX's own capped basePnlUsd when fee info is available
  if (info) {
    grossPnl = Number(info.basePnlUsd) / 1e30;
  }

  const collateralNum = Number(collateralAmount) / 10 ** collateralDecimals;
  const collateralPrice = info
    ? (Number(info.fees.collateralTokenPrice.min) + Number(info.fees.collateralTokenPrice.max)) / 2 / (10 ** (30 - collateralDecimals))
    : collateralTicker
      ? (Number(BigInt(collateralTicker.minPrice)) + Number(BigInt(collateralTicker.maxPrice))) / 2 / (10 ** (30 - collateralDecimals))
      : 0;
  const collateralValueUsd = collateralNum * collateralPrice;

  let borrowingFeeUsd = 0;
  let fundingFeeUsd = 0;
  let closeFeeUsd = 0;
  let uiFeeUsd = 0;
  let priceImpactUsd = 0;

  if (info) {
    borrowingFeeUsd = Number(info.fees.borrowing.borrowingFeeUsd) / 1e30;
    fundingFeeUsd = tokenToUsd(info.fees.funding.fundingFeeAmount, collateralPrice, collateralDecimals);
    uiFeeUsd = tokenToUsd(info.fees.ui.uiFeeAmount, collateralPrice, collateralDecimals);

    const positionFeeAmount = BigInt(info.fees.positionFeeAmount);
    const totalDiscountAmount = BigInt(info.fees.totalDiscountAmount);
    const discountedFeeAmount = positionFeeAmount > totalDiscountAmount ? positionFeeAmount - totalDiscountAmount : 0n;
    closeFeeUsd = tokenToUsd(discountedFeeAmount, collateralPrice, collateralDecimals);

    priceImpactUsd = Number(info.executionPriceResult.totalImpactUsd) / 1e30;
  }

  const totalCostUsd = borrowingFeeUsd + fundingFeeUsd + closeFeeUsd + uiFeeUsd - priceImpactUsd;
  const netPnl = grossPnl - totalCostUsd;
  const netValue = collateralValueUsd + netPnl;

  const leverage = computeGmxLeverage(sizeUsdNum, netValue);
  const pnlPercent = collateralValueUsd > 0 ? (netPnl / collateralValueUsd) * 100 : 0;

  // Estimated liquidation price using the market's min collateral factor.
  // This mirrors the GMX UI: remaining collateral (net value) must stay above
  // size * minCollateralFactor. Fees/impact are held constant at current values.
  const mcfRaw = minCollateralFactorMap.get(marketAddr) ?? 5_000_000_000_000_000_000_000_000_000n;
  const minCollateralFactor = Number(mcfRaw) / 1e30;
  const sizeTokensNum = Number(sizeInTokens) / 10 ** indexDecimals;
  let liquidationPrice = 0;
  if (sizeTokensNum > 0) {
    const delta = (sizeUsdNum * minCollateralFactor - netValue) / sizeTokensNum;
    liquidationPrice = isLong ? indexPrice + delta : indexPrice - delta;
    if (liquidationPrice < 0) liquidationPrice = 0;
  }

  return {
    market: rawPosition.addresses.market,
    collateralToken: rawPosition.addresses.collateralToken,
    isLong,
    sizeInUsd: formatUsd(sizeUsdNum),
    sizeInUsdRaw: sizeInUsd.toString(),
    sizeInTokens: formatTokenValue(Number(sizeInTokens) / 10 ** indexDecimals),
    sizeInTokensRaw: sizeInTokens.toString(),
    collateralAmount: formatTokenValue(collateralNum),
    collateralAmountRaw: collateralAmount.toString(),
    entryPrice: formatPrice4(entryPrice),
    markPrice: formatPrice4(indexPrice),
    liquidationPrice: liquidationPrice > 0 ? formatPrice4(liquidationPrice) : "N/A",
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
    marketSymbol: `${indexSymbol}/USD`,
    collateralSymbol,
    indexTokenSymbol: indexSymbol,
    indexToken: marketInfo?.indexToken || "",
    longToken: marketInfo?.longToken || "",
    shortToken: marketInfo?.shortToken || "",
  };
}

/**
 * Fetch all open GMX positions for a vault (Arbitrum only) in a single
 * Reader.getAccountPositionInfoList() call.
 */
export async function getGmxPositions(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPosition[]> {
  const client = getClient(42161, alchemyKey);

  // Fetch markets and tickers in parallel, then ensure token decimals are cached
  // so size/collateral normalization is accurate for every collateral token.
  const [markets, tickers] = await Promise.all([
    getGmxMarkets(),
    getGmxTickers(),
  ]);
  await warmTokenDecimalsCache(tickers, alchemyKey);

  const tickerMap = new Map<string, GmxTickerPrice>();
  for (const t of tickers) {
    tickerMap.set(t.tokenAddress.toLowerCase(), t);
  }

  const marketMap = new Map<string, { indexToken: string; longToken: string; shortToken: string }>();
  for (const m of markets) {
    marketMap.set(m.marketToken.toLowerCase(), {
      indexToken: m.indexToken,
      longToken: m.longToken,
      shortToken: m.shortToken,
    });
  }

  // Fetch each market's min collateral factor in one multicall for liquidation-price estimation.
  const MIN_COLLATERAL_FACTOR = keccak256(encodeAbiParameters([{ type: "string" }], ["MIN_COLLATERAL_FACTOR"]));
  const dataStoreAbi = [{ name: "getUint", type: "function", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;
  const minCollateralFactorKeys = markets.map((m) =>
    keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [MIN_COLLATERAL_FACTOR, m.marketToken as Address])),
  );
  const minCollateralFactorResults = await client.multicall({
    contracts: minCollateralFactorKeys.map((key) => ({
      address: GMX_ADDRESSES.DATA_STORE,
      abi: dataStoreAbi,
      functionName: "getUint" as const,
      args: [key],
    })),
    allowFailure: true,
  });
  const defaultMinCollateralFactor = 5_000_000_000_000_000_000_000_000_000n; // 0.5%
  const minCollateralFactorMap = new Map<string, bigint>();
  for (let i = 0; i < markets.length; i++) {
    const r = minCollateralFactorResults[i];
    minCollateralFactorMap.set(
      markets[i].marketToken.toLowerCase(),
      r.status === "success" && r.result > 0n ? r.result : defaultMinCollateralFactor,
    );
  }

  // Single aggregated RPC call: all positions + fees + net price impact.
  let accountInfoList: any[] = [];
  try {
    const marketAddresses = markets.map((m) => m.marketToken as Address);
    const marketPrices = markets.map((m) =>
      buildMarketPrices(marketMap.get(m.marketToken.toLowerCase()), tickerMap),
    );

    accountInfoList = (await client.readContract({
      address: GMX_ADDRESSES.READER,
      abi: GMX_READER_ABI,
      functionName: "getAccountPositionInfoList",
      args: [
        GMX_ADDRESSES.DATA_STORE,
        GMX_ADDRESSES.REFERRAL_STORAGE,
        vaultAddress,
        marketAddresses,
        marketPrices,
        zeroAddress,
        0n,
        1000n,
      ],
    })) as any[];
  } catch (err) {
    console.warn("[gmx-positions] getAccountPositionInfoList failed:", err);
    throw new Error(
      `Failed to read GMX positions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const positions: GmxPosition[] = [];
  for (const info of accountInfoList) {
    const raw = info?.position;
    if (!raw || raw.numbers.sizeInUsd === 0n) continue;

    const marketInfo = marketMap.get(raw.addresses.market.toLowerCase());
    positions.push(buildGmxPosition(raw, marketInfo, tickerMap, minCollateralFactorMap, info));
  }

  return positions;
}

/**
 * Find a specific GMX position by market, direction, and optionally collateral.
 * Throws clear errors when no match is found or when multiple matches are ambiguous.
 * This is the single source of truth for position resolution — both read and write
 * tools use it so they never disagree about which position exists.
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
    // List what we DO have so the error is actionable
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

  // Multiple positions — disambiguate by collateral hint
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
  const [positions, pendingOrders] = await Promise.all([
    getGmxPositions(vaultAddress, alchemyKey),
    getGmxPendingOrders(vaultAddress, alchemyKey),
  ]);

  // Calculate totals using net (after-fee) figures
  let totalNetPnl = 0;
  let totalNetValue = 0;
  let totalSize = 0;

  for (const p of positions) {
    totalNetPnl += parseUsdString(p.unrealizedPnl);
    totalNetValue += parseUsdString(p.netValue);
    totalSize += parseUsdString(p.sizeInUsd);
  }

  // totalCollateralUsd is kept for backwards compatibility and now represents
  // the sum of raw collateral token values (same USD basis as net value).
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

// ── Report formatting ──────────────────────────────────────────────────

/**
 * Generate a positions report with a compact markdown-style table for the chat.
 * URLs are rendered clickable by the frontend. The fee breakdown is intentionally
 * omitted from the main table; the web frontend shows it on demand via an
 * expandable details row, and Telegram users can ask for the full breakdown.
 */
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
    // Summary bar
    const pnlEmoji = totalNetPnl >= 0 ? "🟢" : "🔴";
    lines.push(
      `${pnlEmoji} Total Net PnL: ${formatSignedUsd(totalNetPnl)}  |  Net Value: ${formatUsd(totalNetValue)}  |  Size: ${formatUsd(totalSize)}  |  Positions: ${positions.length}`,
    );
    lines.push("");

    // Compact table: matches the GMX UI columns
    lines.push("| Market | Side | Size | Net Value | Leverage | Net PnL | Entry | Mark | Liq Price |");
    lines.push("|--------|------|------|-----------|----------|---------|-------|------|-----------|");

    for (const pos of positions) {
      const isProfitable = parseUsdString(pos.unrealizedPnl) >= 0;
      const side = `${isProfitable ? "🟢" : "🔴"} ${pos.isLong ? "LONG" : "SHORT"}`;
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

// Re-export for consumers that need Chainlink feed ABI
export { GMX_CHAINLINK_PRICE_FEED_ABI };
