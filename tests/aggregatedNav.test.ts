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
const mockGetDelegationConfig = vi.hoisted(() => vi.fn());
const mockGetActiveChains = vi.hoisted(() => vi.fn());

vi.mock("../src/services/vault.js", () => ({
  getEffectivePoolState: mockGetEffectivePoolState,
  getVaultTokenBalance: mockGetVaultTokenBalance,
  getClient: mockGetClient,
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

function mockFetchWithEthPrice(ethUsd = 2600) {
  return vi.fn(async (url: string) => {
    if (url.includes("coingecko")) {
      return {
        ok: true,
        json: async () => ({ ethereum: { usd: ethUsd } }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes total NAV from netTotalValue (not bridgeable token balances)", async () => {
    vi.stubGlobal("fetch", mockFetchWithEthPrice(2600));

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

    // Total assets USD = (82.5 + 1.5) ETH * $2,600 = $218,400
    expect(parseFloat(nav.globalNav.totalUsd)).toBeCloseTo(218400, 0);

    // Global unitary USD = total assets / total effective supply (in token units)
    // total supply = 33 + 0.5 = 33.5 tokens => 218400 / 33.5 ≈ $6,519.40
    expect(parseFloat(nav.globalNav.unitaryUsd)).toBeCloseTo(6519.4, 1);

    // Per-chain values
    expect(parseFloat(nav.globalNav.chainUsd[1].totalUsd)).toBeCloseTo(214500, 0);
    expect(parseFloat(nav.globalNav.chainUsd[42161].totalUsd)).toBeCloseTo(3900, 0);

    // Ethereum unitary USD = 214500 / 33 = $6,500
    expect(parseFloat(nav.globalNav.chainUsd[1].unitaryUsd)).toBeCloseTo(6500, 1);
    // Arbitrum unitary USD = 3900 / 0.5 = $7,800
    expect(parseFloat(nav.globalNav.chainUsd[42161].unitaryUsd)).toBeCloseTo(7800, 1);
  });

  it("throws when CoinGecko USD price is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 } as Response)));

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

    await expect(getAggregatedNav(VAULT, ALCHEMY_KEY, makeKV())).rejects.toThrow(/CoinGecko/);
  });
});
