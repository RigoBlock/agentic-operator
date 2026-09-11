/**
 * Delegation tests — selector map, default selectors, selective revocation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALLOWED_VAULT_SELECTORS, VAULT_DELEGATION_ABI } from "../src/abi/rigoblockVault.js";
import {
  getDelegableSelectors,
  prepareDelegation,
  confirmDelegation,
  revokeDelegation,
  revokeDelegationOnChain,
  getDelegationConfig,
  prepareSelectiveRevocation,
  isDelegationActive,
  getActiveChains,
  getChainDelegatee,
  selectChainExecutor,
} from "../src/services/delegation.js";
import { getRpcProvider } from "../src/services/rpcClient.js";
import { decodeAbiParameters, decodeFunctionData, type Hex } from "viem";

// ── Mock KV Namespace ─────────────────────────────────────────────────

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

// ── Mock agentWallet service ──────────────────────────────────────────
// prepareDelegation calls createAgentWallet. We mock it to avoid real CDP calls.
// NOTE: vi.mock factories are hoisted — cannot reference module-level variables.
// Use a literal address here and match it in tests.

const MOCK_AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

vi.mock("../src/services/agentWallet.js", () => ({
  createAgentWallet: vi.fn().mockResolvedValue({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  getAgentWalletInfo: vi.fn().mockResolvedValue({ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  markChainDelegated: vi.fn().mockResolvedValue(undefined),
  unmarkChainDelegated: vi.fn().mockResolvedValue(undefined),
  deleteAgentWallet: vi.fn().mockResolvedValue(undefined),
}));

// getDelegableSelectors reads the chain's Authority via getRpcProvider — mock it.
vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: vi.fn(),
}));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADAPTER_ADDRESS = "0x00000000000000000000000000000000000000Aa";

/** Mock the Authority multicall: map selector (lowercase) → adapter address; unlisted selectors get `defaultAddress`. */
function mockAuthorityMappings(map: Record<string, string>, defaultAddress: string = ADAPTER_ADDRESS) {
  (getRpcProvider as ReturnType<typeof vi.fn>).mockReturnValue({
    multicall: async ({ contracts }: { contracts: { args: unknown[] }[] }) =>
      contracts.map((c) => ({
        status: "success" as const,
        result: map[(c.args[0] as string).toLowerCase()] ?? defaultAddress,
      })),
  });
}

const ALL_SELECTORS = Object.values(ALLOWED_VAULT_SELECTORS) as Hex[];

beforeEach(() => {
  // Default: Authority maps every whitelisted selector (e.g. Arbitrum today).
  mockAuthorityMappings({});
});

const AGENT_ADDRESS = MOCK_AGENT as `0x${string}`;

const VAULT = "0xd14d4321a33F7eD001Ba5B60cE54b0F7Ba621247" as `0x${string}`;
const OPERATOR = "0xOperator0000000000000000000000000000000000" as `0x${string}`;
const CHAIN_ID = 42161;

function makeEnv(kv: KVNamespace): any {
  return { KV: kv, CDP_WALLET_SECRET: "test-secret", CDP_API_KEY_ID: "test-id", CDP_API_KEY_SECRET: "test-key-secret" };
}

