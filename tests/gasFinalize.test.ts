/**
 * finalizeTransaction tests — focused on gas estimation when the NAV shield
 * is disabled or unverified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, Hex } from "viem";

const mockGetRpcProvider = vi.hoisted(() => vi.fn());
const mockEstimateGas = vi.hoisted(() => vi.fn());
const mockEstimateFeesPerGas = vi.hoisted(() => vi.fn());
const mockReadContract = vi.hoisted(() => vi.fn());

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

vi.mock("../src/services/delegation.js", () => ({
  getDelegationConfig: vi.fn(),
  getChainDelegation: vi.fn(),
}));

const { finalizeTransaction } = await import("../src/services/gas.js");

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" as Address;
const CHAIN_ID = 8453;

function makeKV(navShieldValue: string | null): KVNamespace {
  const store = new Map<string, string>();
  if (navShieldValue !== null) {
    store.set(`nav-shield-pct:${OPERATOR.toLowerCase()}`, navShieldValue);
  }
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makePublicClient() {
  return {
    chain: { id: CHAIN_ID, name: "Base" },
    estimateGas: mockEstimateGas,
    estimateFeesPerGas: mockEstimateFeesPerGas,
    readContract: mockReadContract,
  };
}

describe("finalizeTransaction with NAV shield disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEstimateGas.mockResolvedValue(100_000n);
    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    });
    mockReadContract.mockResolvedValue(0n);
    mockGetRpcProvider.mockReturnValue(makePublicClient());
  });

  it("estimates gas and fees and emits no warning when the NAV shield is disabled", async () => {
    const draft = {
      to: VAULT,
      data: "0x12345678" as Hex,
      value: "0x0" as Hex,
      chainId: CHAIN_ID,
      description: "Oracle refresh",
    };

    const result = await finalizeTransaction(
      { KV: makeKV("0") } as any,
      {
        vaultAddress: VAULT,
        chainId: CHAIN_ID,
        operatorAddress: OPERATOR,
        operatorVerified: true,
        executionMode: "manual",
      },
      draft,
    );

    expect(result.tx.gas).not.toBe("0x0");
    expect(result.tx.maxFeePerGas).not.toBe("0x0");
    expect(result.tx.maxPriorityFeePerGas).not.toBe("0x0");
    expect(result.warning).toBeUndefined();
    expect(result.tx.navShieldChecked).toBe(true);
    expect(mockEstimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ account: OPERATOR, to: VAULT, data: draft.data, value: 0n }),
    );
  });

  it("still estimates gas and keeps a warning when NAV impact is unverified", async () => {
    const draft = {
      to: VAULT,
      data: "0x12345678" as Hex,
      value: "0x0" as Hex,
      chainId: CHAIN_ID,
      description: "First deposit",
    };

    const result = await finalizeTransaction(
      { KV: makeKV(null) } as any,
      {
        vaultAddress: VAULT,
        chainId: CHAIN_ID,
        operatorAddress: OPERATOR,
        operatorVerified: true,
        executionMode: "manual",
      },
      draft,
    );

    expect(result.tx.gas).not.toBe("0x0");
    expect(result.tx.maxFeePerGas).not.toBe("0x0");
    expect(result.tx.maxPriorityFeePerGas).not.toBe("0x0");
    expect(result.warning).toContain("NAV verification unavailable");
    expect(result.tx.navShieldChecked).toBe(true);
  });
});
