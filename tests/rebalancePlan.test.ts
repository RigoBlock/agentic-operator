/**
 * Rebalance plan tests.
 *
 * Regression coverage for two prod issues in buildRebalancePlan:
 *  1. Auto-target selection compared raw base-token totals across chains
 *     (3,800 POL > 62 ETH numerically), picking cheap-unit chains like Polygon
 *     over the actual largest holding. Target must be chosen by USDC value.
 *  2. Dust balances (0.000000 USDC, sub-dollar amounts) produced bridge
 *     operations that cost more in fees than they move — and dragged chains
 *     like HyperEVM into the "delegation missing" warning with zero-value ops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Address } from "viem";

const mockGetEffectivePoolState = vi.hoisted(() => vi.fn());
const mockGetVaultTokenBalance = vi.hoisted(() => vi.fn());
const mockConvertTokenAmountViaOracle = vi.hoisted(() => vi.fn());
const mockGetDelegationConfig = vi.hoisted(() => vi.fn());
const mockGetActiveChains = vi.hoisted(() => vi.fn());
/** Per-chain token balances served by the multicall balanceOf mock. */
const balances = vi.hoisted(() => ({}) as Record<number, Record<string, bigint>>);

vi.mock("../src/services/vault.js", () => ({
  getEffectivePoolState: mockGetEffectivePoolState,
  getVaultTokenBalance: mockGetVaultTokenBalance,
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: vi.fn((chainId: number) => ({
    readContract: vi.fn().mockResolvedValue(0n),
    multicall: vi.fn(async ({ contracts }: { contracts: any[] }) => {
      const vault = "0x1111111111111111111111111111111111111111";
      const state = await mockGetEffectivePoolState(chainId, vault);
      return contracts.map((c: any, i: number) => {
        if (i === 0) {
          return {
            status: "success",
            result: state
              ? { unitaryValue: state.unitaryValue, netTotalValue: state.netTotalValue, netTotalLiabilities: 0n }
              : { unitaryValue: 0n, netTotalValue: 0n, netTotalLiabilities: 0n },
          };
        }
        if (i === 1) {
          return {
            status: "success",
            result: state
              ? { name: "Test", symbol: "TEST", decimals: state.decimals, owner: vault, baseToken: state.baseToken }
              : { name: "", symbol: "", decimals: 18, owner: vault, baseToken: "0x0000000000000000000000000000000000000000" },
          };
        }
        if (i === 2) {
          return { status: "success", result: 0n };
        }
        const bal = balances[chainId]?.[(c.address as string).toLowerCase()] ?? 0n;
        return { status: "success", result: bal };
      });
    }),
  })),
}));

vi.mock("../src/services/oraclePrice.js", () => ({
  convertTokenAmountViaOracle: mockConvertTokenAmountViaOracle,
}));

vi.mock("../src/services/delegation.js", () => ({
  getDelegationConfig: mockGetDelegationConfig,
  getActiveChains: mockGetActiveChains,
}));

const { buildRebalancePlan } = await import("../src/services/crosschain.js");

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const zeroAddr = "0x0000000000000000000000000000000000000000" as Address;
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARB_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const ARB_WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

function makeKV(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

describe("buildRebalancePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(balances)) delete balances[Number(k)];
    mockGetDelegationConfig.mockResolvedValue(null);
    mockGetActiveChains.mockReturnValue([]);
    mockGetVaultTokenBalance.mockResolvedValue({ balance: 0n, decimals: 18, symbol: "WETH" });
    // Default oracle: 1 base unit (18 dec) = 2600 USDC (6 dec). Chain 137 (POL)
    // prices at $4 — creating raw-total vs USDC-value divergence.
    mockConvertTokenAmountViaOracle.mockImplementation(
      async (chainId: number, _token: Address, amount: bigint) => {
        const rate = chainId === 137 ? 4n : 2600n;
        return (amount * rate) / 1_000_000_000_000n;
      },
    );
    // Fee estimation hits the Across API — stay offline, the plan catches it.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("auto-targets the chain with the largest USDC value, not the largest raw base-token total", async () => {
    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 42161) {
        // 10 ETH ≈ $26,000
        return { unitaryValue: 1_000000000000000000n, netTotalValue: 10_000000000000000000n, decimals: 18, baseToken: zeroAddr };
      }
      if (chainId === 137) {
        // 50 POL ≈ $200 — but 50e18 raw outweighs 10e18 raw
        return { unitaryValue: 1_000000000000000000n, netTotalValue: 50_000000000000000000n, decimals: 18, baseToken: zeroAddr };
      }
      return null;
    });

    const plan = await buildRebalancePlan({ vaultAddress: VAULT, kv: makeKV() });
    expect(plan.targetChainId).toBe(42161);
    expect(plan.summary).toMatch(/auto-selected/);
  });

  it("skips dust balances instead of emitting fee-wasting bridge operations", async () => {
    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 42161) {
        // 1,000 ETH total vault value; 100 USDC is 10% of it — under the 50% cap
        return { unitaryValue: 1_000000000000000000n, netTotalValue: 1000_000000000000000000n, decimals: 18, baseToken: zeroAddr };
      }
      if (chainId === 8453) {
        return { unitaryValue: 1_000000000000000000n, netTotalValue: 1_000000000000000000n, decimals: 18, baseToken: zeroAddr };
      }
      return null;
    });
    balances[42161] = {
      [ARB_USDC.toLowerCase()]: 100_000000n,   // $100 — kept
      [ARB_USDT.toLowerCase()]: 1_000000n,     // $1 — dust
      [ARB_WETH.toLowerCase()]: 1_000000000000000n, // 0.001 WETH ≈ $1 at floor — dust
    };

    const plan = await buildRebalancePlan({
      vaultAddress: VAULT,
      targetChainId: 8453,
      kv: makeKV(),
    });

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].tokenType).toBe("USDC");
    expect(plan.operations[0].amount).toBe("100");
    // No source chain is left with only dust ops.
    expect(plan.operations.some((o) => o.srcChainId === 999)).toBe(false);
  });
});