describe("ALLOWED_VAULT_SELECTORS", () => {
  it("contains all expected categories", () => {
    // Uniswap
    expect(ALLOWED_VAULT_SELECTORS.executeWithDeadline).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.execute).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.modifyLiquidities).toBeDefined();

    // 0x
    expect(ALLOWED_VAULT_SELECTORS.zeroXExecute).toBeDefined();

    // GMX v2
    expect(ALLOWED_VAULT_SELECTORS.cancelOrder).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.claimCollateral).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.claimFundingFees).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.createDecreaseOrder).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.createIncreaseOrder).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.updateOrder).toBeDefined();

    // Cross-chain (Across)
    expect(ALLOWED_VAULT_SELECTORS.depositV3).toBeDefined();

    // GRG Staking
    expect(ALLOWED_VAULT_SELECTORS.stake).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.undelegateStake).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.unstake).toBeDefined();
    expect(ALLOWED_VAULT_SELECTORS.withdrawDelegatorRewards).toBeDefined();
  });

  it("all selectors are 4-byte hex strings (0x + 8 hex chars)", () => {
    for (const [name, selector] of Object.entries(ALLOWED_VAULT_SELECTORS)) {
      expect(selector, `Selector for ${name}`).toMatch(/^0x[a-fA-F0-9]{8}$/);
    }
  });

  it("has no duplicate selectors", () => {
    const values = Object.values(ALLOWED_VAULT_SELECTORS);
    const lowerValues = values.map((v) => v.toLowerCase());
    const unique = new Set(lowerValues);
    expect(unique.size).toBe(values.length);
  });

  it("has the correct GRG staking selectors from AStaking.sol interface", () => {
    // These were computed from the AStaking.sol function signatures
    expect(ALLOWED_VAULT_SELECTORS.stake).toBe("0xa694fc3a");           // stake(uint256)
    expect(ALLOWED_VAULT_SELECTORS.undelegateStake).toBe("0x4aace835"); // undelegateStake(uint256)
    expect(ALLOWED_VAULT_SELECTORS.unstake).toBe("0x2e17de78");         // unstake(uint256)
    expect(ALLOWED_VAULT_SELECTORS.withdrawDelegatorRewards).toBe("0xb880660b"); // withdrawDelegatorRewards()
  });

  it("does NOT include endEpoch (which is on the staking proxy, not the vault)", () => {
    const allKeys = Object.keys(ALLOWED_VAULT_SELECTORS);
    expect(allKeys).not.toContain("endEpoch");

    // Also verify the endEpoch selector itself isn't present under any name
    const values = Object.values(ALLOWED_VAULT_SELECTORS).map((v) => v.toLowerCase());
    expect(values).not.toContain("0x0b9663db"); // endEpoch()
  });

  it("does NOT include withdraw or transferOwnership (critical security)", () => {
    const allKeys = Object.keys(ALLOWED_VAULT_SELECTORS);
    expect(allKeys).not.toContain("withdraw");
    expect(allKeys).not.toContain("transferOwnership");
    expect(allKeys).not.toContain("setOwner");
    expect(allKeys).not.toContain("transfer");
  });
});

describe("getDelegableSelectors", () => {
  it("returns all whitelisted selectors when the Authority maps all of them", async () => {
    mockAuthorityMappings({});
    const selectors = await getDelegableSelectors(42161);
    const all = Object.values(ALLOWED_VAULT_SELECTORS);
    expect(selectors).toHaveLength(all.length);
    for (const selector of all) {
      expect(selectors).toContain(selector);
      expect(selectors.every((s) => all.includes(s))).toBe(true);
    }
  });

  it("excludes selectors the Authority does not map on that chain", async () => {
    // HyperEVM reality: only AHyperliquid and AIntents selectors are mapped AND
    // whitelisted. The AMulticall selectors are mapped on-chain (kept in the mock
    // on purpose) but are NOT in the delegation whitelist — the NAV shield
    // simulates multicall from the vault owner, so they must be excluded too.
    mockAuthorityMappings({
      [ALLOWED_VAULT_SELECTORS.hlDeposit.toLowerCase()]: ADAPTER_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.hlDepositFor.toLowerCase()]: ADAPTER_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.hlSendRawAction.toLowerCase()]: ADAPTER_ADDRESS,
      "0xac9650d8": ADAPTER_ADDRESS, // multicall(bytes[]) — mapped on-chain, never delegated
      "0x5ae401dc": ADAPTER_ADDRESS, // multicall(uint256,bytes[]) — mapped on-chain, never delegated
      "0x1f0464d1": ADAPTER_ADDRESS, // multicall(bytes32,bytes[]) — mapped on-chain, never delegated
      [ALLOWED_VAULT_SELECTORS.depositV3.toLowerCase()]: ADAPTER_ADDRESS,
    }, ZERO_ADDRESS);
    const selectors = await getDelegableSelectors(999);
    expect(selectors).toHaveLength(4);
    expect(selectors).toContain(ALLOWED_VAULT_SELECTORS.hlDeposit);
    expect(selectors).toContain(ALLOWED_VAULT_SELECTORS.hlSendRawAction);
    // GMX, Uniswap v4, 0x, wrap, staking selectors are NOT mapped on HyperEVM — never delegate them.
    expect(selectors).not.toContain(ALLOWED_VAULT_SELECTORS.createIncreaseOrder);
    expect(selectors).not.toContain(ALLOWED_VAULT_SELECTORS.execute);
    expect(selectors).not.toContain(ALLOWED_VAULT_SELECTORS.zeroXExecute);
    expect(selectors).not.toContain(ALLOWED_VAULT_SELECTORS.wrapETH);
    expect(selectors).not.toContain(ALLOWED_VAULT_SELECTORS.stake);
    // Mapped on-chain but not whitelisted — never delegate them either.
    const lower = selectors.map((s) => s.toLowerCase());
    expect(lower).not.toContain("0xac9650d8");
    expect(lower).not.toContain("0x5ae401dc");
    expect(lower).not.toContain("0x1f0464d1");
  });

  it("throws (fails closed) when the Authority cannot be read", async () => {
    (getRpcProvider as ReturnType<typeof vi.fn>).mockReturnValue({
      multicall: async () => [{ status: "failure", error: new Error("rpc down") }],
    });
    await expect(getDelegableSelectors(1)).rejects.toThrow(/Failed to resolve adapter mapping/);
  });
});

