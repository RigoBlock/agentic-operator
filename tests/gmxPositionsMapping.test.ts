import { describe, it, expect } from "vitest";
import { buildGmxPositionFromSdk, type GmxPosition } from "../src/services/gmxPositions.js";
import type { PositionInfo } from "@gmx-io/sdk/utils/positions";
import type { Market, MarketInfo } from "@gmx-io/sdk/utils/markets";
import type { TokenData } from "@gmx-io/sdk/utils/tokens";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const MARKET_ETH = "0x70d95587d81A6caf5fE77E4f0D7F233648E8D1A8";
const MARKET_BTC = "0x47c031236e19d024b42f8AE6781E4180bf50eda9";

function token(symbol: string, decimals: number): TokenData {
  return {
    symbol,
    name: symbol,
    decimals,
    address: symbol === "WETH" ? WETH : symbol === "USDC" ? USDC : WBTC,
    isSynthetic: false,
    isStable: symbol === "USDC",
    isShortable: symbol !== "USDC",
    isWrapped: symbol === "WETH",
    isNative: false,
  } as TokenData;
}

function buildMarket(indexSymbol: string): { market: Market; indexToken: TokenData; longToken: TokenData; shortToken: TokenData } {
  const isEth = indexSymbol === "ETH";
  const indexToken = token(indexSymbol, isEth ? 18 : 8);
  const longToken = token("WETH", 18);
  const shortToken = token("USDC", 6);
  const marketAddress = isEth ? MARKET_ETH : MARKET_BTC;
  const market: Market = {
    marketTokenAddress: marketAddress,
    indexTokenAddress: indexToken.address,
    longTokenAddress: longToken.address,
    shortTokenAddress: shortToken.address,
    isSameCollaterals: false,
    isSpotOnly: false,
    name: `${indexSymbol}/USD [WETH-USDC]`,
    data: "0x",
  };
  return { market, indexToken, longToken, shortToken };
}

function makePositionInfo(partial: Partial<PositionInfo> & { isLong: boolean; collateralSymbol: string }): PositionInfo {
  const sizeInUsd = partial.sizeInUsd ?? 10_000n * 10n ** 30n; // $10k
  const sizeInTokens = partial.sizeInTokens ?? 5n * 10n ** (partial.isLong ? 18n : 8n);
  const collateralAmount = partial.collateralAmount ?? 2_000n * 10n ** 18n;
  const entryPrice = partial.entryPrice ?? (partial.isLong ? 2000n : 20_000n) * 10n ** 30n;
  const markPrice = partial.markPrice ?? entryPrice;
  const liquidationPrice = partial.liquidationPrice ?? (partial.isLong ? 1500n : 25_000n) * 10n ** 30n;

  const pnl = partial.pnl ?? 0n;
  const pendingBorrowingFeesUsd = partial.pendingBorrowingFeesUsd ?? 0n;
  const pendingFundingFeesUsd = partial.pendingFundingFeesUsd ?? 0n;
  const closingFeeUsd = partial.closingFeeUsd ?? 10n ** 30n; // $1
  const uiFeeUsd = partial.uiFeeUsd ?? 0n;
  const netPriceImapctDeltaUsd = partial.netPriceImapctDeltaUsd ?? 0n;

  const pnlAfterAllFees =
    partial.pnlAfterAllFees ??
    pnl - pendingBorrowingFeesUsd - pendingFundingFeesUsd + netPriceImapctDeltaUsd - closingFeeUsd;
  const netValue = partial.netValue ?? (collateralAmount * markPrice) / 10n ** 18n + pnlAfterAllFees;

  const pnlAfterAllFeesPercentage =
    partial.pnlAfterAllFeesPercentage ?? (collateralAmount > 0n ? (pnlAfterAllFees * 10n ** 4n * 10n ** 18n) / (collateralAmount * markPrice) : 0n);

  const leverage = partial.leverage ?? (netValue > 0n ? (sizeInUsd * 10_000n) / netValue : 0n);

  const { market, indexToken, longToken, shortToken } = buildMarket(partial.isLong ? "ETH" : "BTC");
  const collateralToken = token(partial.collateralSymbol, partial.collateralSymbol === "USDC" ? 6 : 18);

  return {
    key: "0xkey",
    contractKey: "0xkey",
    account: "0xvault",
    marketAddress: market.marketTokenAddress,
    collateralTokenAddress: collateralToken.address,
    sizeInUsd,
    sizeInTokens,
    collateralAmount,
    pendingBorrowingFeesUsd,
    increasedAtTime: 0n,
    decreasedAtTime: 0n,
    fundingFeeAmount: 0n,
    claimableLongTokenAmount: 0n,
    claimableShortTokenAmount: 0n,
    pnl,
    positionFeeAmount: 0n,
    traderDiscountAmount: 0n,
    uiFeeAmount: 0n,
    pendingImpactAmount: 0n,
    data: "0x",
    marketInfo: undefined as unknown as MarketInfo,
    market,
    indexToken,
    longToken,
    shortToken,
    indexName: partial.isLong ? "ETH/USD" : "BTC/USD",
    poolName: "WETH-USDC",
    collateralToken,
    pnlToken: indexToken,
    markPrice,
    entryPrice,
    liquidationPrice,
    collateralUsd: (collateralAmount * markPrice) / 10n ** 18n,
    remainingCollateralUsd: 0n,
    remainingCollateralAmount: 0n,
    hasLowCollateral: false,
    pnlPercentage: 0n,
    pnlAfterFees: pnl - pendingBorrowingFeesUsd - pendingFundingFeesUsd,
    pnlAfterFeesPercentage: 0n,
    netValueAfterAllFees: netValue,
    pnlAfterAllFees,
    pnlAfterAllFeesPercentage,
    netValue,
    closingFeeUsd,
    uiFeeUsd,
    pendingFundingFeesUsd,
    pendingClaimableFundingFeesUsd: 0n,
    netPriceImapctDeltaUsd,
    priceImpactDiffUsd: 0n,
    pendingImpactUsd: 0n,
    closePriceImpactDeltaUsd: 0n,
    leverage,
    leverageWithPnl: leverage,
    leverageWithoutPnl: leverage,
    ...partial,
  } as unknown as PositionInfo;
}

