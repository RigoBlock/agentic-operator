/**
 * 0x Swap API Service tests.
 *
 * Tests:
 * 1. Exact-input quote builds sellAmount parameter
 * 2. Exact-output quote builds buyAmount parameter (no oracle estimation)
 * 3. Missing amount throws
 * 4. Upstream error throws
 * 5. Empty transaction data throws
 * 6. Exact-output buyAmount sanity check
 * 7. Native ETH address mapping
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

// ── Mocks ───────────────────────────────────────────────────────────────
const { mockResolveTokenAddress, mockGetTokenDecimals, mockEstimateAmountInViaEOracle } = vi.hoisted(() => ({
  mockResolveTokenAddress: vi.fn(),
  mockGetTokenDecimals: vi.fn(),
  mockEstimateAmountInViaEOracle: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveTokenAddress: mockResolveTokenAddress,
}));

vi.mock("../src/services/vault.js", () => ({
  getTokenDecimals: mockGetTokenDecimals,
  getClient: vi.fn(),
}));

vi.mock("../src/services/eOracle.js", () => ({
  estimateAmountInViaEOracle: mockEstimateAmountInViaEOracle,
}));

import { getZeroXQuote, getZeroXVaultQuote } from "../src/services/zeroXTrading.js";
import type { Env, SwapIntent } from "../src/types.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const NATIVE_ETH_0X = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const TAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;

function mockEnv(): Env {
  return {
    ZEROX_API_KEY: "test-0x-key",
    ALCHEMY_API_KEY: "test-alchemy-key",
  } as Env;
}

function mockQuoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    buyAmount: "2000000000",
    buyToken: USDC,
    sellAmount: "1000000000000000000",
    sellToken: WETH,
    maxSellAmount: "1010000000000000000",
    gas: "200000",
    gasPrice: "1000000000",
    totalNetworkFee: "200000000000000",
    liquidityAvailable: true,
    transaction: {
      to: "0x0000000000001fF3684f28c67538d4D072C22734",
      data: "0x1234",
      gas: "200000",
      gasPrice: "1000000000",
      value: "0",
    },
    ...overrides,
  };
}

function mockExactOutputResponse(overrides: Record<string, unknown> = {}) {
  return {
    buyAmount: "2000000000",
    buyToken: USDC,
    estimatedNetSellAmount: "1000000000000000000",
    sellToken: WETH,
    maxSellAmount: "1010000000000000000",
    mode: "exact-out",
    gas: "200000",
    gasPrice: "1000000000",
    totalNetworkFee: "200000000000000",
    liquidityAvailable: true,
    transaction: {
      to: "0x0000000000001fF3684f28c67538d4D072C22734",
      data: "0x1234",
      gas: "200000",
      gasPrice: "1000000000",
      value: "0",
    },
    ...overrides,
  };
}

describe("getZeroXQuote", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockResolveTokenAddress.mockReset();
    mockGetTokenDecimals.mockReset();
    mockEstimateAmountInViaEOracle.mockReset();
    // WETH = 18 decimals, USDC = 6 decimals
    mockGetTokenDecimals.mockImplementation(async (_chainId: number, address: string) =>
      address.toLowerCase() === USDC.toLowerCase() ? 6 : 18
    );
  });

  it("builds an exact-input quote with sellAmount", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);
    mockGetTokenDecimals.mockResolvedValue(18);

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(mockQuoteResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1",
      slippageBps: 100,
    };

    const quote = await getZeroXQuote(mockEnv(), intent, 1, TAKER);

    expect(quote.buyAmount).toBe("2000000000");
    expect(quote.sellAmount).toBe("1000000000000000000");
    expect(quote.maxSellAmount).toBe("1010000000000000000");

    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const url = new URL(fetchCalls[0][0]);
    expect(url.searchParams.get("sellAmount")).toBe("1000000000000000000");
    expect(url.searchParams.get("buyAmount")).toBeNull();
    expect(url.searchParams.get("slippageBps")).toBe("100");
  });

  it("builds an exact-output quote with buyAmount (no vault required)", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(mockExactOutputResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountOut: "2000",
      slippageBps: 100,
    };

    // Quote-only: pass the zero-address sentinel. This previously required a
    // real vault for oracle estimation; with native exact-output support it
    // should work without one.
    const quote = await getZeroXQuote(mockEnv(), intent, 1, ZERO_ADDR);

    expect(quote.buyAmount).toBe("2000000000");
    expect(quote.sellAmount).toBe("1000000000000000000");

    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const url = new URL(fetchCalls[0][0]);
    expect(url.searchParams.get("buyAmount")).toBe("2000000000");
    expect(url.searchParams.get("sellAmount")).toBeNull();
    expect(url.searchParams.get("taker")).toBe(TAKER); // falls back to vitalik
  });

  it("throws when neither amountIn nor amountOut is specified", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
    };

    await expect(getZeroXQuote(mockEnv(), intent, 1, TAKER)).rejects.toThrow(
      "Either amountIn or amountOut must be specified",
    );
  });

  it("throws on upstream 0x error", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);
    mockGetTokenDecimals.mockResolvedValue(18);

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ reason: "Validation Failed", code: "1004" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1",
    };

    await expect(getZeroXQuote(mockEnv(), intent, 1, TAKER)).rejects.toThrow(
      "0x quote failed (400): Validation Failed",
    );
  });

  it("throws when transaction data is empty", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);
    mockGetTokenDecimals.mockResolvedValue(18);

    (global.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify(mockQuoteResponse({ transaction: { ...mockQuoteResponse().transaction, data: "0x" } })),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1",
    };

    await expect(getZeroXQuote(mockEnv(), intent, 1, TAKER)).rejects.toThrow(
      "empty transaction data",
    );
  });

  it("throws when exact-output buyAmount is far below requested", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);

    // User wants 2000 USDC but API only promises 1000 USDC (>1% short)
    (global.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify(mockExactOutputResponse({ buyAmount: "1000000000" })),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountOut: "2000",
    };

    await expect(getZeroXQuote(mockEnv(), intent, 1, TAKER)).rejects.toThrow(
      "is below the requested",
    );
  });

  it("maps the zero-address ETH sentinel to 0x native token address", async () => {
    mockResolveTokenAddress
      .mockResolvedValueOnce(ZERO_ADDR) // tokenIn = ETH
      .mockResolvedValueOnce(USDC);     // tokenOut = USDC
    mockGetTokenDecimals.mockResolvedValue(18);

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(mockQuoteResponse({ sellToken: NATIVE_ETH_0X })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const intent: SwapIntent = {
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountIn: "1",
    };

    await getZeroXQuote(mockEnv(), intent, 1, TAKER);

    const fetchCalls = (global.fetch as any).mock.calls;
    const url = new URL(fetchCalls[0][0]);
    expect(url.searchParams.get("sellToken")).toBe(NATIVE_ETH_0X);
    expect(url.searchParams.get("buyToken")).toBe(USDC);
  });
});

describe("getZeroXVaultQuote", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockResolveTokenAddress.mockReset();
    mockGetTokenDecimals.mockReset();
    mockEstimateAmountInViaEOracle.mockReset();
    mockGetTokenDecimals.mockImplementation(async (_chainId: number, address: string) =>
      address.toLowerCase() === USDC.toLowerCase() ? 6 : 18
    );
  });

  it("converts an exact-output intent to an estimated exact-input quote", async () => {
    // getZeroXVaultQuote resolves tokens, then getZeroXQuote resolves them again.
    mockResolveTokenAddress
      .mockResolvedValueOnce(WETH)
      .mockResolvedValueOnce(USDC)
      .mockResolvedValueOnce(WETH)
      .mockResolvedValueOnce(USDC);
    mockEstimateAmountInViaEOracle.mockResolvedValueOnce(1000000000000000000n); // 1 WETH

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(mockQuoteResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountOut: "2000",
      slippageBps: 100,
    };

    const quote = await getZeroXVaultQuote(mockEnv(), intent, 1, VAULT);

    expect(quote.convertedFromExactOutput).toBe(true);

    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const url = new URL(fetchCalls[0][0]);
    expect(url.searchParams.get("buyAmount")).toBeNull();
    // 1 WETH — EOracle estimate is used directly
    expect(url.searchParams.get("sellAmount")).toBe("1000000000000000000");
  });

  it("passes an exact-input vault intent through unchanged", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(mockQuoteResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1",
      slippageBps: 100,
    };

    const quote = await getZeroXVaultQuote(mockEnv(), intent, 1, VAULT);

    expect(quote.convertedFromExactOutput).toBeUndefined();

    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const url = new URL(fetchCalls[0][0]);
    expect(url.searchParams.get("sellAmount")).toBe("1000000000000000000");
  });

  it("throws a conversion error when EOracle cannot estimate the input", async () => {
    mockResolveTokenAddress.mockResolvedValueOnce(WETH).mockResolvedValueOnce(USDC);
    mockEstimateAmountInViaEOracle.mockRejectedValueOnce(new Error("EOracle not available"));

    const intent: SwapIntent = {
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountOut: "2000",
      slippageBps: 100,
    };

    await expect(getZeroXVaultQuote(mockEnv(), intent, 1, VAULT)).rejects.toThrow(
      /0x exact-output vault swap cannot be converted/,
    );
  });
});
