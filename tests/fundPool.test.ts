/**
 * fund_pool tests — approve/mint sequencing for ERC-20 base tokens.
 *
 * Regression guard for the approve-loop bug: the ERC-20 branch previously
 * ALWAYS returned the approve transaction and never checked on-chain
 * allowance, so after the operator mined the approval, asking again returned
 * the same approve tx forever. Now the allowance is read on-chain and a
 * sufficient allowance returns the mint directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";
import { handle_fund_pool } from "../src/llm/handlers/vault-mgmt.js";
import type { RequestContext, Env } from "../src/types.js";

const { mockReadContract, mockGetPoolData, mockGetNavData, mockGetTokenDecimals, mockGetVaultTokenBalance } =
  vi.hoisted(() => ({
    mockReadContract: vi.fn(),
    mockGetPoolData: vi.fn(),
    mockGetNavData: vi.fn(),
    mockGetTokenDecimals: vi.fn(),
    mockGetVaultTokenBalance: vi.fn(),
  }));

vi.mock("../src/services/rpcClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/rpcClient.js")>();
  return {
    ...actual,
    getRpcProvider: () => ({ readContract: mockReadContract }),
  };
});

vi.mock("../src/services/vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/vault.js")>();
  return {
    ...actual,
    getPoolData: mockGetPoolData,
    getNavData: mockGetNavData,
    getTokenDecimals: mockGetTokenDecimals,
    getVaultTokenBalance: mockGetVaultTokenBalance,
  };
});

const USDC = "0xf2A5728d366c6d0f764Af612cD47F3608E2B4d5B";
const VAULT = "0x07816c517ccf14c64c7de3aef88d638f12c1c9be";
const OPERATOR = "0x000f05552f24850e75793d38c2bd0cbd249a9ff4";
const ZERO = "0x0000000000000000000000000000000000000000";

const env = {} as Env;

function makeCtx(): RequestContext {
  return {
    vaultAddress: VAULT as Address,
    chainId: 19529,
    operatorAddress: OPERATOR as Address,
    isBrowserRequest: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // USDC-based pool, unpriced (fresh — updateUnitaryValue returns the initial
  // unitary value with zero total value)
  mockGetPoolData.mockResolvedValue({ name: "earnest", symbol: "EARN", baseToken: USDC });
  mockGetNavData.mockResolvedValue({ unitaryValue: 1_000_000n, totalValue: 0n, timestamp: 0n });
  mockGetTokenDecimals.mockResolvedValue(6);
  mockGetVaultTokenBalance.mockResolvedValue({ symbol: "USDC", balance: 0n });
});

describe("fund_pool with an ERC-20 base token", () => {
  it("returns the approve transaction when allowance is zero", async () => {
    mockReadContract.mockResolvedValue(0n);
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");

    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "allowance", args: [OPERATOR, VAULT] }),
    );
    expect(result.transaction?.to.toLowerCase()).toBe(USDC.toLowerCase());
    // approve(address,uint256) selector
    expect(result.transaction?.data.startsWith("0x095ea7b3")).toBe(true);
    expect(result.message).toContain("2 transactions");
    // Deterministic follow-up: the frontend re-invokes fund_pool after the
    // approval confirms (no LLM roundtrip) and the mint is returned.
    expect(result.transaction?.nextStep).toEqual({
      toolName: "fund_pool",
      arguments: { amount: "35" },
    });
  });

  it("carries the recipient into the follow-up when one was given", async () => {
    mockReadContract.mockResolvedValue(0n);
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35", recipient: OPERATOR }, "fund_pool");
    expect(result.transaction?.nextStep?.arguments).toEqual({ amount: "35", recipient: OPERATOR });
  });

  it("mint transactions carry no follow-up", async () => {
    mockReadContract.mockResolvedValue(100n * 10n ** 6n);
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");
    expect(result.transaction?.nextStep).toBeUndefined();
  });

  it("returns the approve transaction when allowance is insufficient", async () => {
    mockReadContract.mockResolvedValue(10n * 10n ** 6n); // 10 USDC approved, wants 35
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");

    expect(result.transaction?.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(result.transaction?.data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("returns the MINT transaction when allowance already covers the deposit", async () => {
    mockReadContract.mockResolvedValue(100n * 10n ** 6n); // 100 USDC approved, wants 35
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");

    expect(result.transaction?.to.toLowerCase()).toBe(VAULT.toLowerCase());
    // mint(address,uint256,uint256) selector — NOT approve
    expect(result.transaction?.data.startsWith("0x156e29f6")).toBe(true);
    expect(result.transaction?.value).toBe("0x0");
    expect(result.message).toContain("approval already on-chain");
  });

  it("mints exactly at the approved amount boundary", async () => {
    mockReadContract.mockResolvedValue(35n * 10n ** 6n); // exactly 35 USDC
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");

    expect(result.transaction?.data.startsWith("0x156e29f6")).toBe(true);
  });

  it("treats a fresh pool (initial unitary value, zero total value) as a first mint", async () => {
    // Regression: updateUnitaryValue() returns the pool's INITIAL unitary value
    // (10^decimals) even when empty. Pricing amountOutMin against it demanded
    // ~10^12x the tokens a first mint actually produces and the mint reverted
    // on-chain with a bare "execution reverted".
    mockReadContract.mockResolvedValue(100n * 10n ** 6n);
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");

    expect(result.transaction?.data.startsWith("0x156e29f6")).toBe(true);
    const { decodeFunctionData } = await import("viem");
    const decoded = decodeFunctionData({
      abi: [{ type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] }],
      data: result.transaction!.data as `0x${string}`,
    });
    expect(decoded.args![2]).toBe(0n); // amountOutMin = 0 — no live NAV to protect
    expect(result.message).toContain("first mint");
  });

  it("prices amountOutMin from NAV when the pool is funded", async () => {
    mockGetNavData.mockResolvedValue({ unitaryValue: 1_000_000_000_000_000_000n, totalValue: 100n * 10n ** 6n, timestamp: 0n });
    mockReadContract.mockResolvedValue(100n * 10n ** 6n);
    const result = await handle_fund_pool(env, makeCtx(), { amount: "35" }, "fund_pool");

    const { decodeFunctionData } = await import("viem");
    const decoded = decodeFunctionData({
      abi: [{ type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] }],
      data: result.transaction!.data as `0x${string}`,
    });
    // 35 USDC in, NAV 1.0 → 35e6 pool tokens, 5% slippage floor
    expect(decoded.args![2]).toBe((35n * 10n ** 6n * 95n) / 100n);
  });
});

describe("fund_pool with a native base token", () => {
  it("returns a single payable mint — no approve, no allowance read", async () => {
    mockGetPoolData.mockResolvedValue({ name: "Ether Pool", symbol: "ETHP", baseToken: ZERO });
    const result = await handle_fund_pool(env, makeCtx(), { amount: "1.5" }, "fund_pool");

    expect(mockReadContract).not.toHaveBeenCalled();
    expect(result.transaction?.to.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(result.transaction?.value).toBe("0x14d1120d7b160000"); // 1.5e18
    expect(result.transaction?.data.startsWith("0x156e29f6")).toBe(true);
  });
});

describe("fund_pool input validation", () => {
  it("requires an amount", async () => {
    await expect(handle_fund_pool(env, makeCtx(), {}, "fund_pool")).rejects.toThrow(/Amount is required/);
  });

  it("requires a connected wallet", async () => {
    const ctx = { ...makeCtx(), operatorAddress: undefined } as unknown as RequestContext;
    await expect(handle_fund_pool(env, ctx, { amount: "35" }, "fund_pool"))
      .rejects.toThrow(/Wallet not connected/);
  });
});