describe("VAULT_DELEGATION_ABI", () => {
  it("includes updateDelegation function", () => {
    const fn = VAULT_DELEGATION_ABI.find(
      (entry) => "name" in entry && entry.name === "updateDelegation",
    );
    expect(fn).toBeDefined();
  });

  it("includes revokeAllDelegations function", () => {
    const fn = VAULT_DELEGATION_ABI.find(
      (entry) => "name" in entry && entry.name === "revokeAllDelegations",
    );
    expect(fn).toBeDefined();
  });

  it("includes getDelegatedSelectors view", () => {
    const fn = VAULT_DELEGATION_ABI.find(
      (entry) => "name" in entry && entry.name === "getDelegatedSelectors",
    );
    expect(fn).toBeDefined();
  });
});

// ── Service-level tests ───────────────────────────────────────────────

describe("prepareDelegation", () => {
  it("returns an unsigned updateDelegation tx targeting the vault", async () => {
    const kv = makeKV();
    const result = await prepareDelegation(makeEnv(kv), OPERATOR, VAULT, CHAIN_ID);

    expect(result.agentAddress).toBe(AGENT_ADDRESS);
    expect(result.transaction.to).toBe(VAULT);
    expect(result.transaction.value).toBe("0x0");
    expect(result.transaction.chainId).toBe(CHAIN_ID);
    expect(result.transaction.data).toMatch(/^0x/);
  });

  it("calldata starts with the updateDelegation selector", async () => {
    const kv = makeKV();
    const result = await prepareDelegation(makeEnv(kv), OPERATOR, VAULT, CHAIN_ID);

    // updateDelegation((address,bytes4,bool)[]) — selector is first 4 bytes
    const selector = result.transaction.data.slice(0, 10);
    // Decode and verify it's calling updateDelegation
    const decoded = decodeFunctionData({
      abi: VAULT_DELEGATION_ABI,
      data: result.transaction.data as Hex,
    });
    expect(decoded.functionName).toBe("updateDelegation");
  });

  it("delegation array includes all in-scope selectors with isDelegated=true", async () => {
    // Arbitrum reality: every adapter selector is mapped except AHyperliquid's.
    mockAuthorityMappings({
      [ALLOWED_VAULT_SELECTORS.hlDeposit.toLowerCase()]: ZERO_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.hlDepositFor.toLowerCase()]: ZERO_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.hlSendRawAction.toLowerCase()]: ZERO_ADDRESS,
    });
    const kv = makeKV();
    const result = await prepareDelegation(makeEnv(kv), OPERATOR, VAULT, CHAIN_ID);

    const decoded = decodeFunctionData({
      abi: VAULT_DELEGATION_ABI,
      data: result.transaction.data as Hex,
    });

    const delegations = decoded.args[0] as readonly { delegated: string; selector: string; isDelegated: boolean }[];

    // Every entry must target the agent and have isDelegated=true
    for (const d of delegations) {
      expect(d.delegated.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
      expect(d.isDelegated).toBe(true);
    }

    // Mapped selectors (incl. GMX on Arbitrum) are present…
    const encodedSelectors = delegations.map(d => d.selector.toLowerCase());
    expect(encodedSelectors).toContain(ALLOWED_VAULT_SELECTORS.createIncreaseOrder.toLowerCase());
    expect(encodedSelectors).toHaveLength(ALL_SELECTORS.length - 3);
    // …and selectors without an adapter mapping on this chain are never granted.
    expect(encodedSelectors).not.toContain(ALLOWED_VAULT_SELECTORS.hlDeposit.toLowerCase());
    expect(encodedSelectors).not.toContain(ALLOWED_VAULT_SELECTORS.hlDepositFor.toLowerCase());
    expect(encodedSelectors).not.toContain(ALLOWED_VAULT_SELECTORS.hlSendRawAction.toLowerCase());
    // The AMulticall selectors are never granted either — the NAV shield simulates
    // multicall from the vault owner, so no multicall delegation exists.
    expect(encodedSelectors).not.toContain("0xac9650d8");
    expect(encodedSelectors).not.toContain("0x5ae401dc");
    expect(encodedSelectors).not.toContain("0x1f0464d1");
  });

  it("returns the full in-scope selector list from the Authority", async () => {
    mockAuthorityMappings({}); // everything mapped
    const kv = makeKV();
    const result = await prepareDelegation(makeEnv(kv), OPERATOR, VAULT, CHAIN_ID);
    const expected = await getDelegableSelectors(CHAIN_ID);
    expect(result.selectors).toHaveLength(expected.length);
    for (const s of expected) {
      expect(result.selectors.map(x => x.toLowerCase())).toContain(s.toLowerCase());
    }
  });
});

