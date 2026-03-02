/**
 * GMX v2 Positions Service
 *
 * Reads open GMX positions and pending orders for a Rigoblock vault
 * directly from the GMX Reader contract on Arbitrum.
 *
 * The vault IS the GMX account — positions are keyed by:
 *   positionKey = keccak256(abi.encode(vaultAddress, market, collateralToken, isLong))
 *
 * We use the GMX Reader.getAccountPositions() to get raw positions,
 * then enrich with price data from the GMX REST API tickers.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  type Address,
  type PublicClient,
} from "viem";
import { arbitrum } from "viem/chains";
import { getRpcUrl } from "../config.js";
import {
  GMX_READER_ABI,
  GMX_CHAINLINK_PRICE_FEED_ABI,
  GMX_ADDRESSES,
} from "../abi/gmx.js";
import {
  getGmxTickers,
  getGmxMarkets,
  getGmxTokenDecimals,
  type GmxTickerPrice,
} from "./gmxTrading.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface GmxPosition {
  market: string;
  collateralToken: string;
  isLong: boolean;
  sizeInUsd: string;     // human-readable USD
  sizeInTokens: string;  // human-readable tokens
  collateralAmount: string; // human-readable
  entryPrice: string;    // human-readable USD
  markPrice: string;     // human-readable USD
  leverage: string;      // e.g. "5.2x"
  unrealizedPnl: string; // human-readable USD with sign
  unrealizedPnlPercent: string; // e.g. "+12.5%"
  fundingFee: string;    // estimated funding cost
  borrowingFee: string;  // estimated borrowing cost
  marketSymbol: string;  // e.g. "ETH/USD"
  collateralSymbol: string;
  indexTokenSymbol: string;
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
  totalSizeUsd: string;
  formattedReport: string;
}

// ── Client ─────────────────────────────────────────────────────────────

const ALCHEMY_ORIGIN = "https://trader.rigoblock.com";

let arbClient: PublicClient | null = null;

function getArbitrumClient(alchemyKey?: string): PublicClient {
  if (arbClient) return arbClient;
  const rpcUrl = getRpcUrl(42161, alchemyKey);
  arbClient = createPublicClient({
    chain: arbitrum,
    transport: http(rpcUrl, rpcUrl?.includes("alchemy.com")
      ? { fetchOptions: { headers: { Origin: ALCHEMY_ORIGIN } } }
      : undefined,
    ),
  });
  return arbClient;
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

// ── Core functions ─────────────────────────────────────────────────────

/**
 * Fetch all open GMX positions for a vault (Arbitrum only).
 */
