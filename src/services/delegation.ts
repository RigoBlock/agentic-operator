/**
 * Delegation Service — EIP-7702 + MetaMask Delegation Toolkit integration.
 *
 * Manages the on-chain delegation that allows an agent wallet to execute
 * vault operations on behalf of the pool operator.
 *
 * ## How it works
 *
 * 1. The operator calls POST /api/delegation/setup which:
 *    - Creates an agent wallet (if not exists) via agentWallet service
 *    - Returns a delegation object the frontend must have the operator sign
 *
 * 2. The operator signs the EIP-7702 authorization in their wallet:
 *    - This sets the DelegationManager code on the operator's EOA
 *    - The delegation grants the agent wallet permission to call specific
 *      function selectors on the vault contract
 *
 * 3. When in "delegated" mode, the agent:
 *    - Builds the transaction as usual
 *    - Shows the operator the details for confirmation
 *    - On confirmation, redeems the delegation to execute via the agent wallet
 *
 * ## MetaMask Delegation Toolkit Caveats
 *
 * The delegation is constrained using caveats:
 * - AllowedTargets: Only the vault contract address
 * - AllowedMethods: Only specific function selectors (execute, modifyLiquidities, GMX ops)
 * - NativeTokenTransferAmount: 0 (no ETH transfers, except for tx value required by GMX)
 *
 * This means the agent wallet CANNOT:
 * - Transfer tokens directly from the operator's wallet
 * - Call arbitrary contracts
 * - Call admin functions on the vault (transferOwnership, etc.)
 *
 * ## On-chain contracts
 *
 * The MetaMask Delegation Toolkit uses:
 * - DelegationManager: The EIP-7702 implementation contract
 * - MultiSigDeleGator / HybridDeleGator: Account implementation
 * - CaveatEnforcer contracts: On-chain enforcement of restrictions
 *
 * Reference: https://metamask.io/developer/delegation-toolkit
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, keccak256, toHex } from "viem";
import type { DelegationConfig, Env } from "../types.js";
import { ALLOWED_VAULT_SELECTORS } from "../abi/rigoblockVault.js";
import {
  getAgentWalletInfo,
  createAgentWallet,
  markChainDelegated,
} from "./agentWallet.js";

// ── Delegation Toolkit Contract Addresses ─────────────────────────────
// These are the canonical MetaMask Delegation Toolkit deployments.
// They're deployed at the same addresses on all supported chains.
// Reference: https://docs.gator.metamask.io/contracts

export const DELEGATION_CONTRACTS = {
  /** DelegationManager — the core delegation resolution contract */
  delegationManager: "0x0000000000000000000000000000000000000000" as Address, // TODO: populate with actual deployed address
  /** AllowedTargets caveat enforcer */
  allowedTargetsCaveatEnforcer: "0x0000000000000000000000000000000000000000" as Address,
  /** AllowedMethods caveat enforcer */
  allowedMethodsCaveatEnforcer: "0x0000000000000000000000000000000000000000" as Address,
  /** NativeTokenTransferAmount caveat enforcer */
  nativeTokenCaveatEnforcer: "0x0000000000000000000000000000000000000000" as Address,
  /** LimitedCalls caveat enforcer (rate limiting) */
  limitedCallsCaveatEnforcer: "0x0000000000000000000000000000000000000000" as Address,
} as const;

// ── KV key helpers ────────────────────────────────────────────────────

function delegationConfigKey(vaultAddress: string): string {
  return `delegation:${vaultAddress.toLowerCase()}`;
}

// ── Caveat builders ───────────────────────────────────────────────────

/**
 * Build the caveats array for the delegation.
 *
 * Caveats are on-chain enforced restrictions on what the delegate (agent wallet)
 * can do when redeeming the delegation.
 */
export function buildDelegationCaveats(vaultAddress: Address): DelegationCaveat[] {
  const caveats: DelegationCaveat[] = [];

  // 1. AllowedTargets: Only the vault contract
  caveats.push({
    enforcer: DELEGATION_CONTRACTS.allowedTargetsCaveatEnforcer,
    terms: encodeAllowedTargets([vaultAddress]),
  });

  // 2. AllowedMethods: Only the vault trading selectors
  const selectors = Object.values(ALLOWED_VAULT_SELECTORS);
  caveats.push({
    enforcer: DELEGATION_CONTRACTS.allowedMethodsCaveatEnforcer,
    terms: encodeAllowedMethods(selectors),
  });

  // 3. NativeTokenTransferAmount: Allow small amounts for GMX execution fees
  // GMX createOrder requires sending ETH for execution fees (~0.001 ETH)
  caveats.push({
    enforcer: DELEGATION_CONTRACTS.nativeTokenCaveatEnforcer,
    terms: encodeNativeTokenLimit(BigInt("10000000000000000")), // 0.01 ETH max per call
  });

  return caveats;
}

