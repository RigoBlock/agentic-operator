/**
 * GMX increase-position handler tests.
 *
 * These tests assert the safety-critical branching around existing positions
 * versus new openings:
 *   - Opening a new position requires explicit collateral.
 *   - Increasing an existing position falls back to the position's collateral.
 *   - Pure collateral add is only allowed when a position already exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

// ── Hoisted mocks for gmx services ──────────────────────────────────────
const {
  mockFindGmxPosition,
  mockFindGmxMarket,
  mockGetGmxMarkets,
  mockGetGmxTokenPrice,
  mockGetGmxTokenDecimals,
  mockWarmDecimalsForAddresses,
  mockResolveGmxCollateral,
  mockCheckVaultEthForGmxKeeper,
  mockBuildCreateIncreaseOrderCalldata,
} = vi.hoisted(() => ({
  mockFindGmxPosition: vi.fn(),
  mockFindGmxMarket: vi.fn(),
  mockGetGmxMarkets: vi.fn(),
  mockGetGmxTokenPrice: vi.fn(),
  mockGetGmxTokenDecimals: vi.fn(),
  mockWarmDecimalsForAddresses: vi.fn(),
  mockResolveGmxCollateral: vi.fn(),
  mockCheckVaultEthForGmxKeeper: vi.fn(),
  mockBuildCreateIncreaseOrderCalldata: vi.fn(),
}));

vi.mock("../src/services/gmxPositions.js", () => ({
  getGmxPositionsSummary: vi.fn(),
  getGmxPositions: vi.fn(),
  findGmxPosition: mockFindGmxPosition,
  computeGmxLeverage: vi.fn((sizeUsd: number, effectiveCollateralUsd: number) =>
    effectiveCollateralUsd > 0 ? sizeUsd / effectiveCollateralUsd : 0,
  ),
  computeEffectiveCollateral: vi.fn((sizeUsd: number, leverage: number) =>
    leverage > 0 ? sizeUsd / leverage : 0,
  ),
}));

vi.mock("../src/services/gmxTrading.js", () => ({
  findGmxMarket: mockFindGmxMarket,
  getGmxMarkets: mockGetGmxMarkets,
  getGmxTickers: vi.fn().mockResolvedValue([]),
  getGmxTokenPrice: mockGetGmxTokenPrice,
  getGmxExecutionPrice: vi.fn(),
  resolveGmxCollateral: mockResolveGmxCollateral,
  getGmxTokenDecimals: mockGetGmxTokenDecimals,
  warmTokenDecimalsCache: vi.fn().mockResolvedValue(undefined),
  warmDecimalsForAddresses: mockWarmDecimalsForAddresses,
  buildCreateIncreaseOrderCalldata: mockBuildCreateIncreaseOrderCalldata,
  buildCreateDecreaseOrderCalldata: vi.fn(),
  buildUpdateOrderCalldata: vi.fn(),
  buildCancelOrderCalldata: vi.fn(),
  buildClaimFundingFeesCalldata: vi.fn(),
  checkVaultEthForGmxKeeper: mockCheckVaultEthForGmxKeeper,
}));

vi.mock("../src/services/vault.js", () => ({
  getVaultTokenBalance: vi.fn().mockResolvedValue({
    balance: 10000000000000000000n, // 10 WETH
    symbol: "WETH",
    decimals: 18,
  }),
  getClient: vi.fn(),
}));

vi.mock("../src/llm/client.js", () => ({
  estimateGas: vi.fn().mockResolvedValue("0x12345"),
  executeToolCall: vi.fn(),
  txActionLine: vi.fn().mockReturnValue(""),
}));

import { handle_gmx_increase_position } from "../src/llm/handlers/gmx.js";

// ── Fixtures ────────────────────────────────────────────────────────────

const VAULT = "0xd14d4321a33F7eD001Ba5B60cE54b0F7Ba621247" as Address;
const OPERATOR = "0xOperator0000000000000000000000000000000000" as Address;
const MARKET_TOKEN = "0xMarketToken000000000000000000000000000000" as Address;
const INDEX_TOKEN = "0xIndexToken000000000000000000000000000000" as Address;
const LONG_TOKEN = "0xLongToken000000000000000000000000000000" as Address;
const SHORT_TOKEN = "0xShortToken000000000000000000000000000000" as Address;
const COLLATERAL_TOKEN = "0xCollateralToken000000000000000000000000" as Address;
const WETH_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" as Address;

const MOCK_MARKET = {
  marketToken: MARKET_TOKEN,
  indexToken: INDEX_TOKEN,
  longToken: LONG_TOKEN,
  shortToken: SHORT_TOKEN,
};

const MOCK_POSITION = {
  market: MARKET_TOKEN,
  collateralToken: COLLATERAL_TOKEN,
  isLong: true,
  sizeInUsd: "$1,000.00",
  sizeInUsdRaw: "1000000000000000000000000000000",
  sizeInTokens: "0.5",
  sizeInTokensRaw: "500000000000000000",
  collateralAmount: "1",
  collateralAmountRaw: "1000000000000000000",
  entryPrice: "$2,000.000",
  markPrice: "$2,100.000",
  leverage: "5.0x",
  unrealizedPnl: "+$50.00",
  unrealizedPnlPercent: "+5.0%",
  fundingFee: "see market rates",
  borrowingFee: "$0.00",
  marketSymbol: "ETH/USD",
  collateralSymbol: "WETH",
  indexTokenSymbol: "ETH",
  indexToken: INDEX_TOKEN,
  longToken: LONG_TOKEN,
  shortToken: SHORT_TOKEN,
};

function makeEnv(): any {
  return { ALCHEMY_API_KEY: "test-key" };
}

function makeCtx(chainId = 1): any {
  return {
    vaultAddress: VAULT,
    operatorAddress: OPERATOR,
    chainId,
  };
}

async function setupHappyPathMocks(existingPosition = MOCK_POSITION) {
  mockFindGmxPosition.mockResolvedValue(existingPosition);
  mockFindGmxMarket.mockResolvedValue(MOCK_MARKET);
  mockGetGmxMarkets.mockResolvedValue([MOCK_MARKET]);
  mockResolveGmxCollateral.mockResolvedValue(WETH_ADDRESS);
  mockGetGmxTokenDecimals.mockReturnValue(18);
  mockGetGmxTokenPrice.mockResolvedValue({ min: 2000, max: 2100, mid: 2050 });
  mockBuildCreateIncreaseOrderCalldata.mockReturnValue("0xabcdef123456");
  mockCheckVaultEthForGmxKeeper.mockResolvedValue({ sufficient: true, ethBalance: "0.01" });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("handle_gmx_increase_position", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when opening a new position without explicit collateral", async () => {
    mockFindGmxPosition.mockRejectedValue(new Error("No position found"));
    mockFindGmxMarket.mockResolvedValue(MOCK_MARKET);

    const ctx = makeCtx();
    const args = {
      market: "ETH",
      isLong: true,
      notionalUsd: "1000",
      leverage: "5",
    };

    await expect(
      handle_gmx_increase_position(makeEnv(), ctx, args, "gmx_increase_position"),
    ).rejects.toThrow("requires specifying a collateral token");
  });

  it("uses existing position collateral when explicit collateral is omitted", async () => {
    await setupHappyPathMocks();

    const ctx = makeCtx();
    const args = {
      market: "ETH",
      isLong: true,
      sizeDeltaUsd: "500",
    };

    await handle_gmx_increase_position(makeEnv(), ctx, args, "gmx_increase_position");

    expect(mockResolveGmxCollateral).toHaveBeenCalledWith("WETH");
  });

  it("throws when adding collateral only to a non-existent position", async () => {
    mockFindGmxPosition.mockRejectedValue(new Error("No position found"));
    mockFindGmxMarket.mockResolvedValue(MOCK_MARKET);

    const ctx = makeCtx();
    const args = {
      market: "ETH",
      isLong: true,
      sizeDeltaUsd: "0",
      collateralAmount: "1",
      collateral: "WETH",
    };

    await expect(
      handle_gmx_increase_position(makeEnv(), ctx, args, "gmx_increase_position"),
    ).rejects.toThrow("Cannot add collateral to a non-existent");
  });

  it("allows pure collateral add when an existing position is present", async () => {
    await setupHappyPathMocks();

    const ctx = makeCtx();
    const args = {
      market: "ETH",
      isLong: true,
      sizeDeltaUsd: "0",
      collateralAmount: "1",
    };

    const result = await handle_gmx_increase_position(makeEnv(), ctx, args, "gmx_increase_position");

    expect(mockBuildCreateIncreaseOrderCalldata).toHaveBeenCalled();
    expect(result.transaction).toBeDefined();
    expect(result.transaction?.description).toContain("Add 1 WETH collateral");
  });
});
