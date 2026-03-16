/**
 * Delegation Service — Vault-based delegation management.
 *
 * Uses the vault's granular per-selector delegation system (v4.2.0):
 *   - updateDelegation(Delegation[]) — batch grant/revoke (selector, address) pairs
 *   - revokeAllDelegations(address) — revoke all selectors for an address
 *   - revokeAllDelegationsForSelector(bytes4) — revoke all addresses for a selector
 *   - getDelegatedSelectors(address) → bytes4[] — view delegated selectors
 *   - getDelegatedAddresses(bytes4) → address[] — view delegated addresses
 *
 * ## How it works
 *
 * 1. The operator calls POST /api/delegation/setup which:
 *    - Creates an agent wallet (if not exists) via agentWallet service
 *    - Returns an unsigned pool.updateDelegation(delegations) transaction
 *
 * 2. The operator signs and sends the updateDelegation() tx via their wallet
 *
 * 3. The frontend confirms with the backend (sends txHash):
 *    - Backend stores the delegation state per-chain in KV
 *
 * 4. When in "delegated" mode, the agent:
 *    - Sends transactions directly to the vault (msg.sender = agent)
 *    - The vault fallback checks delegation().selectorToAddressPosition[msg.sig][msg.sender]
 *
 * ## Revocation
 *
 * The operator calls pool.revokeAllDelegations(agentAddress) to remove all
 * delegations for the agent in one atomic call.
 * Or pool.updateDelegation([...]) with isDelegated=false for selective removal.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import type { DelegationConfig, ChainDelegation, Env } from "../types.js";
import { ALLOWED_VAULT_SELECTORS, VAULT_DELEGATION_ABI } from "../abi/rigoblockVault.js";
import {
  getAgentWalletInfo,
  createAgentWallet,
  markChainDelegated,
} from "./agentWallet.js";
import { getClient } from "./vault.js";

// ── KV key helpers ────────────────────────────────────────────────────

function delegationConfigKey(vaultAddress: string): string {
  return `delegation:${vaultAddress.toLowerCase()}`;
}

// ── Selector list ─────────────────────────────────────────────────────

/**
 * Build the list of vault function selectors the agent should be delegated for.
 */
export function buildDefaultSelectors(): Hex[] {
  return Object.values(ALLOWED_VAULT_SELECTORS) as Hex[];
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Get the delegation config for a vault.
 */
export async function getDelegationConfig(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<DelegationConfig | null> {
  const raw = await kv.get(delegationConfigKey(vaultAddress));
  if (!raw) return null;
  return JSON.parse(raw) as DelegationConfig;
}

/**
 * Save delegation config to KV.
 */
export async function saveDelegationConfig(
  kv: KVNamespace,
  config: DelegationConfig,
): Promise<void> {
  await kv.put(
    delegationConfigKey(config.vaultAddress),
    JSON.stringify(config),
  );
  console.log(`[Delegation] Saved config for vault ${config.vaultAddress}`);
}

/**
 * Prepare the delegation setup.
 *
 * Creates the agent wallet (if needed) and returns an unsigned transaction
 * that calls vault.updateDelegation(delegations).
 * The operator must sign and send this transaction from their wallet.
 */
export async function prepareDelegation(
  env: Env,
  operatorAddress: Address,
  vaultAddress: Address,
  chainId: number,
): Promise<{
  agentAddress: Address;
  selectors: Hex[];
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    chainId: number;
    gas?: string;
    description: string;
  };
}> {
  // 1. Get or create agent wallet
  const walletInfo = await createAgentWallet(
    env.KV,
    vaultAddress,
    env.AGENT_WALLET_SECRET,
  );

  // 2. Build selector list (all vault functions the agent can call)
  const selectors = buildDefaultSelectors();

  // 3. Encode pool.updateDelegation(Delegation[]) call
  //    Each Delegation = { delegated: address, selector: bytes4, isDelegated: bool }
  const delegations = selectors.map((selector) => ({
    delegated: walletInfo.address,
    selector: selector as `0x${string}`,
    isDelegated: true,
  }));

  const data = encodeFunctionData({
    abi: VAULT_DELEGATION_ABI,
    functionName: "updateDelegation",
    args: [delegations],
  });

  return {
    agentAddress: walletInfo.address,
    selectors,
    transaction: {
      to: vaultAddress,
      data,
      value: "0x0",
      chainId,
      description: `Delegate ${selectors.length} vault functions to agent ${walletInfo.address.slice(0, 6)}…${walletInfo.address.slice(-4)}`,
    },
  };
}

/**
 * Confirm that the delegation tx was sent on-chain.
 *
 * Called after the operator broadcasts the updateDelegation() transaction.
 * Saves the delegation config to KV and marks the chain as delegated.
 *
 * IMPORTANT: This MERGES the new chain into the existing config rather than
 * overwriting, because delegation is per-chain.
 */
export async function confirmDelegation(
  env: Env,
  operatorAddress: Address,
  vaultAddress: Address,
  agentAddress: Address,
  chainId: number,
  selectors: Hex[],
  txHash: Hex,
): Promise<DelegationConfig> {
  const existing = await getDelegationConfig(env.KV, vaultAddress);

  const chainDelegation: ChainDelegation = {
    confirmedAt: Date.now(),
    delegatedSelectors: selectors,
    delegateTxHash: txHash,
  };

  const config: DelegationConfig = {
    enabled: true,
    agentAddress,
    operatorAddress,
    vaultAddress,
    sponsoredGas: existing?.sponsoredGas ?? true, // Default: sponsored (operator doesn't need to fund agent)
    chains: {
      ...(existing?.chains || {}),
      [String(chainId)]: chainDelegation,
    },
  };

  await saveDelegationConfig(env.KV, config);
  await markChainDelegated(env.KV, vaultAddress, chainId);

  console.log(
    `[Delegation] Confirmed on chain ${chainId} for vault ${vaultAddress} ` +
    `(total chains: ${Object.keys(config.chains).length})`,
  );
  return config;
}

/**
 * Check on-chain whether the agent is delegated for specific selectors on a vault.
 *
 * Calls pool.getDelegatedSelectors(agentAddress) to get the full list of
 * selectors the agent is granted, then intersects with the requested set.
 */
export async function checkDelegationOnChain(
  chainId: number,
  vaultAddress: Address,
  agentAddress: Address,
  selectors: Hex[],
  alchemyKey?: string,
): Promise<{
  allDelegated: boolean;
  delegatedSelectors: Hex[];
  undelegatedSelectors: Hex[];
}> {
  const publicClient = getClient(chainId, alchemyKey);

  try {
    // Single call: get all selectors delegated to the agent
    const result = await publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_DELEGATION_ABI,
      functionName: "getDelegatedSelectors",
      args: [agentAddress],
    });

    const onChainSelectors = new Set(
      (result as readonly string[]).map((s: string) => s.toLowerCase()),
    );

    const delegated = selectors.filter((s) => onChainSelectors.has(s.toLowerCase()));
    const undelegated = selectors.filter((s) => !onChainSelectors.has(s.toLowerCase()));

    return {
      allDelegated: undelegated.length === 0,
      delegatedSelectors: delegated,
      undelegatedSelectors: undelegated,
    };
  } catch {
    // Contract may not support the view (old version) — treat as not delegated
    return {
      allDelegated: false,
      delegatedSelectors: [],
      undelegatedSelectors: selectors,
    };
  }
}