/** Caveat structure matching the Delegation Toolkit format */
export interface DelegationCaveat {
  enforcer: Address;
  terms: Hex;
}

/** Full delegation object to be signed by the operator */
export interface DelegationObject {
  /** The delegate who can redeem this delegation (agent wallet) */
  delegate: Address;
  /** The delegator whose authority is being delegated (operator) */
  delegator: Address;
  /** The DelegationManager authority address */
  authority: Hex;
  /** Caveats that constrain the delegation */
  caveats: DelegationCaveat[];
  /** Salt for uniqueness */
  salt: bigint;
  /** Signature (empty until operator signs) */
  signature: Hex;
}

// ── Encoding helpers for caveat terms ─────────────────────────────────

function encodeAllowedTargets(targets: Address[]): Hex {
  // ABI-encode array of addresses
  const encoded = targets.map((t) => t.toLowerCase().padStart(64, "0")).join("");
  return `0x${encoded}` as Hex;
}

function encodeAllowedMethods(selectors: Hex[]): Hex {
  // Concatenate 4-byte selectors
  const encoded = selectors.map((s) => s.slice(2)).join("");
  return `0x${encoded}` as Hex;
}

function encodeNativeTokenLimit(maxWei: bigint): Hex {
  return toHex(maxWei, { size: 32 });
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
 * Save delegation config after successful on-chain setup.
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
 * Prepare a delegation setup for the operator to sign.
 *
 * Returns the agent wallet address and the unsigned delegation object
 * that the frontend should present for signing via the Delegation Toolkit.
 *
 * Flow:
 * 1. Creates agent wallet if needed
 * 2. Builds delegation with caveats
 * 3. Returns unsigned delegation for the operator to sign
 */
export async function prepareDelegation(
  env: Env,
  operatorAddress: Address,
  vaultAddress: Address,
  chainId: number,
): Promise<{
  agentAddress: Address;
  delegation: DelegationObject;
  caveats: DelegationCaveat[];
  allowedSelectors: Hex[];
}> {
  // 1. Get or create agent wallet
  const walletInfo = await createAgentWallet(
    env.KV,
    vaultAddress,
    env.AGENT_WALLET_SECRET,
  );

  // 2. Build caveats
  const caveats = buildDelegationCaveats(vaultAddress);
  const allowedSelectors = Object.values(ALLOWED_VAULT_SELECTORS);

  // 3. Build unsigned delegation
  const delegation: DelegationObject = {
    delegate: walletInfo.address,
    delegator: operatorAddress,
    authority: keccak256(toHex("ROOT_AUTHORITY")),
    caveats,
    salt: BigInt(Date.now()),
    signature: "0x" as Hex, // Operator will fill this
  };

  return {
    agentAddress: walletInfo.address,
    delegation,
    caveats,
    allowedSelectors,
  };
}

/**
 * Confirm that delegation was set up on-chain.
 *
 * Called after the operator signs and broadcasts the EIP-7702 authorization.
 * Saves the delegation config to KV and marks the chain as delegated.
 */
export async function confirmDelegation(
  env: Env,
  operatorAddress: Address,
  vaultAddress: Address,
  agentAddress: Address,
  chainId: number,
  allowedSelectors: Hex[],
): Promise<DelegationConfig> {
  const config: DelegationConfig = {
    enabled: true,
    agentAddress,
    operatorAddress,
    vaultAddress,
    allowedSelectors,
    activeChains: [chainId],
    expiresAt: 0, // Managed by on-chain delegation
  };

  await saveDelegationConfig(env.KV, config);
  await markChainDelegated(env.KV, vaultAddress, chainId);

  console.log(`[Delegation] Confirmed on chain ${chainId} for vault ${vaultAddress}`);
  return config;
}

/**
 * Check if delegation is active for a vault on a given chain.
 */
export async function isDelegationActive(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<boolean> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (!config) return false;
  return config.enabled && config.activeChains.includes(chainId);
}

/**
 * Revoke delegation — disable the agent for a vault.
 *
 * Note: This only removes the server-side config. The on-chain delegation
 * should also be revoked by the operator via the Delegation Toolkit.
 */
export async function revokeDelegation(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<void> {
  const config = await getDelegationConfig(kv, vaultAddress);
  if (config) {
    config.enabled = false;
    config.activeChains = [];
    await kv.put(delegationConfigKey(vaultAddress), JSON.stringify(config));
  }
  console.log(`[Delegation] Revoked delegation for vault ${vaultAddress}`);
}