describe("confirmDelegation + getDelegationConfig", () => {
  it("saves config to KV and enables delegation for the chain", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    const txHash = "0xabcdef1234567890" as Hex;

    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, txHash);

    const config = await getDelegationConfig(kv, VAULT);
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.agentAddress.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    expect(config!.chains[String(CHAIN_ID)]).toBeDefined();
    expect(config!.chains[String(CHAIN_ID)].delegateTxHash).toBe(txHash);
    expect(config!.chains[String(CHAIN_ID)].delegatedSelectors).toHaveLength(selectors.length);
  });

  it("merges new chain without overwriting existing chains", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    const txHash1 = "0xchain1txhash" as Hex;
    const txHash2 = "0xchain2txhash" as Hex;

    // Setup on chain 1
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 1, selectors, txHash1);
    // Setup on chain 2
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 42161, selectors, txHash2);

    const config = await getDelegationConfig(kv, VAULT);
    expect(Object.keys(config!.chains)).toHaveLength(2);
    expect(config!.chains["1"].delegateTxHash).toBe(txHash1);
    expect(config!.chains["42161"].delegateTxHash).toBe(txHash2);
  });

  it("updating existing chain replaces its selector set (for new selectors)", async () => {
    const kv = makeKV();
    const originalSelectors = ALL_SELECTORS.slice(0, 5);
    const newSelectors = ALL_SELECTORS;

    // Initial delegation with partial selectors
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, originalSelectors, "0xhash1" as Hex);
    // Update delegation with all selectors
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, newSelectors, "0xhash2" as Hex);

    const config = await getDelegationConfig(kv, VAULT);
    // Latest selectors overwrite the chain entry
    expect(config!.chains[String(CHAIN_ID)].delegatedSelectors).toHaveLength(newSelectors.length);
    expect(config!.chains[String(CHAIN_ID)].delegateTxHash).toBe("0xhash2");
  });
});

describe("revokeDelegation (all chains)", () => {
  it("disables delegation and clears all chains", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;

    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtxhash" as Hex);
    await revokeDelegation(kv, VAULT);

    const config = await getDelegationConfig(kv, VAULT);
    expect(config!.enabled).toBe(false);
    expect(Object.keys(config!.chains)).toHaveLength(0);
  });

  it("is a no-op when no config exists", async () => {
    const kv = makeKV();
    // Should not throw
    await expect(revokeDelegation(kv, VAULT)).resolves.toBeUndefined();
  });
});

