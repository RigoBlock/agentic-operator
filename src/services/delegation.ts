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
import { AUTHORITY_ADDRESS, AUTHORITY_ABI } from "../abi/authority.js";
import { ZERO_ADDRESS } from "../config.js";
import {
  getAgentWalletInfo,
  createAgentWallet,
  markChainDelegated,
  unmarkChainDelegated,
} from "./agentWallet.js";
import { getRpcProvider } from "./rpcClient.js";
import { getScaAddress } from "./scaAccount.js";

// ── KV key helpers ────────────────────────────────────────────────────

function delegationConfigKey(vaultAddress: string): string {
  return `delegation:${vaultAddress.toLowerCase()}`;
}

/**
 * KV prefix for agent-wallet reverse lookup: agentAddress → vaultAddress.
 * Written at delegation confirm time (agent EOA and, on HyperEVM, the sma-b
 * smart-account address) so the gas-policy webhook can resolve a UserOp sender
 * to its vault. Consumed by src/routes/gasPolicy.ts.
 */
export const AGENT_REVERSE_KEY = "agent-reverse:";

// ── Selector list ─────────────────────────────────────────────────────

/**
 * Build the list of vault function selectors the agent should be delegated for
 * on a given chain: every whitelisted adapter selector that the chain's
 * Authority actually maps to an adapter, and nothing else.
 *
 * A selector with no adapter mapping is inert (the vault fallback reverts on
 * it before delegation is even consulted), so granting it only widens the
 * attack surface for free if governance later maps the selector on that chain.
 * Resolution is ground truth from the Authority — one multicall — so new
 * adapters and chains need no code changes here.
 *
 * Fails closed: if the Authority cannot be read, throws instead of guessing.
 */
export async function getDelegableSelectors(chainId: number): Promise<Hex[]> {
  const publicClient = getRpcProvider(chainId);
  const all = Object.values(ALLOWED_VAULT_SELECTORS);

  const results = await publicClient.multicall({
    contracts: all.map((selector) => ({
      address: AUTHORITY_ADDRESS,
      abi: AUTHORITY_ABI,
      functionName: "getApplicationAdapter" as const,
      args: [selector],
    })),
  });

  return all.filter((_, i) => {
    const r = results[i];
    if (r.status !== "success") {
      throw new Error(
        `Failed to resolve adapter mapping for selector ${all[i]} on chain ${chainId}: ${r.error?.message ?? "unknown"}`,
      );
    }
    return (r.result as string).toLowerCase() !== ZERO_ADDRESS;
  });
}

/**
 * Read the selectors a vault has actually delegated to an agent, straight from
 * the vault (ground truth for execution). Returns null when the vault cannot be
 * read (no code at the address, or the vault predates the delegation views).
 */
export async function getAgentDelegatedSelectors(
  chainId: number,
  vaultAddress: Address,
  agentAddress: Address,
): Promise<Hex[] | null> {
  const publicClient = getRpcProvider(chainId);
  try {
    const result = await publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_DELEGATION_ABI,
      functionName: "getDelegatedSelectors",
      args: [agentAddress],
    });
    return (result as readonly string[]).map((s) => s.toLowerCase() as Hex);
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Resolve the delegatee that on-chain status checks must query for a chain.
 *
 * On HyperEVM (999) the PRIMARY delegatee is the sma-b smart-account address
 * (the sponsored path's UserOp sender). The agent EOA's delegation there is a
 * direct-broadcast fallback only and is never status-checked. On every other
 * chain the agent EOA is the delegatee.
 */
export function getChainDelegatee(
  config: DelegationConfig | null,
  chainId: number,
  agentAddress: Address,
): Address {
  if (chainId === 999) {
    const scaAddress = config?.chains?.["999"]?.scaAddress;
    if (scaAddress) return scaAddress as Address;
  }
  return agentAddress;
}

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
}

