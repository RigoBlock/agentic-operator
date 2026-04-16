/**
 * Delegation tests — selector map, default selectors, selective revocation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALLOWED_VAULT_SELECTORS, VAULT_DELEGATION_ABI } from "../src/abi/rigoblockVault.js";
import {
  buildDefaultSelectors,
  prepareDelegation,
  confirmDelegation,
  revokeDelegation,
  revokeDelegationOnChain,
  getDelegationConfig,
  prepareSelectiveRevocation,
  isDelegationActive,
  getActiveChains,
} from "../src/services/delegation.js";
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
  deleteAgentWallet: vi.fn().mockResolvedValue(undefined),
}));

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

describe("buildDefaultSelectors", () => {
  it("returns all selectors from ALLOWED_VAULT_SELECTORS", () => {
    const defaults = buildDefaultSelectors();
    const allSelectors = Object.values(ALLOWED_VAULT_SELECTORS);
    expect(defaults).toHaveLength(allSelectors.length);
    for (const selector of allSelectors) {
      expect(defaults).toContain(selector);
    }
  });

  it("returns Hex[] values (0x-prefixed)", () => {
    const defaults = buildDefaultSelectors();
    for (const s of defaults) {
      expect(s).toMatch(/^0x[a-fA-F0-9]{8}$/);
    }
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

  it("delegation array includes all ALLOWED_VAULT_SELECTORS with isDelegated=true", async () => {
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

    // All ALLOWED_VAULT_SELECTORS must be present
    const encodedSelectors = delegations.map(d => d.selector.toLowerCase());
    for (const selector of Object.values(ALLOWED_VAULT_SELECTORS)) {
      expect(encodedSelectors).toContain(selector.toLowerCase());
    }
  });

  it("returns the full selector list matching buildDefaultSelectors()", async () => {
    const kv = makeKV();
    const result = await prepareDelegation(makeEnv(kv), OPERATOR, VAULT, CHAIN_ID);
    const defaults = buildDefaultSelectors();
    expect(result.selectors).toHaveLength(defaults.length);
    for (const s of defaults) {
      expect(result.selectors.map(x => x.toLowerCase())).toContain(s.toLowerCase());
    }
  });
});

describe("confirmDelegation + getDelegationConfig", () => {
  it("saves config to KV and enables delegation for the chain", async () => {
    const kv = makeKV();
    const selectors = buildDefaultSelectors();
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
    const selectors = buildDefaultSelectors();
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
    const originalSelectors = buildDefaultSelectors().slice(0, 5);
    const newSelectors = buildDefaultSelectors();

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
    const selectors = buildDefaultSelectors();

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
    const selectors = buildDefaultSelectors();

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
    const selectors = buildDefaultSelectors();
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
    const selectors = buildDefaultSelectors();
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtx" as Hex);
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(true);
  });

  it("returns false when delegation is not configured", async () => {
    const kv = makeKV();
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(false);
  });

  it("returns false after global revocation", async () => {
    const kv = makeKV();
    const selectors = buildDefaultSelectors();
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, CHAIN_ID, selectors, "0xtx" as Hex);
    await revokeDelegation(kv, VAULT);
    expect(await isDelegationActive(kv, VAULT, CHAIN_ID)).toBe(false);
  });

  it("returns false after chain-specific revocation", async () => {
    const kv = makeKV();
    const selectors = buildDefaultSelectors();
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
    const selectors = buildDefaultSelectors();
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 1, selectors, "0xtx1" as Hex);
    await confirmDelegation(makeEnv(kv), OPERATOR, VAULT, AGENT_ADDRESS, 8453, selectors, "0xtx2" as Hex);

    const config = await getDelegationConfig(kv, VAULT);
    const chains = getActiveChains(config!);
    expect(chains).toContain(1);
    expect(chains).toContain(8453);
    expect(chains).toHaveLength(2);
  });
});
