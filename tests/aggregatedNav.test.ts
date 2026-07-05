/**
 * Aggregated NAV tests.
 *
 * Verifies that getAggregatedNav computes global NAV from the same on-chain
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

function makeKV(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

describe("getAggregatedNav global NAV", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDelegationConfig.mockResolvedValue(null);
    mockGetActiveChains.mockReturnValue([]);
    mockGetVaultTokenBalance.mockResolvedValue({ balance: 0n, decimals: 18, symbol: "WETH" });
    mockGetClient.mockReturnValue({
      readContract: vi.fn().mockResolvedValue(0n),
    });
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

    // Global unitary USDC = total assets / total effective supply (in token units)
    // total supply = 33 + 0.5 = 33.5 tokens => 218400 / 33.5 ≈ 6,519.40 USDC
    expect(parseFloat(nav.globalNav.unitaryUsdc)).toBeCloseTo(6519.4, 1);

    // Per-chain values
    expect(parseFloat(nav.globalNav.chainUsdc[1].totalUsdc)).toBeCloseTo(214500, 0);
    expect(parseFloat(nav.globalNav.chainUsdc[42161].totalUsdc)).toBeCloseTo(3900, 0);

    // Ethereum unitary USDC = 214500 / 33 = 6,500
    expect(parseFloat(nav.globalNav.chainUsdc[1].unitaryUsdc)).toBeCloseTo(6500, 1);
    // Arbitrum unitary USDC = 3900 / 0.5 = 7,800
    expect(parseFloat(nav.globalNav.chainUsdc[42161].unitaryUsdc)).toBeCloseTo(7800, 1);
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