/**
 * Prepare the delegation setup.
 *
 * Syncs the agent wallet with CDP (detects credential rotation), then returns
 * an unsigned `vault.updateDelegation(delegations)` transaction for the operator
 * to sign and send from their wallet.
 *
 * When CDP credentials have rotated and the agent wallet address has changed,
 * the response also includes:
 *   - `walletChanged: true`
 *   - `previousAgentAddress`: the old agent address that must be revoked
 *   - `revocationTransaction`: unsigned `vault.revokeAllDelegations(oldAgent)` tx
 *
 * The operator should send the revocation tx FIRST, then the new delegation tx.
 */
export async function prepareDelegation(
  env: Env,
  _operatorAddress: Address,
  vaultAddress: Address,
  chainId: number,
  /** If provided, only these selectors are included (for delta updates of existing delegation). */
  onlySelectors?: Hex[],
): Promise<{
  agentAddress: Address;
  selectors: Hex[];
  /** HyperEVM (999) only: the deterministic sma-b smart-account address, co-delegated on-chain. */
  scaAddress?: Address;
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    chainId: number;
    gas?: string;
    description: string;
  };
  walletChanged: boolean;
  previousAgentAddress?: Address;
  revocationTransaction?: {
    to: Address;
    data: Hex;
    value: string;
    chainId: number;
    description: string;
  };
}> {
  // 1. Sync agent wallet with CDP — always verifies the canonical address.
  //    Returns walletChanged=true + previousAddress if credentials rotated.
  const walletResult = await createAgentWallet(env.KV, vaultAddress, env);
  const { walletChanged, previousAddress } = walletResult;

  // 2. Build selector list — use only missing selectors for delta updates, all in-scope ones for fresh setup.
  //    CRITICAL: when the wallet changed, the new agent address has ZERO delegation on-chain.
  //    We must delegate ALL selectors to the new wallet, not just a delta.
  const selectors = (walletChanged || !onlySelectors) ? await getDelegableSelectors(chainId) : onlySelectors;

  // 3. HyperEVM (999): Alchemy's Wallet API has no EIP-7702 mode there, so the
  //    sponsored route is the sma-b smart account derived from the agent EOA
  //    (agent key remains the sole signer — Alchemy never holds it). Derive it
  //    fresh and co-delegate: one updateDelegation call granting the chain's
  //    selector set to BOTH the agent EOA (direct-broadcast fallback) and the
  //    sca address (sponsored primary).
  let scaAddress: Address | undefined;
  if (chainId === 999) {
    scaAddress = await getScaAddress(walletResult.address, env.ALCHEMY_API_KEY);
  }

  // 4. Encode pool.updateDelegation(Delegation[]) for the NEW agent
  const delegationEntries = scaAddress
    ? selectors.flatMap((selector) => ([
        { delegated: walletResult.address, selector: selector as `0x${string}`, isDelegated: true },
        { delegated: scaAddress as `0x${string}`, selector: selector as `0x${string}`, isDelegated: true },
      ]))
    : selectors.map((selector) => ({
        delegated: walletResult.address,
        selector: selector as `0x${string}`,
        isDelegated: true,
      }));

  const delegateData = encodeFunctionData({
    abi: VAULT_DELEGATION_ABI,
    functionName: "updateDelegation",
    args: [delegationEntries],
  });

  // 5. If the agent wallet changed, also build a revocation tx for the OLD agent.
  //    The operator must send this BEFORE the new delegation tx so the old agent
  //    loses access immediately.
  let revocationTransaction: {
    to: Address; data: Hex; value: string; chainId: number; description: string;
  } | undefined;

  if (walletChanged && previousAddress) {
    const revokeData = encodeFunctionData({
      abi: VAULT_DELEGATION_ABI,
      functionName: "revokeAllDelegations",
      args: [previousAddress],
    });
    revocationTransaction = {
      to: vaultAddress,
      data: revokeData,
      value: "0x0",
      chainId,
      description: `Revoke old agent ${previousAddress.slice(0, 6)}…${previousAddress.slice(-4)} (wallet changed — send this first)`,
    };
    console.warn(
      `[Delegation] Wallet changed for vault ${vaultAddress} on chain ${chainId}: ` +
      `old=${previousAddress} new=${walletResult.address} — revocation tx included`,
    );
  }

  return {
    agentAddress: walletResult.address,
    selectors,
    scaAddress,
    transaction: {
      to: vaultAddress,
      data: delegateData,
      value: "0x0",
      chainId,
      description: scaAddress
        ? `Delegate ${selectors.length} vault functions to agent ${walletResult.address.slice(0, 6)}…${walletResult.address.slice(-4)} and its HyperEVM sponsored account ${scaAddress.slice(0, 6)}…${scaAddress.slice(-4)}`
        : `Delegate ${selectors.length} vault functions to agent ${walletResult.address.slice(0, 6)}…${walletResult.address.slice(-4)}`,
    },
    walletChanged,
    previousAgentAddress: previousAddress,
    revocationTransaction,
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

  // HyperEVM (999): persist the sma-b smart-account address (deterministic per
  // agent EOA) and write its reverse lookup so the gas-policy webhook can
  // resolve the sca UserOp sender to this vault.
  let scaAddress: string | undefined;
  if (chainId === 999) {
    scaAddress = (await getScaAddress(agentAddress, env.ALCHEMY_API_KEY)).toLowerCase();
    await env.KV.put(`${AGENT_REVERSE_KEY}${scaAddress}`, vaultAddress.toLowerCase());
  }

  const chainDelegation: ChainDelegation = {
    confirmedAt: Date.now(),
    delegatedSelectors: selectors,
    delegateTxHash: txHash,
    ...(scaAddress ? { scaAddress } : {}),
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
): Promise<{
  allDelegated: boolean;
  delegatedSelectors: Hex[];
  undelegatedSelectors: Hex[];
}> {
  const onChainSelectors = await getAgentDelegatedSelectors(chainId, vaultAddress, agentAddress);

  // Vault may not support the view (old version) — treat as not delegated
  if (onChainSelectors === null) {
    return {
      allDelegated: false,
      delegatedSelectors: [],
      undelegatedSelectors: selectors,
    };
  }

  const onChainSet = new Set<string>(onChainSelectors);
  const delegated = selectors.filter((s) => onChainSet.has(s.toLowerCase()));
  const undelegated = selectors.filter((s) => !onChainSet.has(s.toLowerCase()));

  return {
    allDelegated: undelegated.length === 0,
    delegatedSelectors: delegated,
    undelegatedSelectors: undelegated,
  };
}

/**
 * Resolve the per-chain execution sender: the address that will actually
 * broadcast (and therefore must be the tx `from`).
 *
 * On HyperEVM (999), when sponsored gas is effectively ON and the sma-b
 * smart-account address is stored, the sca address is the sender (sponsored
 * UserOps send `from` the sma-b account, signed by the agent key). Otherwise
 * the agent EOA broadcasts directly.
 */
export function selectChainExecutor(
  chainDelegation: ChainDelegation,
  config: DelegationConfig,
  chainId: number,
): Address {
  if (chainId === 999 && chainDelegation.scaAddress) {
    const sponsoredEffective = chainDelegation.sponsoredGas !== undefined
      ? chainDelegation.sponsoredGas
      : (config.sponsoredGas ?? true);
    if (sponsoredEffective) return chainDelegation.scaAddress as Address;
  }
  return config.agentAddress;
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
  _env: Env,
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
    // Clear all chains from AgentWalletInfo.delegatedChains before wiping DelegationConfig
    const chainIds = Object.keys(config.chains || {}).map(Number);
    await Promise.all(chainIds.map(id => unmarkChainDelegated(kv, vaultAddress, id).catch(() => {})));
    config.enabled = false;
    config.chains = {};
    await kv.put(delegationConfigKey(vaultAddress), JSON.stringify(config));
  }
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

  // Also clear AgentWalletInfo.delegatedChains so the UI reflects the revocation immediately
  await unmarkChainDelegated(kv, vaultAddress, chainId).catch(() => {});

  await kv.put(delegationConfigKey(vaultAddress), JSON.stringify(config));
}
