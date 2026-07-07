/**
 * Aggregated assets tests.
 *
 * Verifies that getAggregatedNav computes global assets from the same on-chain
 * values used by the NAV sync tool (netTotalValue + effectiveSupply), not from
 * bridgeable token balances.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Address } from "viem";

const mockGetEffectivePoolState = vi.hoisted(() => vi.fn());
const mockGetVaultTokenBalance = vi.hoisted(() => vi.fn());
const mockGetClient = vi.hoisted(() => vi.fn());
const mockConvertTokenAmountViaOracle = vi.hoisted(() => vi.fn());
const mockGetDelegationConfig = vi.hoisted(() => vi.fn());
const mockGetActiveChains = vi.hoisted(() => vi.fn());

vi.mock("../src/services/vault.js", () => ({
  getEffectivePoolState: mockGetEffectivePoolState,
  getVaultTokenBalance: mockGetVaultTokenBalance,
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getClient: mockGetClient,
}));

vi.mock("../src/services/oraclePrice.js", () => ({
  convertTokenAmountViaOracle: mockConvertTokenAmountViaOracle,
}));

vi.mock("../src/services/delegation.js", () => ({
  getDelegationConfig: mockGetDelegationConfig,
  getActiveChains: mockGetActiveChains,
}));

const { getAggregatedNav } = await import("../src/services/crosschain.js");

const VAULT = "0xEfa4bDf566aE50537A507863612638680420645C" as Address;
const ALCHEMY_KEY = "test-key";
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

describe("getAggregatedNav global assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDelegationConfig.mockResolvedValue(null);
    mockGetActiveChains.mockReturnValue([]);
    mockGetVaultTokenBalance.mockResolvedValue({ balance: 0n, decimals: 18, symbol: "WETH" });
    mockGetClient.mockImplementation((chainId: number) => ({
      readContract: vi.fn().mockResolvedValue(0n),
      multicall: vi.fn(async ({ contracts }: { contracts: any[] }) => {
        const state = await mockGetEffectivePoolState(chainId, VAULT, ALCHEMY_KEY);
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
          return { status: "success", result: 0n };
        });
      }),
    }));
    // Default oracle conversion: 1 ETH = 2600 USDC (6 decimals).
    // Input is in base-token decimals (18 for ETH); output must be in USDC decimals (6).
    mockConvertTokenAmountViaOracle.mockImplementation(async (_chainId, _token, amount) => {
      return amount * 2600n / 1_000_000_000_000n;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes total NAV from netTotalValue (not bridgeable token balances)", async () => {
    // Ethereum: 33 effective supply, unitary 2.5 ETH, total value 82.5 ETH
    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 1) {
        return {
          unitaryValue: 2500000000000000000n,
          netTotalValue: 82500000000000000000n,
          effectiveSupply: 33000000000000000000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      if (chainId === 42161) {
        return {
          unitaryValue: 3500000000000000000n,
          netTotalValue: 1500000000000000000n,
          effectiveSupply: 500000000000000000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      return null;
    });

    const nav = await getAggregatedNav(VAULT, ALCHEMY_KEY, makeKV());

    // Total assets USDC = (82.5 + 1.5) ETH * 2,600 = 218,400 USDC
    expect(parseFloat(nav.globalNav.totalUsdc)).toBeCloseTo(218400, 0);

    // Global unit-less target price = total USDC / total USDC value of supplies.
    // Chain 1 supply value = 214500 / 2.5 = 85800 USDC.
    // Chain 42161 supply value = 3900 / 3.5 = 1114.2857 USDC.
    // Total supply value = 86914.2857 USDC.
    // Global target = 218400 / 86914.2857 ≈ 2.51282
    expect(parseFloat(nav.globalNav.totalSupplyValueUsdc)).toBeCloseTo(86914.29, 2);
    expect(parseFloat(nav.globalNav.targetPrice)).toBeCloseTo(2.51282, 4);
  });

  it("throws when oracle cannot price the base token", async () => {
    mockConvertTokenAmountViaOracle.mockRejectedValue(new Error("No oracle feed"));

    mockGetEffectivePoolState.mockImplementation(async (chainId: number) => {
      if (chainId === 1) {
        return {
          unitaryValue: 2500000000000000000n,
          netTotalValue: 10000000000000000000n,
          effectiveSupply: 4000000000000000000n,
          decimals: 18,
          baseToken: "0x0000000000000000000000000000000000000000" as Address,
        };
      }
      return null;
    });

    await expect(getAggregatedNav(VAULT, ALCHEMY_KEY, makeKV())).rejects.toThrow(/Oracle/);
  });
});