describe("revokeDelegationOnChain (single chain)", () => {
  it("removes the specified chain but keeps others", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;

    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 1, selectors, "0xtx1" as Hex);
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 42161, selectors, "0xtx2" as Hex);

    await revokeDelegationOnChain(kv, VAULT, 42161);

    const config = await getDelegationConfig(kv, VAULT);
    expect(config!.chains["42161"]).toBeUndefined();
    expect(config!.chains["1"]).toBeDefined();
    expect(config!.enabled).toBe(true); // still active on chain 1
  });

  it("disables delegation when the last chain is removed", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtxhash" as Hex);

    await revokeDelegationOnChain(kv, VAULT, CHAIN_ID);

    const config = await getDelegationConfig(kv, VAULT);
    expect(config!.enabled).toBe(false);
    expect(Object.keys(config!.chains)).toHaveLength(0);
  });
});

describe("isDelegationActive", () => {
  it("returns true when delegation is active on the given chain", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtx" as Hex);
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(true);
  });

  it("returns false when delegation is not configured", async () => {
    const kv = makeKV();
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(false);
  });

  it("returns false after global revocation", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtx" as Hex);
    await revokeDelegation(kv, VAULT);
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(false);
  });

  it("returns false after chain-specific revocation", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtx" as Hex);
    await revokeDelegationOnChain(kv, VAULT, CHAIN_ID);
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(false);
  });
});

describe("prepareSelectiveRevocation", () => {
  it("returns an unsigned updateDelegation tx with isDelegated=false for each selector", async () => {
    const kv = makeKV();
    const selectorsToRevoke = [
      ALLOWED_VAULT_SELECTORS.modifyLiquidities,
      ALLOWED_VAULT_SELECTORS.execute,
    ];

    const result = await prepareSelectiveRevocation(
      makeEnv(kv),
      VAULT,
      AGENT_ADDRESS,
      selectorsToRevoke,
      CHAIN_ID,
    );

    expect(result.transaction.to).toBe(VAULT);
    const decoded = decodeFunctionData({
      abi: VAULT_DELEGATION_ABI,
      data: result.transaction.data as Hex,
    });
    expect(decoded.functionName).toBe("updateDelegation");

    const delegations = decoded.args[0] as readonly { delegated: string; selector: string; isDelegated: boolean }[];
    expect(delegations).toHaveLength(selectorsToRevoke.length);
    for (const d of delegations) {
      expect(d.isDelegated).toBe(false);
      expect(d.delegated.toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    }
    const revokedSelectors = delegations.map(d => d.selector.toLowerCase());
    expect(revokedSelectors).toContain(ALLOWED_VAULT_SELECTORS.modifyLiquidities.toLowerCase());
    expect(revokedSelectors).toContain(ALLOWED_VAULT_SELECTORS.execute.toLowerCase());
  });
});

describe("prepareRevocation", () => {
  it("returns an unsigned revokeAllDelegations tx targeting the vault", async () => {
    const { prepareRevocation } = await import("../src/services/delegation.js");
    const kv = makeKV();

    const result = await prepareRevocation(makeEnv(kv), VAULT, CHAIN_ID);

    expect(result.transaction.to).toBe(VAULT);
    const decoded = decodeFunctionData({
      abi: VAULT_DELEGATION_ABI,
      data: result.transaction.data as Hex,
    });
    expect(decoded.functionName).toBe("revokeAllDelegations");
    // First arg is the agent address
    expect((decoded.args[0] as string).toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
  });
});

describe("getActiveChains", () => {
  it("returns chain IDs where delegation is active", async () => {
    const kv = makeKV();
    const selectors = ALL_SELECTORS;
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 1, selectors, "0xtx1" as Hex);
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 8453, selectors, "0xtx2" as Hex);

    const config = await getDelegationConfig(kv, VAULT);
    const chains = getActiveChains(config!);
    expect(chains).toContain(1);
    expect(chains).toContain(8453);
    expect(chains).toHaveLength(2);
  });
});


// ── HyperEVM (999) sma-b delegation ───────────────────────────────────

