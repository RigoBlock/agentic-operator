/**
 * prepareTransaction tests — focused on gas estimation when the NAV shield
 * is disabled or unverified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const mockGetRpcProvider = vi.hoisted(() => vi.fn());
const mockEstimateGas = vi.hoisted(() => vi.fn());
const mockEstimateFeesPerGas = vi.hoisted(() => vi.fn());

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockGetRpcProvider,
}));

vi.mock("../src/services/delegation.js", () => ({
  getDelegationConfig: vi.fn(),
  getChainDelegation: vi.fn(),
  saveDelegationConfig: vi.fn(),
  getAgentDelegatedSelectors: vi.fn(),
  getDelegableSelectors: vi.fn(async () => ["0x12345678"]),
}));

vi.mock("../src/services/agentWallet.js", () => ({
  createAgentWallet: vi.fn(),
  markChainDelegated: vi.fn(),
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

  it("uses the agent wallet for an Arbitrum tool tx even when the UI chain is HyperEVM (999)", async () => {
    // Reported regression: wallet had HyperEVM selected, tool targeted Arbitrum
    // where delegation is active — the executor must follow the TRANSACTION's
    // chain, never the UI/wallet chain.
    const { getChainDelegation, getDelegationConfig } = await import("../src/services/delegation.js");
    vi.mocked(getChainDelegation).mockResolvedValue({
      confirmedAt: 1, delegatedSelectors: ["0x12345678"],
    } as never);
    vi.mocked(getDelegationConfig).mockResolvedValue({
      enabled: true, agentAddress: AGENT,
    } as never);

    const result = await prepareTransaction(
      { KV: makeKV("0") } as any,
      { ...delegatedCtx, chainId: HYPER_EVM }, // UI active chain: HyperEVM
      { ...draft, chainId: 42161, description: "GMX order" }, // tool tx on Arbitrum
    );

    expect(result.tx.from).toBe(AGENT);
    expect(mockEstimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ account: AGENT }),
    );
  });

  it("recovers agent execution from on-chain delegation when KV misses the tx chain", async () => {
    // KV desync (empty/stale KV, chain delegated outside this UI): KV has no
    // record, but on-chain delegation is active — must NOT fall back to the
    // operator/MetaMask path.
    const { getChainDelegation, getDelegationConfig, getAgentDelegatedSelectors, saveDelegationConfig } =
      await import("../src/services/delegation.js");
    const { createAgentWallet, markChainDelegated } = await import("../src/services/agentWallet.js");
    vi.mocked(getChainDelegation).mockResolvedValue(null);
    vi.mocked(getDelegationConfig).mockResolvedValue({
      enabled: true, agentAddress: AGENT, operatorAddress: OPERATOR, chains: {},
    } as never);
    // On-chain: the agent holds the (only) delegable selector for this chain.
    vi.mocked(getAgentDelegatedSelectors).mockResolvedValue(["0x12345678"] as never);

    const result = await prepareTransaction({ KV: makeKV("0") } as any, delegatedCtx, draft);

    expect(result.tx.from).toBe(AGENT);
    // KV heal: config merged + chain marked so /api/delegation/execute and the
    // UI's mode detection take the fast path next time.
    expect(saveDelegationConfig).toHaveBeenCalled();
    expect(markChainDelegated).toHaveBeenCalledWith(expect.anything(), VAULT, HYPER_EVM);
    expect(createAgentWallet).not.toHaveBeenCalled(); // agent known from config
  });

  it("does not recover when on-chain delegation is absent for the tx chain", async () => {
    const { getChainDelegation, getDelegationConfig, getAgentDelegatedSelectors } =
      await import("../src/services/delegation.js");
    vi.mocked(getChainDelegation).mockResolvedValue(null);
    vi.mocked(getDelegationConfig).mockResolvedValue({
      enabled: true, agentAddress: AGENT, operatorAddress: OPERATOR, chains: {},
    } as never);
    vi.mocked(getAgentDelegatedSelectors).mockResolvedValue([] as never);

    const result = await prepareTransaction({ KV: makeKV("0") } as any, delegatedCtx, draft);

    expect(result.tx.from).toBe(OPERATOR);
  });

  it("does not recover when the operator disabled delegation in KV", async () => {
    const { getChainDelegation, getDelegationConfig, getAgentDelegatedSelectors } =
      await import("../src/services/delegation.js");
    vi.mocked(getChainDelegation).mockResolvedValue(null);
    vi.mocked(getDelegationConfig).mockResolvedValue({
      enabled: false, agentAddress: AGENT,
    } as never);

    const result = await prepareTransaction({ KV: makeKV("0") } as any, delegatedCtx, draft);

    expect(result.tx.from).toBe(OPERATOR);
    expect(getAgentDelegatedSelectors).not.toHaveBeenCalled();
  });
});


describe("prepareTransaction NAV-shield sender selection (auth security)", () => {
  const OWNER = "0x9999999999999999999999999999999999999999" as Address;
  const UPDATE_SELECTOR = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "updateUnitaryValue",
  }).slice(0, 10);
  const MULTICALL_SELECTOR = "0xac9650d8"; // multicall(bytes[])

  let mockCall: ReturnType<typeof vi.fn>;

  const draft = {
    to: VAULT,
    data: "0x12345678" as Hex,
    value: "0x0" as Hex,
    chainId: CHAIN_ID,
    description: "Swap",
  };

  function encodeNavReturn(unitaryValue: bigint): Hex {
    return encodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      result: [unitaryValue, unitaryValue * 1000n, 0n] as any,
    });
  }

  function encodeMulticallReturn(postUnitaryValue: bigint): Hex {
    return encodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "multicall",
      result: ["0x", encodeNavReturn(postUnitaryValue)] as any,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEstimateGas.mockResolvedValue(100_000n);
    mockEstimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    });
    // On-chain reality: the vault has supply and is owned by OWNER (≠ OPERATOR).
    mockReadContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "totalSupply") return 1n;
      if (args.functionName === "owner") return OWNER;
      return 0n;
    });
    mockCall = vi.fn(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(10000n) };
      if (selector === MULTICALL_SELECTOR) return { data: encodeMulticallReturn(9900n) };
      throw new Error(`unexpected eth_call: ${selector}`);
    });
    mockGetRpcProvider.mockReturnValue({ ...makePublicClient(), call: mockCall });
  });

  it("uses the verified operator as the NAV simulation sender without an on-chain owner read", async () => {
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
    expect(result.tx.navShieldChecked).toBe(true);
    const ownerReads = mockReadContract.mock.calls.filter(
      (c) => (c[0] as { functionName: string }).functionName === "owner",
    );
    expect(ownerReads).toHaveLength(0);
    const accounts = mockCall.mock.calls.map(
      (c) => (c[0] as { account: string }).account.toLowerCase(),
    );
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((a) => a === OPERATOR.toLowerCase())).toBe(true);
  });

  it("unverified caller cannot steer the NAV simulation with a spoofed operatorAddress", async () => {
    // x402 Tier-1 path (routes/tools.ts): operatorAddress comes from the request
    // body with operatorVerified=false. The NAV shield must simulate from the
    // ON-CHAIN owner, never from the caller-supplied address — a spoofed
    // operatorAddress must not influence `from` of the simulation.
    const result = await prepareTransaction(
      { KV: makeKV(null) } as any,
      {
        vaultAddress: VAULT,
        chainId: CHAIN_ID,
        operatorAddress: OPERATOR, // caller-supplied, unverified (≠ on-chain OWNER)
        operatorVerified: false,
        executionMode: "manual",
      },
      draft,
    );

    // Manual-mode `from` is informational on the unsigned tx — the signer decides.
    expect(result.tx.from).toBe(OPERATOR);
    expect(mockReadContract.mock.calls.some(
      (c) => (c[0] as { functionName: string }).functionName === "owner",
    )).toBe(true);
    const accounts = mockCall.mock.calls.map(
      (c) => (c[0] as { account: string }).account.toLowerCase(),
    );
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((a) => a === OWNER.toLowerCase())).toBe(true);
    expect(accounts).not.toContain(OPERATOR.toLowerCase());
  });
});