describe("buildGmxPositionFromSdk", () => {
  it("maps a simple long ETH position", () => {
    const pos: GmxPosition = buildGmxPositionFromSdk(
      makePositionInfo({
        isLong: true,
        collateralSymbol: "WETH",
        sizeInUsd: 10_000n * 10n ** 30n,
        sizeInTokens: 5n * 10n ** 18n,
        collateralAmount: 2n * 10n ** 18n,
        entryPrice: 2000n * 10n ** 30n,
        markPrice: 2100n * 10n ** 30n,
        liquidationPrice: 1500n * 10n ** 30n,
        pnl: 500n * 10n ** 30n,
      }),
    );

    expect(pos.marketSymbol).toBe("ETH/USD");
    expect(pos.isLong).toBe(true);
    expect(pos.collateralSymbol).toBe("WETH");
    expect(pos.sizeInUsd).toBe("$10.00K");
    expect(pos.entryPrice).toBe("$2000.0000");
    expect(pos.markPrice).toBe("$2100.0000");
    expect(pos.liquidationPrice).toBe("$1500.0000");
    expect(pos.leverage).toMatch(/x$/);
    expect(pos.unrealizedPnl).toMatch(/^\+/);
    expect(pos.grossPnl).toMatch(/^\+\$500\.00/);
  });

  it("maps a short BTC position with USDC collateral and fees", () => {
    const pos: GmxPosition = buildGmxPositionFromSdk(
      makePositionInfo({
        isLong: false,
        collateralSymbol: "USDC",
        sizeInUsd: 50_000n * 10n ** 30n,
        sizeInTokens: 2n * 10n ** 8n,
        collateralAmount: 5_000n * 10n ** 6n,
        entryPrice: 25_000n * 10n ** 30n,
        markPrice: 26_000n * 10n ** 30n,
        liquidationPrice: 30_000n * 10n ** 30n,
        pnl: -2_000n * 10n ** 30n,
        pendingBorrowingFeesUsd: 5n * 10n ** 30n,
        pendingFundingFeesUsd: 3n * 10n ** 30n,
        closingFeeUsd: 10n * 10n ** 30n,
        netPriceImapctDeltaUsd: -25n * 10n ** 30n,
      }),
    );

    expect(pos.marketSymbol).toBe("BTC/USD");
    expect(pos.isLong).toBe(false);
    expect(pos.collateralSymbol).toBe("USDC");
    expect(pos.sizeInUsd).toBe("$50.00K");
    expect(pos.unrealizedPnl.startsWith("-")).toBe(true);
    expect(pos.borrowingFee).toBe("-$5.00");
    expect(pos.fundingFee).toBe("-$3.00");
    expect(pos.closeFee).toBe("-$10.00");
    expect(pos.priceImpact).toBe("-$25.00");
    // total costs = borrow + funding + close + ui - impact = 5+3+10+0-(-25) = 43
    expect(pos.totalCosts).toBe("-$43.00");
  });

  it("formats N/A liquidation price when undefined", () => {
    const pos: GmxPosition = buildGmxPositionFromSdk(
      makePositionInfo({
        isLong: true,
        collateralSymbol: "WETH",
        liquidationPrice: undefined,
      }),
    );

    expect(pos.liquidationPrice).toBe("N/A");
  });

  it("computes leverage and percent from SDK values", () => {
    const pos: GmxPosition = buildGmxPositionFromSdk(
      makePositionInfo({
        isLong: true,
        collateralSymbol: "WETH",
        sizeInUsd: 10_000n * 10n ** 30n,
        collateralAmount: 2n * 10n ** 18n,
        markPrice: 2000n * 10n ** 30n,
        leverage: 5n * 10_000n, // 5x in bps
        pnlAfterAllFeesPercentage: 250n, // 2.5%
      }),
    );

    expect(pos.leverage).toBe("5.0x");
    expect(pos.unrealizedPnlPercent).toBe("+2.50%");
  });
});