export async function getGmxPositions(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPosition[]> {
  const client = getArbitrumClient(alchemyKey);

  // Fetch positions, markets, and tickers in parallel
  const [rawPositions, markets, tickers] = await Promise.all([
    client.readContract({
      address: GMX_ADDRESSES.READER,
      abi: GMX_READER_ABI,
      functionName: "getAccountPositions",
      args: [GMX_ADDRESSES.DATA_STORE, vaultAddress, 0n, 32n],
    }),
    getGmxMarkets(),
    getGmxTickers(),
  ]);

  if (!rawPositions || rawPositions.length === 0) {
    return [];
  }

  // Build lookup maps
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

  const positions: GmxPosition[] = [];

  for (const pos of rawPositions) {
    const marketAddr = pos.addresses.market.toLowerCase();
    const collateralAddr = pos.addresses.collateralToken.toLowerCase();
    const isLong = pos.flags.isLong;

    const sizeInUsd = pos.numbers.sizeInUsd;
    const sizeInTokens = pos.numbers.sizeInTokens;
    const collateralAmount = pos.numbers.collateralAmount;

    if (sizeInUsd === 0n) continue; // Skip empty positions

    // Get market info
    const marketInfo = marketMap.get(marketAddr);
    const indexTokenAddr = marketInfo?.indexToken?.toLowerCase() || "";

    // Get token symbols from tickers
    const indexTicker = tickerMap.get(indexTokenAddr);
    const collateralTicker = tickerMap.get(collateralAddr);

    // Strip version suffixes like .v2 for display
    const indexSymbol = (indexTicker?.tokenSymbol || "???").replace(/\.v\d+$/i, "");
    const collateralSymbol = (collateralTicker?.tokenSymbol || "???").replace(/\.v\d+$/i, "");

    const collateralDecimals = getGmxTokenDecimals(collateralAddr);
    const indexDecimals = getGmxTokenDecimals(indexTokenAddr);

    // Get current mark price (price per full token in USD)
    const indexPrice = indexTicker
      ? (Number(BigInt(indexTicker.minPrice)) + Number(BigInt(indexTicker.maxPrice))) / 2 / (10 ** (30 - indexDecimals))
      : 0;

    // Entry price = sizeInUsd / sizeInTokens (both are bigints)
    // sizeInUsd is 10^30, sizeInTokens is in token decimals
    let entryPrice = 0;
    if (sizeInTokens > 0n) {
      entryPrice = (Number(sizeInUsd) / 1e30) / (Number(sizeInTokens) / 10 ** indexDecimals);
    }

    // Unrealized PnL
    const sizeUsdNum = Number(sizeInUsd) / 1e30;
    const markValue = (Number(sizeInTokens) / 10 ** indexDecimals) * indexPrice;
    let pnl: number;
    if (isLong) {
      pnl = markValue - sizeUsdNum;
    } else {
      pnl = sizeUsdNum - markValue;
    }

    const collateralNum = Number(collateralAmount) / 10 ** collateralDecimals;
    const collateralPrice = collateralTicker
      ? (Number(BigInt(collateralTicker.minPrice)) + Number(BigInt(collateralTicker.maxPrice))) / 2 / (10 ** (30 - collateralDecimals))
      : 0;
    const collateralValueUsd = collateralNum * collateralPrice;

    const leverage = collateralValueUsd > 0 ? sizeUsdNum / collateralValueUsd : 0;
    const pnlPercent = collateralValueUsd > 0 ? (pnl / collateralValueUsd) * 100 : 0;

    // Estimated funding fee (from borrowingFactor — approximate)
    const borrowingFactor = Number(pos.numbers.borrowingFactor) / 1e30;

    positions.push({
      market: pos.addresses.market,
      collateralToken: pos.addresses.collateralToken,
      isLong,
      sizeInUsd: formatUsd(sizeUsdNum),
      sizeInTokens: formatTokenValue(Number(sizeInTokens) / 10 ** indexDecimals),
      collateralAmount: formatTokenValue(collateralNum),
      entryPrice: `$${entryPrice.toFixed(2)}`,
      markPrice: `$${indexPrice.toFixed(2)}`,
      leverage: `${leverage.toFixed(1)}x`,
      unrealizedPnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      unrealizedPnlPercent: `${pnl >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`,
      fundingFee: "see market rates",
      borrowingFee: borrowingFactor > 0 ? `factor: ${borrowingFactor.toExponential(2)}` : "$0.00",
      marketSymbol: `${indexSymbol}/USD`,
      collateralSymbol,
      indexTokenSymbol: indexSymbol,
    });
  }

  return positions;
}

/**
 * Fetch all pending GMX orders for a vault.
 */
export async function getGmxPendingOrders(
  vaultAddress: Address,
  alchemyKey?: string,
): Promise<GmxPendingOrder[]> {
  const client = getArbitrumClient(alchemyKey);

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

  return rawOrders.map((o) => {
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

  // Calculate totals
  let totalPnl = 0;
  let totalCollateral = 0;
  let totalSize = 0;

  for (const p of positions) {
    totalPnl += parseUsdString(p.unrealizedPnl);
    totalCollateral += parseUsdString(p.sizeInUsd) > 0
      ? parseUsdString(p.sizeInUsd) / parseFloat(p.leverage)
      : 0;
    totalSize += parseUsdString(p.sizeInUsd);
  }

  const formattedReport = formatPositionsReport(positions, pendingOrders, totalPnl, totalCollateral, totalSize, vaultAddress);

  return {
    positions,
    pendingOrders,
    totalUnrealizedPnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
    totalCollateralUsd: formatUsd(totalCollateral),
    totalSizeUsd: formatUsd(totalSize),
    formattedReport,
  };
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatTokenValue(value: number): string {
  if (value < 0.001) return value.toExponential(4);
  if (value < 1) return value.toFixed(6);
  if (value < 1000) return value.toFixed(4);
  return value.toFixed(2);
}

function parseUsdString(s: string): number {
  return parseFloat(s.replace(/[+$,KM]/g, (m) => {
    if (m === "K") return "e3";
    if (m === "M") return "e6";
    return "";
  })) || 0;
}

/**
 * Generate a positions report with a markdown-style table for the chat.
 * URLs are rendered clickable by the frontend.
 */
function formatPositionsReport(
  positions: GmxPosition[],
  pendingOrders: GmxPendingOrder[],
  totalPnl: number,
  totalCollateral: number,
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
    const pnlEmoji = totalPnl >= 0 ? "🟢" : "🔴";
    lines.push(`${pnlEmoji} Total PnL: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}  |  Size: ${formatUsd(totalSize)}  |  Positions: ${positions.length}`);
    lines.push("");

    // Table header
    lines.push("| Market | Side | Size | Collateral | Leverage | Entry | Mark | PnL |");
    lines.push("|--------|------|------|------------|----------|-------|------|-----|");

    for (const pos of positions) {
      const side = pos.isLong ? "🟢 LONG" : "🔴 SHORT";
      const pnlValue = parseUsdString(pos.unrealizedPnl);
      const pnlIcon = pnlValue >= 0 ? "✅" : "❌";
      lines.push(
        `| ${pos.marketSymbol} | ${side} | ${pos.sizeInUsd} (${pos.sizeInTokens} ${pos.indexTokenSymbol}) | ${pos.collateralAmount} ${pos.collateralSymbol} | ${pos.leverage} | ${pos.entryPrice} | ${pos.markPrice} | ${pnlIcon} ${pos.unrealizedPnl} (${pos.unrealizedPnlPercent}) |`,
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
    lines.push(`🔗 ${portfolioUrl}`);
  }

  return lines.join("\n");
}
