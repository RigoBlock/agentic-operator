/**
 * Swap handler tests — focused on 0x → Uniswap fallback and chat-based settings.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

// ── Mocked dependencies (must be in vi.hoisted so vi.mock factories can reference them) ──
const {
  mockGetZeroXQuote,
  mockFormatZeroXQuoteForDisplay,
  mockGetUniswapQuote,
  mockFormatUniswapQuoteForDisplay,
  mockGetUniswapSwapCalldata,
  mockGetVaultTokenBalance,
  mockEncodeVaultExecute,
  mockEnrichQuoteWithOracle,
  mockResolveSlippage,
  mockRunSwapShield,
  mockTxActionLine,
  mockSwitchChainIfNeeded,
  mockResolveChainName,
  mockResolveTokenAddress,
  mockGetWrappedNativeAddress,
  mockGetNativeTokenSymbol,
} = vi.hoisted(() => ({
  mockGetZeroXQuote: vi.fn(),
  mockFormatZeroXQuoteForDisplay: vi.fn(),
  mockGetUniswapQuote: vi.fn(),
  mockFormatUniswapQuoteForDisplay: vi.fn(() => "📊 Uniswap quote display"),
  mockGetUniswapSwapCalldata: vi.fn(),
  mockGetVaultTokenBalance: vi.fn(),
  mockEncodeVaultExecute: vi.fn(),
  mockEnrichQuoteWithOracle: vi.fn(),
  mockResolveSlippage: vi.fn().mockResolvedValue(100),
  mockRunSwapShield: vi.fn().mockResolvedValue({}),
  mockTxActionLine: vi.fn().mockReturnValue(""),
  mockSwitchChainIfNeeded: vi.fn().mockReturnValue(undefined),
  mockResolveChainName: vi.fn().mockReturnValue("Polygon"),
  mockResolveTokenAddress: vi.fn().mockImplementation(async (_chainId: number, symbol: string) => {
    const map: Record<string, string> = {
      POL: "0x0000000000000000000000000000000000000000",
      GRG: "0x3b3e4b4741e91af52d0e9ad8660573e951c88524",
      USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    };
    return map[symbol.toUpperCase()] || symbol;
  }),
  mockGetWrappedNativeAddress: vi.fn().mockReturnValue(null),
  mockGetNativeTokenSymbol: vi.fn().mockReturnValue("POL"),
}));

vi.mock("../src/services/zeroXTrading.js", () => ({
  getZeroXQuote: mockGetZeroXQuote,
  formatZeroXQuoteForDisplay: mockFormatZeroXQuoteForDisplay,
}));

vi.mock("../src/services/uniswapTrading.js", () => ({
  getUniswapQuote: mockGetUniswapQuote,
  formatUniswapQuoteForDisplay: mockFormatUniswapQuoteForDisplay,
  getUniswapSwapCalldata: mockGetUniswapSwapCalldata,
}));

vi.mock("../src/services/vault.js", () => ({
  getVaultTokenBalance: mockGetVaultTokenBalance,
  encodeVaultExecute: mockEncodeVaultExecute,
  getTokenDecimals: vi.fn().mockResolvedValue(18),
}));

vi.mock("../src/services/quoteEnrichment.js", () => ({
  enrichQuoteWithOracle: mockEnrichQuoteWithOracle,
}));

vi.mock("../src/llm/client.js", () => ({
  resolveSlippage: mockResolveSlippage,
  runSwapShield: mockRunSwapShield,
  txActionLine: mockTxActionLine,
  switchChainIfNeeded: mockSwitchChainIfNeeded,
  resolveChainName: mockResolveChainName,
}));

vi.mock("../src/config.js", () => ({
  resolveTokenAddress: mockResolveTokenAddress,
  getWrappedNativeAddress: mockGetWrappedNativeAddress,
  getNativeTokenSymbol: mockGetNativeTokenSymbol,
}));

import {
  handle_get_swap_quote,
  handle_build_vault_swap,
} from "../src/llm/handlers/swap.js";
import type { RequestContext } from "../src/types.js";

const OPERATOR = "0xcccc000000000000000000000000000000000003";
const VAULT = "0x1111111111111111111111111111111111111111";
const CHAIN_ID = 137;

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    vaultAddress: VAULT,
    chainId: CHAIN_ID,
    isBrowserRequest: true,
    operatorAddress: OPERATOR as `0x${string}`,
    ...overrides,
  };
}

function makeEnv(): any {
  return { KV: {} as KVNamespace, ALCHEMY_API_KEY: "test-key" };
}

function makeUniswapQuote() {
  return {
    routing: "CLASSIC",
    quote: {
      input: { token: "0x0000000000000000000000000000000000000000", amount: "1000000000000000000" },
      output: { token: "0x3b3e4b4741e91af52d0e9ad8660573e951c88524", amount: "5000000000000000000" },
      slippage: 0.01,
      gasFee: "0.001",
      gasFeeUSD: "0.50",
      gasUseEstimate: "300000",
      route: [],
    },
    decimalsIn: 18,
    decimalsOut: 18,
    _raw: {},
  };
}

function makeZeroXQuoteExactOutput(): any {
  return {
    buyAmount: "2500000000000000000",
    buyToken: "0x3b3e4b4741e91af52d0e9ad8660573e951c88524",
    sellAmount: "462706493551181",
    sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    maxSellAmount: "467689939752184",
    gas: "378832",
    gasPrice: "100000000",
    totalNetworkFee: "37883200000000",
    transaction: {
      to: "0x0000000000001fF3684f28c67538d4D072C22734" as Address,
      data: "0x2213bc0bdeadbeef" as Hex,
      gas: "378832",
      gasPrice: "100000000",
      value: "467689939752184",
    },
    decimalsIn: 18,
    decimalsOut: 18,
    _raw: {},
  };
}

function makeUniswapSwapTx(): { to: Address; from: Address; data: Hex; value: string; chainId: number } {
  const data = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "execute",
    args: ["0x00", ["0x"], BigInt(Math.floor(Date.now() / 1000) + 1800)],
  });
  return {
    to: "0x0000000000000000000000000000000000000000" as Address,
    from: VAULT as Address,
    data,
    value: "0x0",
    chainId: CHAIN_ID,
  };
}



describe("handle_get_swap_quote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to Uniswap when 0x reports no liquidity", async () => {
    mockGetZeroXQuote.mockRejectedValue(
      new Error("No liquidity found on 0x for POL → GRG on chain 137. Try Uniswap or a different chain."),
    );
    mockGetUniswapQuote.mockResolvedValue(makeUniswapQuote());

    const result = await handle_get_swap_quote(makeEnv(), makeCtx(), {
      tokenIn: "POL",
      tokenOut: "GRG",
      amountOut: "1",
    }, "get_swap_quote");

    expect(mockGetZeroXQuote).toHaveBeenCalledTimes(1);
    expect(mockGetUniswapQuote).toHaveBeenCalledTimes(1);
    expect(result.message).toContain("0x could not route");
    expect(result.message).toContain("Uniswap quote instead");
  });

  it("does not fallback on non-liquidity 0x errors", async () => {
    mockGetZeroXQuote.mockRejectedValue(new Error("Invalid swap parameters"));

    await expect(
      handle_get_swap_quote(makeEnv(), makeCtx(), {
        tokenIn: "POL",
        tokenOut: "GRG",
        amountOut: "1",
      }, "get_swap_quote"),
    ).rejects.toThrow("Invalid swap parameters");

    expect(mockGetUniswapQuote).not.toHaveBeenCalled();
  });
});

describe("handle_build_vault_swap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVaultTokenBalance.mockResolvedValue({ balance: BigInt("100000000000000000000"), decimals: 18, symbol: "POL" });
    mockEncodeVaultExecute.mockReturnValue("0xencoded" as Hex);
    mockEnrichQuoteWithOracle.mockResolvedValue({ priceFeedExists: true, oracleAmount: "0" });
    mockGetUniswapSwapCalldata.mockResolvedValue(makeUniswapSwapTx());
  });

  it("falls back to Uniswap when 0x reports no liquidity", async () => {
    mockGetZeroXQuote.mockRejectedValue(
      new Error("No liquidity found on 0x for POL → GRG on chain 137. Try Uniswap or a different chain."),
    );
    mockGetUniswapQuote.mockResolvedValue(makeUniswapQuote());

    const result = await handle_build_vault_swap(makeEnv(), makeCtx(), {
      tokenIn: "POL",
      tokenOut: "GRG",
      amountOut: "1",
    }, "build_vault_swap");

    expect(mockGetZeroXQuote).toHaveBeenCalledTimes(1);
    expect(mockGetUniswapQuote).toHaveBeenCalledTimes(1);
    expect(result.message).toContain("0x could not route");
    expect(result.message).toContain("routed via Uniswap instead");
    expect(result.transaction?.swapMeta?.dex).toBe("Uniswap");
  });

  it("does not fallback on non-liquidity 0x errors", async () => {
    mockGetZeroXQuote.mockRejectedValue(new Error("Swap Shield blocked this trade"));

    await expect(
      handle_build_vault_swap(makeEnv(), makeCtx(), {
        tokenIn: "POL",
        tokenOut: "GRG",
        amountOut: "1",
      }, "build_vault_swap"),
    ).rejects.toThrow("Swap Shield blocked this trade");

    expect(mockGetUniswapQuote).not.toHaveBeenCalled();
  });

  it("returns a transaction for exact-output native 0x swaps using the raw 0x calldata", async () => {
    mockGetZeroXQuote.mockResolvedValue(makeZeroXQuoteExactOutput());
    mockGetVaultTokenBalance.mockResolvedValue({ balance: BigInt("1000000000000000000"), decimals: 18, symbol: "ETH" });

    const result = await handle_build_vault_swap(makeEnv(), makeCtx({ chainId: 42161 }), {
      tokenIn: "ETH",
      tokenOut: "GRG",
      amountOut: "2.5",
    }, "build_vault_swap");

    expect(result.transaction).toBeDefined();
    expect(result.transaction?.data.toLowerCase().startsWith("0x2213bc0b")).toBe(true);
    expect(result.transaction?.value).toBe("0x0");
    expect(result.transaction?.swapMeta?.dex).toBe("0x Aggregator");
  });
});
