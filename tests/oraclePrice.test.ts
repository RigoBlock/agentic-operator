/**
 * Oracle Price Service tests
 *
 * Tests direct BackgeoOracle spot price queries:
 * - normalizeTokenAddress (ETH/WETH normalization)
 * - hasOraclePriceFeed (feed availability)
 * - getOracleSpotTick (spot tick extraction)
 * - convertTokenAmountViaOracle (amount conversion replicating EOracle)
 * - hasPriceFeedForPair (pair availability)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

const mockReadContract = vi.fn();
const mockMulticall = vi.fn();

vi.mock("../src/services/rpcClient.js", () => ({
  getClient: () => ({ readContract: mockReadContract, multicall: mockMulticall }),
}));

vi.mock("../src/services/oraclePool.js", () => ({
  BACKGEO_ORACLE: {
    1: "0xOracleMainnet",
    8453: "0xOracleBase",
  },
}));

beforeEach(() => {
  mockReadContract.mockReset();
  mockMulticall.mockReset();
  clearOracleTickCache();
});

import {
  normalizeTokenAddress,
  hasOraclePriceFeed,
  getOracleSpotTick,
  convertTokenAmountViaOracle,
  hasPriceFeedForPair,
  clearOracleTickCache,
} from "../src/services/oraclePrice.js";

describe("normalizeTokenAddress", () => {
  it("keeps ETH zero address as-is", () => {
    const ETH = "0x0000000000000000000000000000000000000000" as Address;
    expect(normalizeTokenAddress(ETH, 8453)).toBe(ETH);
  });

  it("maps 0xeeee... to ETH", () => {
    expect(normalizeTokenAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address, 8453))
      .toBe("0x0000000000000000000000000000000000000000");
  });

  it("maps Base WETH to ETH", () => {
    const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;
    expect(normalizeTokenAddress(WETH_BASE, 8453)).toBe("0x0000000000000000000000000000000000000000");
  });

  it("maps Ethereum WETH to ETH", () => {
    const WETH_ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address;
    expect(normalizeTokenAddress(WETH_ETH, 1)).toBe("0x0000000000000000000000000000000000000000");
  });

  it("keeps regular ERC-20 as-is", () => {
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
    expect(normalizeTokenAddress(USDC, 8453)).toBe(USDC);
  });

  it("is case-insensitive", () => {
    const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;
    const WETH_UPPER = WETH_BASE.toUpperCase() as Address;
    expect(normalizeTokenAddress(WETH_UPPER, 8453)).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("hasOraclePriceFeed", () => {
  it("returns true for ETH without calling the oracle", async () => {
    const ETH = "0x0000000000000000000000000000000000000000" as Address;
    const result = await hasOraclePriceFeed(8453, ETH, "test-key");
    expect(result).toBe(true);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns true when oracle pool has cardinality > 0", async () => {
    mockReadContract.mockResolvedValueOnce({ index: 0, cardinality: 5, cardinalityNext: 5 });
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await hasOraclePriceFeed(8453, TOKEN, "test-key");
    expect(result).toBe(true);
  });

  it("returns false when oracle pool has cardinality = 0", async () => {
    mockReadContract.mockResolvedValueOnce({ index: 0, cardinality: 0, cardinalityNext: 0 });
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await hasOraclePriceFeed(8453, TOKEN, "test-key");
    expect(result).toBe(false);
  });

  it("returns false when getState reverts", async () => {
    mockReadContract.mockRejectedValueOnce(new Error("execution reverted"));
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await hasOraclePriceFeed(8453, TOKEN, "test-key");
    expect(result).toBe(false);
  });

  it("returns false for unsupported chain", async () => {
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await hasOraclePriceFeed(99999, TOKEN, "test-key");
    expect(result).toBe(false);
  });
});

describe("getOracleSpotTick", () => {
  it("returns 0 for ETH", async () => {
    const ETH = "0x0000000000000000000000000000000000000000" as Address;
    const tick = await getOracleSpotTick(8453, ETH, "test-key");
    expect(tick).toBe(0);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns computed tick from observe", async () => {
    // tickCumulatives[0] = 5000, tickCumulatives[1] = 4000 → tick = 1000
    mockReadContract.mockResolvedValueOnce([[5000n, 4000n], []]);
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const tick = await getOracleSpotTick(8453, TOKEN, "test-key");
    expect(tick).toBe(1000);
  });

  it("handles negative ticks", async () => {
    // tickCumulatives[0] = 1000, tickCumulatives[1] = 3000 → tick = -2000
    mockReadContract.mockResolvedValueOnce([[1000n, 3000n], []]);
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const tick = await getOracleSpotTick(8453, TOKEN, "test-key");
    expect(tick).toBe(-2000);
  });

  it("throws for unsupported chain", async () => {
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    await expect(getOracleSpotTick(99999, TOKEN, "test-key")).rejects.toThrow("not deployed");
  });

  it("caches observe results to avoid redundant RPC calls", async () => {
    mockReadContract.mockResolvedValueOnce([[5000n, 4000n], []]);
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;

    const tick1 = await getOracleSpotTick(8453, TOKEN, "test-key");
    const tick2 = await getOracleSpotTick(8453, TOKEN, "test-key");

    expect(tick1).toBe(1000);
    expect(tick2).toBe(1000);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });
});

describe("convertTokenAmountViaOracle", () => {
  it("returns 0 for zero amount", async () => {
    const result = await convertTokenAmountViaOracle(
      8453, "0xaaaa" as Address, 0n, "0xbbbb" as Address, "test-key",
    );
    expect(result).toBe(0n);
  });

  it("returns same amount for same token", async () => {
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await convertTokenAmountViaOracle(
      8453, TOKEN, 1000n, TOKEN, "test-key",
    );
    expect(result).toBe(1000n);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns same amount for ETH ↔ WETH (after normalization)", async () => {
    const WETH = "0x4200000000000000000000000000000000000006" as Address;
    const result = await convertTokenAmountViaOracle(
      8453, WETH, 1000n, "0x0000000000000000000000000000000000000000" as Address, "test-key",
    );
    expect(result).toBe(1000n);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("converts ETH → token using target tick", async () => {
    // ETH → token, tick = targetTick. If targetTick = 0, price = 1.
    mockReadContract.mockResolvedValueOnce([[0n, 0n], []]);
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await convertTokenAmountViaOracle(
      8453, "0x0000000000000000000000000000000000000000" as Address, 1000n, TOKEN, "test-key",
    );
    // tick=0 → sqrtPrice=2^96 → price=1 → amountOut=1000
    expect(result).toBe(1000n);
  });

  it("converts token → ETH using negative tick", async () => {
    // token → ETH, tick = -tokenTick. If tokenTick = 0, price = 1.
    mockReadContract.mockResolvedValueOnce([[0n, 0n], []]);
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await convertTokenAmountViaOracle(
      8453, TOKEN, 1000n, "0x0000000000000000000000000000000000000000" as Address, "test-key",
    );
    expect(result).toBe(1000n);
  });

  it("converts tokenA → tokenB using difference of ticks (batched multicall)", async () => {
    // tokenA tick = 1000, tokenB tick = 2000
    // conversionTick = 2000 - 1000 = 1000
    // getOracleSpotTick returns tickCumulatives[0] - tickCumulatives[1]
    const TOKEN_A = "0xaaaa000000000000000000000000000000000001" as Address;
    const TOKEN_B = "0xbbbb000000000000000000000000000000000002" as Address;

    mockMulticall.mockResolvedValueOnce([
      [[1000n, 0n], []],   // tick = 1000
      [[3000n, 1000n], []], // tick = 2000
    ]);

    const result = await convertTokenAmountViaOracle(8453, TOKEN_A, 1000n, TOKEN_B, "test-key");

    // With tick=1000, sqrtPriceX96 > 2^96, so price > 1, result > 1000
    expect(result).toBeGreaterThan(1000n);
    expect(mockMulticall).toHaveBeenCalledTimes(1);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("throws when conversion tick is out of bounds", async () => {
    // Simulate extremely large tick difference
    const TOKEN_A = "0xaaaa000000000000000000000000000000000001" as Address;
    const TOKEN_B = "0xbbbb000000000000000000000000000000000002" as Address;

    mockMulticall.mockResolvedValueOnce([
      [[-900000n, 0n], []],
      [[900000n, 0n], []],
    ]);

    await expect(
      convertTokenAmountViaOracle(8453, TOKEN_A, 1000n, TOKEN_B, "test-key"),
    ).rejects.toThrow("out of bounds");
  });

  it("handles negative amount (returns negative converted)", async () => {
    mockReadContract.mockResolvedValueOnce([[0n, 0n], []]);
    const TOKEN = "0xaaaa000000000000000000000000000000000001" as Address;
    const result = await convertTokenAmountViaOracle(
      8453, "0x0000000000000000000000000000000000000000" as Address, -500n, TOKEN, "test-key",
    );
    expect(result).toBe(-500n);
  });
});

describe("hasPriceFeedForPair", () => {
  beforeEach(() => {
    mockReadContract.mockReset();
  });

  it("returns true when both tokens have feeds (batched multicall)", async () => {
    mockMulticall.mockResolvedValueOnce([
      { status: "success", result: { index: 0, cardinality: 5, cardinalityNext: 5 } },
      { status: "success", result: { index: 0, cardinality: 3, cardinalityNext: 3 } },
    ]);

    const result = await hasPriceFeedForPair(
      8453, "0xaaaa" as Address, "0xbbbb" as Address, "test-key",
    );
    expect(result).toBe(true);
    expect(mockMulticall).toHaveBeenCalledTimes(1);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns false when one token lacks a feed", async () => {
    mockMulticall.mockResolvedValueOnce([
      { status: "success", result: { index: 0, cardinality: 5, cardinalityNext: 5 } },
      { status: "success", result: { index: 0, cardinality: 0, cardinalityNext: 0 } },
    ]);

    const result = await hasPriceFeedForPair(
      8453, "0xaaaa" as Address, "0xbbbb" as Address, "test-key",
    );
    expect(result).toBe(false);
  });

  it("returns true for ETH → token (ETH always has feed)", async () => {
    mockReadContract.mockResolvedValueOnce({ index: 0, cardinality: 5, cardinalityNext: 5 });

    const result = await hasPriceFeedForPair(
      8453, "0x0000000000000000000000000000000000000000" as Address, "0xbbbb" as Address, "test-key",
    );
    expect(result).toBe(true);
    expect(mockReadContract).toHaveBeenCalledTimes(1); // Only token checked
    expect(mockMulticall).not.toHaveBeenCalled();
  });
});
