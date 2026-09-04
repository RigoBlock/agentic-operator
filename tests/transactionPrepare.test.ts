/**
 * prepareTransaction tests — focused on gas estimation when the NAV shield
 * is disabled or unverified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address, Hex } from "viem";

const mockGetRpcProvider = vi.hoisted(() => vi.fn());
const mockEstimateGas = vi.hoisted(() => vi.fn());
const mockEstimateFeesPerGas = vi.hoisted(() => vi.fn());

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

vi.mock("../src/services/delegation.js", () => ({
  getDelegationConfig: vi.fn(),
  getChainDelegation: vi.fn(),
}));

const { prepareTransaction } = await import("../src/services/transactionPrepare.js");

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

const mockReadContract = vi.hoisted(() => vi.fn());

function makePublicClient() {
  return {
    chain: { id: CHAIN_ID, name: "Base" },
    estimateGas: mockEstimateGas,
    estimateFeesPerGas: mockEstimateFeesPerGas,
    readContract: mockReadContract,
  };
}

describe("prepareTransaction with NAV shield disabled", () => {
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

    const result = await prepareTransaction(
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

    expect(result.tx.from).toBe(OPERATOR);
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

    const result = await prepareTransaction(
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

    expect(result.tx.from).toBe(OPERATOR);
    expect(result.tx.gas).not.toBe("0x0");
    expect(result.tx.maxFeePerGas).not.toBe("0x0");
    expect(result.tx.maxPriorityFeePerGas).not.toBe("0x0");
    expect(result.warning).toContain("NAV verification unavailable");
    expect(result.tx.navShieldChecked).toBe(true);
  });
});

describe("prepareTransaction delegated executor selection (per-chain)", () => {
  const AGENT = "0x3333333333333333333333333333333333333333" as Address;
  const HYPER_EVM = 999;

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

  const draft = {
    to: VAULT,
    data: "0x12345678" as Hex,
    value: "0x0" as Hex,
    chainId: HYPER_EVM,
    description: "Hyperliquid deposit",
  };
  const delegatedCtx = {
    vaultAddress: VAULT,
    chainId: 1, // UI active chain — differs from the tx chain
    operatorAddress: OPERATOR,
    operatorVerified: true,
    executionMode: "delegated" as const,
  };

  it("uses the agent wallet when delegation is active on the transaction's chain", async () => {
    const { getChainDelegation, getDelegationConfig } = await import("../src/services/delegation.js");
    vi.mocked(getChainDelegation).mockResolvedValue({
      confirmedAt: 1, delegatedSelectors: ["0x12345678"],
    } as never);
    vi.mocked(getDelegationConfig).mockResolvedValue({
      enabled: true, agentAddress: AGENT,
    } as never);

    const result = await prepareTransaction({ KV: makeKV("0") } as any, delegatedCtx, draft);

    expect(result.tx.from).toBe(AGENT);
    expect(mockEstimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ account: AGENT }),
    );
  });

  it("falls back to the operator signer when delegation is NOT active on the tx chain", async () => {
    const { getChainDelegation } = await import("../src/services/delegation.js");
    vi.mocked(getChainDelegation).mockResolvedValue(null);

    const result = await prepareTransaction({ KV: makeKV("0") } as any, delegatedCtx, draft);

    expect(result.tx.from).toBe(OPERATOR);
    expect(mockEstimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ account: OPERATOR }),
    );
  });

  it("throws a clear error when delegation is inactive on the tx chain and no operator is available", async () => {
    const { getChainDelegation } = await import("../src/services/delegation.js");
    vi.mocked(getChainDelegation).mockResolvedValue(null);

    await expect(
      prepareTransaction({ KV: makeKV("0") } as any, { ...delegatedCtx, operatorAddress: undefined }, draft),
    ).rejects.toMatchObject({ code: "DELEGATION_NOT_ACTIVE_ON_CHAIN" });
  });
});
