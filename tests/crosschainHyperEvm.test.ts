/**
 * HyperEVM (chain 999) bridge restrictions + NAV-sync fast path.
 *
 * Regression coverage for the prod Telegram failure:
 *   "crosschain sync nav from arbitrum to hyperEvm using WETH/USDC"
 * produced an LLM-authored "ready for your confirmation" reply with NO
 * transaction and NO error — the model never called the tool.
 *
 * Validation is data-driven, not HyperEVM-special-cased:
 *  1. resolveRouteToken (crosschain.ts) — an explicit token must resolve on the
 *     source chain AND have a matching type on the destination. HyperEVM
 *     USDC-only routes fall out of CROSSCHAIN_TOKENS[999]; on-chain simulation
 *     (AIntents eth_call + Across destination fill) remains the final backstop.
 *  2. tryFastPathCrosschainSync — "sync nav from X to Y [using TOKEN]" runs the
 *     tool deterministically, so the confirmation box always carries a real tx.
 *  Plus isTerminalToolError renders route-impossible errors directly instead of
 *  letting the model confabulate a reply that hides them.
 */
import { describe, it, expect, vi } from "vitest";
import type { Address } from "viem";

const mockGetVaultTokenBalance = vi.hoisted(() => vi.fn());
const mockGetRpcProvider = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("../src/services/vault.js", () => ({
  getVaultTokenBalance: mockGetVaultTokenBalance,
  getVaultTokenBalancesBulk: vi.fn(),
  getEffectivePoolState: vi.fn(),
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const { getCrosschainQuote, buildCrosschainTransfer, buildCrosschainSync } =
  await import("../src/services/crosschain.js");
const { isTerminalToolError, tryFastPathCrosschainSync, toolLabel } = await import("../src/llm/client.js");

const VAULT = "0x1111111111111111111111111111111111111111" as Address;

describe("explicit-token validation on HyperEVM routes (data-driven)", () => {
  it("getCrosschainQuote rejects WETH Arbitrum → HyperEVM before any RPC and lists USDC", async () => {
    await expect(
      getCrosschainQuote(42161, 999, "WETH", "1"),
    ).rejects.toThrow(/No matching WETH token on destination chain 999.*Available: USDC/i);
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("buildCrosschainTransfer rejects WETH Arbitrum → HyperEVM before balance reads", async () => {
    await expect(
      buildCrosschainTransfer({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 999,
        tokenSymbol: "WETH",
        amount: "1",
      }),
    ).rejects.toThrow(/No matching WETH token on destination chain 999/i);
    expect(mockGetVaultTokenBalance).not.toHaveBeenCalled();
  });

  it("buildCrosschainTransfer rejects WETH HyperEVM → Base (source side)", async () => {
    await expect(
      buildCrosschainTransfer({
        vaultAddress: VAULT,
        srcChainId: 999,
        dstChainId: 8453,
        tokenSymbol: "WETH",
        amount: "1",
      }),
    ).rejects.toThrow(/WETH is not bridgeable on chain 999.*Available: USDC/i);
  });

  it("buildCrosschainSync rejects an explicit WETH preference before equalization", async () => {
    await expect(
      buildCrosschainSync({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 999,
        tokenSymbol: "WETH",
      }),
    ).rejects.toThrow(/No matching WETH token on destination chain 999/i);
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
    expect(mockGetVaultTokenBalance).not.toHaveBeenCalled();
  });

  it("buildCrosschainSync rejects tokens that resolve to nothing (ETH, DAI) on HyperEVM routes", async () => {
    // "ETH" is not a bridgeable token type, so the preferred-token filter used
    // to drop it silently and bridge USDC anyway. Any explicit token that
    // cannot be bridged end-to-end must error — resolvable or not.
    await expect(
      buildCrosschainSync({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 999,
        tokenSymbol: "ETH",
      }),
    ).rejects.toThrow(/ETH is not bridgeable on chain 42161/i);
    await expect(
      buildCrosschainSync({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 999,
        tokenSymbol: "DAI",
      }),
    ).rejects.toThrow(/Available: USDC/i);
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("buildCrosschainSync also rejects explicit tokens with no destination match on non-HyperEVM routes", async () => {
    // WBTC exists on Arbitrum but not on Base — same silent-substitution hole,
    // same data-driven rejection. (Guard fires before any RPC.)
    await expect(
      buildCrosschainSync({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 8453,
        tokenSymbol: "WBTC",
      }),
    ).rejects.toThrow(/No matching WBTC token on destination chain 8453/i);
  });

  it("buildCrosschainSync does not reject USDC on the same route", async () => {
    // The guard passes; the call proceeds past validation. Mock the NAV reads
    // to throw a sentinel so we can prove the HyperEVM guard did NOT fire.
    mockGetRpcProvider.mockImplementation(() => {
      throw new Error("SENTINEL_PAST_GUARD");
    });
    await expect(
      buildCrosschainSync({
        vaultAddress: VAULT,
        srcChainId: 42161,
        dstChainId: 999,
        tokenSymbol: "USDC",
      }),
    ).rejects.toThrow("SENTINEL_PAST_GUARD");
  });
});

describe("isTerminalToolError", () => {
  it("treats route-impossible bridge errors as terminal", () => {
    expect(isTerminalToolError("Error: No matching WETH token on destination chain 999 (HyperEVM). Available: USDC.")).toBe(true);
    expect(isTerminalToolError("Error: WETH is not bridgeable on chain 42161 (Arbitrum). Available: USDC, USDT, WETH, WBTC.")).toBe(true);
    expect(isTerminalToolError("Error: No bridgeable token with balance on Arbitrum for NAV equalization. Checked: USDC.")).toBe(true);
  });

  it("keeps fixable errors non-terminal", () => {
    expect(isTerminalToolError("Error: NavImpactTooHigh: proposed sync moves NAV by 1.23%, exceeding the 1.00% tolerance. Provide navToleranceBps.")).toBe(false);
    expect(isTerminalToolError("Error: destinationChain is required for crosschain_sync.")).toBe(false);
    expect(isTerminalToolError("Error: Insufficient USDC balance on Arbitrum for sync. Available: 2, needed: 50.")).toBe(false);
  });

  it("keeps shield/revert errors terminal", () => {
    expect(isTerminalToolError("Error: ⚠️ Swap Shield blocked: price divergence 7.2% exceeds 5% tolerance")).toBe(true);
    expect(isTerminalToolError("Error: execution reverted: EffectiveSupplyTooLow")).toBe(true);
  });
});

describe("toolLabel", () => {
  it("maps known tools to friendly labels (no raw snake_case in UI)", () => {
    expect(toolLabel("crosschain_sync")).toBe("NAV sync");
    expect(toolLabel("crosschain_transfer")).toBe("cross-chain transfer");
    expect(toolLabel("get_tool_menu")).toBe("tool menu");
    expect(toolLabel("gmx_get_positions")).toBe("GMX positions");
  });

  it("falls back to a spaced name for unmapped tools — never snake_case", () => {
    expect(toolLabel("some_future_tool")).toBe("some future tool");
    expect(toolLabel("hyperliquid_limit_order")).not.toContain("_");
  });
});

describe("tryFastPathCrosschainSync", () => {
  it("matches the exact prod request with a token", () => {
    const r = tryFastPathCrosschainSync("crosschain sync nav from arbitrum to hyperEvm using WETH");
    expect(r).toEqual({
      name: "crosschain_sync",
      args: { sourceChain: "arbitrum", destinationChain: "hyperEvm", token: "WETH" },
    });
  });

  it("matches without the crosschain prefix and with 'with'", () => {
    const r = tryFastPathCrosschainSync("sync nav from arbitrum to hyperEvm with USDC");
    expect(r).toEqual({
      name: "crosschain_sync",
      args: { sourceChain: "arbitrum", destinationChain: "hyperEvm", token: "USDC" },
    });
  });

  it("matches without a token", () => {
    const r = tryFastPathCrosschainSync("sync nav from base to arbitrum");
    expect(r).toEqual({
      name: "crosschain_sync",
      args: { sourceChain: "base", destinationChain: "arbitrum" },
    });
  });

  it("matches multi-word chain names", () => {
    const r = tryFastPathCrosschainSync("sync nav from bnb chain to polygon");
    expect(r?.args).toEqual({ sourceChain: "bnb chain", destinationChain: "polygon" });
  });

  it("does not match explicit-amount syncs (stay on the LLM path)", () => {
    expect(tryFastPathCrosschainSync("sync 50 usdc from base to arbitrum")).toBeNull();
  });

  it("does not match questions or unrelated text", () => {
    expect(tryFastPathCrosschainSync("what is nav sync?")).toBeNull();
    expect(tryFastPathCrosschainSync("sync nav between my chains")).toBeNull();
    expect(tryFastPathCrosschainSync("get aggregated nav")).toBeNull();
  });
});