describe("HyperEVM (999) sma-b delegation", () => {
  const HYPER_EVM = 999;
  const SCA_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

  function makeAlchemyEnv(kv: KVNamespace): any {
    return {
      ...makeEnv(kv),
      ALCHEMY_API_KEY: "test-alchemy-key",
    };
  }

  /** Mock the wallet_requestAccount JSON-RPC behind getScaAddress (fetch). */
  function mockScaRpc(accountAddress: string | null = SCA_ADDRESS) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => accountAddress
        ? { result: { accountAddress } }
        : { result: {} },
    }));
  }

  /** HyperEVM Authority reality: only the 4 HyperEVM selectors are mapped. */
  function mockHyperEvmAuthority() {
    mockAuthorityMappings({
      [ALLOWED_VAULT_SELECTORS.hlDeposit.toLowerCase()]: ADAPTER_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.hlDepositFor.toLowerCase()]: ADAPTER_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.hlSendRawAction.toLowerCase()]: ADAPTER_ADDRESS,
      [ALLOWED_VAULT_SELECTORS.depositV3.toLowerCase()]: ADAPTER_ADDRESS,
    }, ZERO_ADDRESS);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("prepareDelegation", () => {
    it("grants the 4 HyperEVM selectors to BOTH the agent EOA and the sca address in one updateDelegation tx", async () => {
      mockHyperEvmAuthority();
      mockScaRpc();
      const kv = makeKV();

      const result = await prepareDelegation(makeAlchemyEnv(kv), OPERATOR, VAULT, HYPER_EVM);

      expect(result.scaAddress).toBe(SCA_ADDRESS);
      expect(result.transaction.to).toBe(VAULT);

      const decoded = decodeFunctionData({
        abi: VAULT_DELEGATION_ABI,
        data: result.transaction.data as Hex,
      });
      expect(decoded.functionName).toBe("updateDelegation");
      const delegations = decoded.args[0] as readonly { delegated: string; selector: string; isDelegated: boolean }[];
      expect(delegations).toHaveLength(8); // 4 selectors × 2 delegatees

      const expectedSelectors = [
        ALLOWED_VAULT_SELECTORS.hlDeposit.toLowerCase(),
        ALLOWED_VAULT_SELECTORS.hlDepositFor.toLowerCase(),
        ALLOWED_VAULT_SELECTORS.hlSendRawAction.toLowerCase(),
        ALLOWED_VAULT_SELECTORS.depositV3.toLowerCase(),
      ];
      for (const selector of expectedSelectors) {
        const entries = delegations.filter((d) => d.selector.toLowerCase() === selector);
        expect(entries, `selector ${selector}`).toHaveLength(2);
        expect(entries.every((e) => e.isDelegated)).toBe(true);
        const delegatees = entries.map((e) => e.delegated.toLowerCase()).sort();
        expect(delegatees).toEqual([AGENT_ADDRESS.toLowerCase(), SCA_ADDRESS.toLowerCase()].sort());
      }
    });

    it("fails closed when the sca address cannot be derived", async () => {
      mockHyperEvmAuthority();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      const kv = makeKV();

      await expect(
        prepareDelegation(makeAlchemyEnv(kv), OPERATOR, VAULT, HYPER_EVM),
      ).rejects.toThrow();
    });

    it("does not touch other chains (no scaAddress, single delegatee)", async () => {
      mockAuthorityMappings({});
      const kv = makeKV();

      const result = await prepareDelegation(makeEnv(kv), OPERATOR, VAULT, CHAIN_ID);

      expect(result.scaAddress).toBeUndefined();
      const decoded = decodeFunctionData({
        abi: VAULT_DELEGATION_ABI,
        data: result.transaction.data as Hex,
      });
      const delegations = decoded.args[0] as readonly { delegated: string; isDelegated: boolean }[];
      expect(delegations.every((d) => d.delegated.toLowerCase() === AGENT_ADDRESS.toLowerCase())).toBe(true);
    });
  });

  describe("confirmDelegation", () => {
    it("persists scaAddress and writes the reverse lookup on HyperEVM", async () => {
      mockScaRpc();
      const kv = makeKV();
      const selectors = ALL_SELECTORS;
      const txHash = "0x999txhash" as Hex;

      await confirmDelegation(makeAlchemyEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, HYPER_EVM, selectors, txHash);

      const config = await getDelegationConfig(kv, VAULT);
      expect(config!.chains[String(HYPER_EVM)].scaAddress).toBe(SCA_ADDRESS.toLowerCase());

      // Gas-policy webhook reverse lookup: sca address → vault
      const reverse = await kv.get(`agent-reverse:${SCA_ADDRESS.toLowerCase()}`);
      expect(reverse).toBe(VAULT.toLowerCase());
    });

    it("does not write sca state on other chains", async () => {
      const kv = makeKV();

      await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, ALL_SELECTORS, "0xarbtx" as Hex);

      const config = await getDelegationConfig(kv, VAULT);
      expect(config!.chains[String(CHAIN_ID)].scaAddress).toBeUndefined();
      expect(await kv.get(`agent-reverse:${SCA_ADDRESS.toLowerCase()}`)).toBeNull();
    });
  });

  describe("getChainDelegatee (on-chain status delegatee)", () => {
    it("queries the sca address as delegatee on 999 when stored", () => {
      const config = {
        enabled: true,
        agentAddress: AGENT_ADDRESS,
        operatorAddress: OPERATOR,
        vaultAddress: VAULT,
        sponsoredGas: true,
        chains: {
          "999": { confirmedAt: 1, delegatedSelectors: [], scaAddress: SCA_ADDRESS },
        },
      } as any;

      expect(getChainDelegatee(config, 999, AGENT_ADDRESS).toLowerCase()).toBe(SCA_ADDRESS.toLowerCase());
    });

    it("falls back to the agent EOA when no sca is stored", () => {
      expect(getChainDelegatee(null, 999, AGENT_ADDRESS).toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    });

    it("never uses the sca address on other chains", () => {
      const config = {
        enabled: true,
        agentAddress: AGENT_ADDRESS,
        operatorAddress: OPERATOR,
        vaultAddress: VAULT,
        sponsoredGas: true,
        chains: {
          "999": { confirmedAt: 1, delegatedSelectors: [], scaAddress: SCA_ADDRESS },
        },
      } as any;

      expect(getChainDelegatee(config, 42161, AGENT_ADDRESS).toLowerCase()).toBe(AGENT_ADDRESS.toLowerCase());
    });
  });

  describe("selectChainExecutor (HyperEVM sender selection)", () => {
    const baseConfig = {
      enabled: true,
      agentAddress: AGENT_ADDRESS,
      operatorAddress: OPERATOR,
      vaultAddress: VAULT,
      sponsoredGas: true,
      chains: {},
    } as any;

    it("sends from the sca address on 999 when sponsored is ON and sca is stored", () => {
      const chainDelegation = { confirmedAt: 1, delegatedSelectors: [], scaAddress: SCA_ADDRESS };
      expect(selectChainExecutor(chainDelegation, baseConfig, 999).toLowerCase())
        .toBe(SCA_ADDRESS.toLowerCase());
    });

    it("falls back to the agent EOA on 999 when sponsored is OFF", () => {
      const chainDelegation = { confirmedAt: 1, delegatedSelectors: [], scaAddress: SCA_ADDRESS, sponsoredGas: false };
      expect(selectChainExecutor(chainDelegation, baseConfig, 999).toLowerCase())
        .toBe(AGENT_ADDRESS.toLowerCase());
    });

    it("falls back to the agent EOA on 999 when no sca is stored yet", () => {
      const chainDelegation = { confirmedAt: 1, delegatedSelectors: [] };
      expect(selectChainExecutor(chainDelegation, baseConfig, 999).toLowerCase())
        .toBe(AGENT_ADDRESS.toLowerCase());
    });

    it("uses the agent EOA on other chains even when a sca is stored", () => {
      const chainDelegation = { confirmedAt: 1, delegatedSelectors: [], scaAddress: SCA_ADDRESS };
      expect(selectChainExecutor(chainDelegation, baseConfig, 42161).toLowerCase())
        .toBe(AGENT_ADDRESS.toLowerCase());
    });
  });
});
