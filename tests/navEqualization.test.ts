/**
 * NAV equalization math tests.
 *
 * Verifies that computeNavEqualization() caps the bridge amount at the smaller of
 *   - how much the source chain is above the global target, and
 *   - how much the destination chain is below the global target,
 * so the destination chain never overshoots.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionResult, type Address } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const mockGetEffectivePoolState = vi.hoisted(() => vi.fn());
const mockGetVaultTokenBalance = vi.hoisted(() => vi.fn());
const mockGetVaultTokenBalancesBulk = vi.hoisted(() => vi.fn());
const mockGetPoolData = vi.hoisted(() => vi.fn());
const mockGetClient = vi.hoisted(() => vi.fn());
const mockConvertTokenAmountViaOracle = vi.hoisted(() => vi.fn());
const mockGetDelegationConfig = vi.hoisted(() => vi.fn());
const mockGetActiveChains = vi.hoisted(() => vi.fn());

vi.mock("../src/services/vault.js", () => ({
  getEffectivePoolState: mockGetEffectivePoolState,
  getVaultTokenBalance: mockGetVaultTokenBalance,
  getVaultTokenBalancesBulk: mockGetVaultTokenBalancesBulk,
  getPoolData: mockGetPoolData,
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetClient,
}));

vi.mock("../src/services/oraclePrice.js", () => ({
  convertTokenAmountViaOracle: mockConvertTokenAmountViaOracle,
}));

vi.mock("../src/services/delegation.js", () => ({
  getDelegationConfig: mockGetDelegationConfig,
  getActiveChains: mockGetActiveChains,
}));

const { computeNavEqualization, projectSyncNavImpact } = await import("../src/services/crosschain.js");

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const zeroAddr = "0x0000000000000000000000000000000000000000" as Address;

function makeKV(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

describe("computeNavEqualization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDelegationConfig.mockResolvedValue(null);
    mockGetActiveChains.mockReturnValue([]);
    // Default: vault holds 1_000 of each bridgeable token.
    mockGetVaultTokenBalance.mockResolvedValue({
      balance: 1_000_000_000_000_000_000_000n,
      decimals: 18,
      symbol: "WETH",
    });
    mockGetVaultTokenBalancesBulk.mockImplementation(async (_chainId, _vault, tokenAddresses) => {
      const balances = new Map<string, bigint>();
      for (const addr of tokenAddresses) {
        balances.set(addr.toLowerCase(), 1_000_000_000_000_000_000_000n);
      }
      return balances;
    });
    mockGetClient.mockImplementation((chainId: number) => ({
      readContract: vi.fn().mockResolvedValue(0n),
      multicall: vi.fn(async ({ contracts }: { contracts: any[] }) => {
        const state = await mockGetEffectivePoolState(chainId, VAULT);
        return contracts.map((c: any, i: number) => {
          if (i === 0) {
            // updateUnitaryValue
            return {
              status: "success",
              result: state
                ? { unitaryValue: state.unitaryValue, netTotalValue: state.netTotalValue, netTotalLiabilities: 0n }
                : { unitaryValue: 0n, netTotalValue: 0n, netTotalLiabilities: 0n },
            };
          }
          if (i === 1) {
            // getPool
            return {
              status: "success",
              result: state
                ? { name: "Test", symbol: "TEST", decimals: state.decimals, owner: VAULT, baseToken: state.baseToken }
                : { name: "", symbol: "", decimals: 18, owner: VAULT, baseToken: zeroAddr },
            };
          }
          if (i === 2) {
            // totalSupply
            return { status: "success", result: 0n };
          }
          // balanceOf for bridgeable tokens
          return { status: "success", result: 1_000_000_000_000_000_000_000n };
        });
      }),
    }));
    // Oracle: 1 ETH = 1 USDC. Convert keeps the numeric value, maps 6-dec <-> 18-dec.
    const usdcAddresses = new Set([
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase(), // Ethereum
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831".toLowerCase(), // Arbitrum
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(), // Base
      "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85".toLowerCase(), // Optimism
      "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359".toLowerCase(), // Polygon
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d".toLowerCase(), // BSC
      "0x078D782b760474a361dDA0AF3839290b0EF57AD6".toLowerCase(), // Unichain
    ]);
    mockConvertTokenAmountViaOracle.mockImplementation(async (_chainId, from, amount, to) => {
      const fromIsUsdc = usdcAddresses.has(String(from).toLowerCase());
      const toIsUsdc = usdcAddresses.has(String(to).toLowerCase());
      if (fromIsUsdc && !toIsUsdc) {
        // USDC -> WETH at 1:1 (6 dec -> 18 dec)
        return amount * 1_000_000_000_000n;
      }
      if (!fromIsUsdc && toIsUsdc) {
        // WETH/base token -> USDC at 1:1 (18 dec -> 6 dec)
        return amount / 1_000_000_000_000n;
      }
      return amount;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses min(source excess, destination deficit) and never overshoots destination", async () => {
    // Three ETH-base chains. The global target is pulled by chain 8453,
    // so source/destination deviations are NOT equal in magnitude.
    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 1) {
        // Below target: 100 total USDC, price 2.0, supply 50
        return {
          unitaryValue: 2_000_000_000_000_000_000n,
          netTotalValue: 100_000_000_000_000_000_000n,
          effectiveSupply: 50_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      if (chainId === 42161) {
        // Above target by a SMALL amount: 4 total USDC, price 4.0, supply 1
        return {
          unitaryValue: 4_000_000_000_000_000_000n,
          netTotalValue: 4_000_000_000_000_000_000n,
          effectiveSupply: 1_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      if (chainId === 8453) {
        // Above target by a LARGER amount: 25 total USDC, price 2.5, supply 10
        return {
          unitaryValue: 2_500_000_000_000_000_000n,
          netTotalValue: 25_000_000_000_000_000_000n,
          effectiveSupply: 10_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      return null;
    });

    const result = await computeNavEqualization({
      vaultAddress: VAULT,
      userSrcChainId: 42161,
      userDstChainId: 1,
    });

    // Global target = 129 / 61 ≈ 2.114754
    expect(parseFloat(result.targetPrice)).toBeCloseTo(2.114754, 5);

    // Source (42161) deviation = +1.885246 USDC.
    // Destination (chain 1) deviation = -5.737704 USDC.
    // Bridge amount must be the smaller of the two: ~1.885 USDC.
    expect(parseFloat(result.srcDeviationUsdc)).toBeCloseTo(1.885246, 5);
    expect(parseFloat(result.dstDeviationUsdc)).toBeCloseTo(-5.737704, 5);
    expect(parseFloat(result.bridgeAmountUsdc)).toBeCloseTo(1.885246, 5);

    // Direction should NOT be swapped: user asked 42161 -> 1 and 42161 is above target.
    expect(result.directionAutoSwapped).toBe(false);
    expect(result.srcChainId).toBe(42161);
    expect(result.dstChainId).toBe(1);

    // Post-bridge: source should land on target, destination should move toward
    // target but remain below it (no overshoot).
    expect(parseFloat(result.postSrcPrice)).toBeCloseTo(2.114754, 5);
    expect(parseFloat(result.postDstPrice)).toBeCloseTo(2.037705, 5);
    expect(parseFloat(result.postDstPrice)).toBeGreaterThan(2.0);
    expect(parseFloat(result.postDstPrice)).toBeLessThan(2.114754);
  });

  it("auto-swaps direction when the requested source is below target", async () => {
    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 1) {
        return {
          unitaryValue: 4_000_000_000_000_000_000n,
          netTotalValue: 4_000_000_000_000_000_000n,
          effectiveSupply: 1_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      if (chainId === 42161) {
        return {
          unitaryValue: 2_000_000_000_000_000_000n,
          netTotalValue: 100_000_000_000_000_000_000n,
          effectiveSupply: 50_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      return null;
    });

    const result = await computeNavEqualization({
      vaultAddress: VAULT,
      userSrcChainId: 42161, // user says 42161 -> 1
      userDstChainId: 1,
    });

    // 42161 is below target, 1 is above target, so direction must be swapped.
    expect(result.directionAutoSwapped).toBe(true);
    expect(result.srcChainId).toBe(1);
    expect(result.dstChainId).toBe(42161);
  });
});

describe("cross-base sync token selection", () => {
  // Ethereum pool base = WETH, BSC pool base = USDT → cross-base route. Token
  // selection is purely preference order (base-type match, then stable, then
  // others) regardless of the pools' base assets.
  const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
  const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955" as Address;
  const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
  const SIX_DEC_USDC = new Set([
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase(), // Ethereum
  ]);

  // Oracle at 1:1. BSC USDC/USDT are 18-dec, so base(18-dec) → BSC USDC is a
  // plain 1:1 in 18-dec units; 6-dec chains keep the 1e12 scaling.
  function mockCrossBaseOracle() {
    mockConvertTokenAmountViaOracle.mockImplementation(
      async (_c: number, from: unknown, amount: bigint, to: unknown) => {
        const fromIsUsdc = SIX_DEC_USDC.has(String(from).toLowerCase());
        const toIsUsdc = SIX_DEC_USDC.has(String(to).toLowerCase());
        if (String(to).toLowerCase() === BSC_USDC.toLowerCase() && !fromIsUsdc) {
          return amount;
        }
        if (fromIsUsdc && !toIsUsdc) return amount * 1_000_000_000_000n;
        if (!fromIsUsdc && toIsUsdc) return amount / 1_000_000_000_000n;
        return amount;
      },
    );
  }

  function mockCrossBaseStates() {
    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 1) {
        return {
          unitaryValue: 4_000_000_000_000_000_000n,
          netTotalValue: 4_000_000_000_000_000_000n,
          effectiveSupply: 1_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: WETH_MAINNET,
        };
      }
      if (chainId === 56) {
        return {
          unitaryValue: 2_000_000_000_000_000_000n,
          netTotalValue: 100_000_000_000_000_000_000n,
          effectiveSupply: 50_000_000_000_000_000_000n,
          decimals: 18,
          baseToken: USDT_BSC,
        };
      }
      return null;
    });
  }

  it("selects a preferred WETH on a cross-base route and converts via oracle", async () => {
    mockCrossBaseStates();
    mockCrossBaseOracle();
    const result = await computeNavEqualization({
      vaultAddress: VAULT,
      userSrcChainId: 1,
      userDstChainId: 56,
      preferredToken: "WETH",
    });
    expect(result.bridgeToken.type).toBe("WETH");
    expect(result.bridgeToken.symbol).toBe("WETH");
    // WETH is priced through the USDC oracle reference, not blocked by base-asset policy.
    const usdcToWeth = mockConvertTokenAmountViaOracle.mock.calls.find(
      ([_c, from, , to]) =>
        String(from).toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" &&
        String(to).toLowerCase() === WETH_MAINNET.toLowerCase(),
    );
    expect(usdcToWeth).toBeDefined();
  });

  it("selects by normal preference order on a cross-base route without a preference", async () => {
    mockCrossBaseStates();
    mockCrossBaseOracle();
    const result = await computeNavEqualization({
      vaultAddress: VAULT,
      userSrcChainId: 1,
      userDstChainId: 56,
    });
    // All balances equal (default mock): the base-token-type match (WETH) beats
    // the stable tier even though the destination pool's base is USDT.
    expect(result.bridgeToken.type).toBe("WETH");
  });

  it("lists checked tokens and actual balances when nothing has balance", async () => {
    mockCrossBaseStates();
    mockCrossBaseOracle();
    mockGetVaultTokenBalancesBulk.mockResolvedValue(new Map<string, bigint>());
    const err = await computeNavEqualization({
      vaultAddress: VAULT,
      userSrcChainId: 1,
      userDstChainId: 56,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Checked balances — USDC: 0, USDT: 0, WETH: 0/);
  });
});

describe("projectSyncNavImpact — NavImpactTooHigh fallback", () => {
  const UPDATE_SELECTOR = "0xe7d8724e"; // updateUnitaryValue()
  const OPERATOR = "0xcccc000000000000000000000000000000000099" as Address;
  const WETH_ARB = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address;

  function encodeNavReturn(unitaryValue: bigint, netTotalValue: bigint) {
    return encodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      result: [unitaryValue, netTotalValue, 0n] as any,
    });
  }

  it("computes the projected drop from pre-sync NAV when the multicall reverts", async () => {
    mockGetClient.mockImplementation(() => ({
      call: vi.fn(async (args: { data: string }) => {
        if (args.data.slice(0, 10) === UPDATE_SELECTOR) {
          // unitaryValue 2, netTotalValue 100,000 (18-dec base token)
          return { data: encodeNavReturn(2_000_000_000_000_000_000n, 100_000_000_000_000_000_000_000n) };
        }
        // multicall([depositV3, updateUnitaryValue]) → genuine NavImpactTooHigh
        throw Object.assign(new Error("execution reverted"), { data: "0x3471741b" });
      }),
    }));
    mockGetPoolData.mockResolvedValue({
      name: "T", symbol: "T", decimals: 18, owner: OPERATOR, baseToken: WETH_ARB,
    });
    // Oracle 1:1 numerically: 5000 USDC (6-dec) → 5000 WETH (18-dec)
    mockConvertTokenAmountViaOracle.mockImplementation(
      async (_c: number, _f: unknown, amount: bigint) => amount * 1_000_000_000_000n,
    );

    const res = await projectSyncNavImpact({
      vaultAddress: VAULT,
      srcChainId: 42161,
      depositV3Calldata: "0xdeadbeef" as `0x${string}`,
      operatorAddress: OPERATOR,
      inputTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address, // USDC arb
      inputAmountRaw: 5_000_000_000n, // 5000 USDC (6-dec)
    });

    expect(res).toBeDefined();
    // 5000 out of 100,000 total → -5% projected unit-price drop
    expect(res!.impactPct).toBe("-5.0000");
    expect(res!.preUnitaryValue).toBe("2000000000000000000");
  });

  it("returns undefined when the revert is not NavImpactTooHigh", async () => {
    mockGetClient.mockImplementation(() => ({
      call: vi.fn(async (args: { data: string }) => {
        if (args.data.slice(0, 10) === UPDATE_SELECTOR) {
          return { data: encodeNavReturn(2_000_000_000_000_000_000n, 100_000_000_000_000_000_000_000n) };
        }
        throw Object.assign(new Error("execution reverted"), { data: "0xdeadbeef" });
      }),
    }));
    const res = await projectSyncNavImpact({
      vaultAddress: VAULT,
      srcChainId: 42161,
      depositV3Calldata: "0xdeadbeef" as `0x${string}`,
      operatorAddress: OPERATOR,
      inputTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
      inputAmountRaw: 5_000_000_000n,
    });
    expect(res).toBeUndefined();
  });
});