/**
 * Prepare a revocation transaction.
 *
 * Returns an unsigned tx calling pool.revokeAllDelegations(agentAddress)
 * which removes all of the agent's delegations on-chain in one atomic call.
 */
export async function prepareRevocation(
  env: Env,
  vaultAddress: Address,
  chainId: number,
): Promise<{
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    chainId: number;
    description: string;
  };
}> {
  // Get the agent wallet to know which address to revoke
  const walletInfo = await getAgentWalletInfo(env.KV, vaultAddress as string);
  const agentAddress = walletInfo?.address ||
    ("0x0000000000000000000000000000000000000000" as Address);

  const data = encodeFunctionData({
    abi: VAULT_DELEGATION_ABI,
    functionName: "revokeAllDelegations",
    args: [agentAddress],
  });

  return {
    transaction: {
      to: vaultAddress,
      data,
      value: "0x0",
      chainId,
      description: `Revoke all delegations for agent ${agentAddress.slice(0, 6)}…${agentAddress.slice(-4)}`,
    },
  };
}

/**
 * Prepare a selective revocation transaction using updateDelegation with isDelegated=false.
 *
 * Useful when only certain selectors need to be revoked (vs. revokeAllDelegations for full removal).
 */
export async function prepareSelectiveRevocation(
  env: Env,
  vaultAddress: Address,
  agentAddress: Address,
  selectors: Hex[],
  chainId: number,
): Promise<{
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    chainId: number;
    description: string;
  };
}> {
  const delegations = selectors.map((selector) => ({
    delegated: agentAddress,
    selector: selector as `0x${string}`,
    isDelegated: false,
  }));

  const data = encodeFunctionData({
    abi: VAULT_DELEGATION_ABI,
    functionName: "updateDelegation",
    args: [delegations],
  });

  return {
    transaction: {
      to: vaultAddress,
      data,
      value: "0x0",
      chainId,
      description: `Revoke ${selectors.length} delegated selectors for agent ${agentAddress.slice(0, 6)}…${agentAddress.slice(-4)}`,
    },
  };
}

/**
 * Check if delegation is active for a vault on a given chain (KV check only).
 */
export async function isDelegationActive(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<boolean> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (!config) return false;
  return config.enabled && !!config.chains?.[String(chainId)];
}

/**
 * Check if delegation is active on ANY chain for a vault.
 * Used when the caller's current chain may differ from target chains.
 */
export async function isDelegationActiveAnyChain(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<boolean> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (!config || !config.enabled) return false;
  return Object.keys(config.chains || {}).length > 0;
}

/**
 * Get the chain-specific delegation config.
 */
export async function getChainDelegation(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<ChainDelegation | null> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (!config || !config.enabled) return null;
  return config.chains?.[String(chainId)] || null;
}

/**
 * Get all chain IDs where delegation is active for a vault.
 */
export function getActiveChains(config: DelegationConfig): number[] {
  return Object.keys(config.chains || {}).map(Number);
}

/**
 * Revoke delegation globally — disable the agent on all chains.
 * On-chain delegation also needs to be revoked via vault.revokeAllDelegations(agentAddress).
 */
export async function revokeDelegation(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<void> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (config) {
    config.enabled = false;
    config.chains = {};
    await kv.put(delegationConfigKey(vaultAddress), JSON.stringify(config));
  }
  console.log(`[Delegation] Revoked delegation for vault ${vaultAddress} (all chains)`);
}

/**
 * Revoke delegation on a single chain — keep other chains active.
 */
export async function revokeDelegationOnChain(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<void> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (!config) return;

  delete config.chains?.[String(chainId)];

  if (Object.keys(config.chains || {}).length === 0) {
    config.enabled = false;
  }

  await kv.put(delegationConfigKey(vaultAddress), JSON.stringify(config));
  console.log(
    `[Delegation] Revoked delegation on chain ${chainId} for vault ${vaultAddress} ` +
    `(remaining: ${Object.keys(config.chains || {}).length} chains)`,
  );
}
