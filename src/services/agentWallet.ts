/**
 * Agent Wallet Service — per-vault EOA wallet management with Coinbase CDP.
 *
 * Uses the Coinbase Developer Platform (CDP) Server Wallet API for key
 * generation and signing. Private keys live in AWS Nitro Enclave TEE —
 * they never leave CDP's infrastructure and cannot be extracted.
 *
 * Security model:
 *   - All key generation and signing: CDP Server Wallet (TEE-backed)
 *   - No local encryption needed — keys are managed by CDP
 *   - Each vault has a unique agent wallet (no key reuse)
 *   - Wallet name `vault:{address}` provides idempotent creation
 *   - The EIP-7702 delegation framework limits what the agent wallet can do
 *   - CDP_WALLET_SECRET authenticates wallet operations (POST/DELETE)
 */

import { CdpClient } from "@coinbase/cdp-sdk";
import { toAccount } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import { parseSignature, type Address } from "viem";
import { hashAuthorization } from "viem/utils";
import type { AgentWalletInfo, Env } from "../types.js";

// ── KV key helpers ────────────────────────────────────────────────────

function walletInfoKey(vaultAddress: string): string {
  return `agent-wallet:${vaultAddress.toLowerCase()}`;
}

/**
 * CDP account name for a vault — deterministic and idempotent.
 *
 * CDP naming rules: alphanumeric + hyphens only, 2–36 chars.
 * Format: "vault-" (6) + first 30 hex chars of the address without "0x" = 36 chars.
 * Example: vault address 0xAbCd1234… → "vault-abcd1234..."
 *
 * IMPORTANT: Do NOT change this format after wallets are created in production —
 * the name is the only way to look up the same account across requests.
 */
function cdpAccountName(vaultAddress: string): string {
  // Strip "0x", lowercase, take first 30 hex chars → total name = 36 chars
  return `vault-${vaultAddress.toLowerCase().slice(2, 32)}`;
}

// ── CDP client helper ─────────────────────────────────────────────────

/**
 * Create a CDP client from environment secrets.
 * Called per-request (no module-level mutable state in Workers).
 */
function getCdpClient(env: Env): CdpClient {
  return new CdpClient({
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Get the agent wallet info for a vault (without signing capability).
 * Returns null if no agent wallet exists yet.
 */
export async function getAgentWalletInfo(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<AgentWalletInfo | null> {
  const raw = await kv.get(walletInfoKey(vaultAddress));
  if (!raw) return null;
  return JSON.parse(raw) as AgentWalletInfo;
}

/**
 * Create or sync the agent wallet for a vault using CDP Server Wallet.
 *
 * ALWAYS calls CDP to get the canonical current address — never trusts KV alone.
 * Within the same CDP project, `getOrCreateAccount` is idempotent (same name →
 * same address). If CDP credentials rotated to a new project the address will
 * differ from what is cached in KV; this function detects that, updates KV,
 * clears the stale `delegatedChains`, and returns `walletChanged: true` so the
 * caller can warn the operator that re-delegation is required.
 */
export async function createAgentWallet(
  kv: KVNamespace,
  vaultAddress: string,
  env: Env,
): Promise<AgentWalletInfo & { walletChanged: boolean; previousAddress?: Address }> {
  // Always ask CDP for the canonical address — never rely on KV as source of truth.
  const cdp = getCdpClient(env);
  const account = await cdp.evm.getOrCreateAccount({
    name: cdpAccountName(vaultAddress),
  });
  const currentAddress = account.address as Address;

  const existing = await getAgentWalletInfo(kv, vaultAddress);

  // Address is unchanged — KV is still valid, nothing to do.
  if (existing && existing.address.toLowerCase() === currentAddress.toLowerCase()) {
    return { ...existing, walletChanged: false };
  }

  // Either first-time creation OR CDP credentials rotated → new address.
  const walletChanged = existing !== null;
  if (walletChanged) {
    console.warn(
      `[AgentWallet] CDP address changed for vault ${vaultAddress}: ` +
      `${existing!.address} → ${currentAddress} — stale KV cleared, re-delegation required`,
    );
    // Remove stale reverse lookup so gas-policy webhook does not match old address.
    await kv.delete(`agent-reverse:${existing!.address.toLowerCase()}`);
  }

  const info: AgentWalletInfo = {
    address: currentAddress,
    vaultAddress: vaultAddress.toLowerCase() as Address,
    // Reset delegatedChains — the on-chain delegation was for the OLD address.
    // The operator must set up delegation again for the new address.
    delegatedChains: [],
    createdAt: existing?.createdAt ?? Date.now(),
  };

  await Promise.all([
    kv.put(walletInfoKey(vaultAddress), JSON.stringify(info)),
    kv.put(`agent-reverse:${currentAddress.toLowerCase()}`, vaultAddress.toLowerCase()),
  ]);

  console.log(
    `[AgentWallet] ${walletChanged ? "Updated" : "Created"} CDP wallet ` +
    `${currentAddress} for vault ${vaultAddress}`,
  );

  return {
    ...info,
    walletChanged,
    previousAddress: walletChanged ? existing!.address : undefined,
  };
}

/**
 * Sync the agent wallet address with CDP WITHOUT creating a new one.
 *
 * Called by the delegation status endpoint on every verified status check.
 * Detects CDP credential rotation so the UI can surface a wallet-change warning
 * without requiring the operator to open the delegation setup modal first.
 *
 * Returns null when no agent wallet exists in KV (no creation attempted).
 * If CDP is unreachable, returns the existing KV data unchanged (graceful degradation).
 */
export async function syncAgentWallet(
  kv: KVNamespace,
  vaultAddress: string,
  env: Env,
): Promise<(AgentWalletInfo & { walletChanged: boolean; previousAddress?: Address }) | null> {
  const existing = await getAgentWalletInfo(kv, vaultAddress);
  if (!existing) return null;

  try {
    const cdp = getCdpClient(env);
    const account = await cdp.evm.getOrCreateAccount({
      name: cdpAccountName(vaultAddress),
    });
    const currentAddress = account.address as Address;

    if (existing.address.toLowerCase() === currentAddress.toLowerCase()) {
      return { ...existing, walletChanged: false };
    }

    // Address changed — update KV immediately so subsequent reads are correct.
    console.warn(
      `[AgentWallet] CDP address mismatch for vault ${vaultAddress}: ` +
      `KV=${existing.address} CDP=${currentAddress} — syncing KV`,
    );
    await kv.delete(`agent-reverse:${existing.address.toLowerCase()}`);
    const updated: AgentWalletInfo = {
      address: currentAddress,
      vaultAddress: vaultAddress.toLowerCase() as Address,
      delegatedChains: [],   // delegation was for old address — must re-delegate
      createdAt: existing.createdAt,
    };
    await Promise.all([
      kv.put(walletInfoKey(vaultAddress), JSON.stringify(updated)),
      kv.put(`agent-reverse:${currentAddress.toLowerCase()}`, vaultAddress.toLowerCase()),
    ]);
    return { ...updated, walletChanged: true, previousAddress: existing.address };
  } catch (err) {
    // CDP unreachable or credentials invalid — return cached data, don't break status page.
    console.warn(`[AgentWallet] CDP sync skipped for vault ${vaultAddress}: ${err}`);
    return { ...existing, walletChanged: false };
  }
}

/**
 * Load the agent wallet account (with signing capability) for a vault.
 *
 * Returns a viem-compatible LocalAccount backed by CDP Server Wallet signing.
 * The account can be used directly with viem's `createWalletClient({ account })`.
 *
 * Returns null if no agent wallet exists in KV.
 */
export async function loadAgentWalletAccount(
  kv: KVNamespace,
  vaultAddress: string,
  env: Env,
): Promise<LocalAccount | null> {
  const info = await getAgentWalletInfo(kv, vaultAddress);
  if (!info) return null;

  // Load the CDP account (server-side, no key material transferred)
  const cdp = getCdpClient(env);
  const cdpAccount = await cdp.evm.getAccount({
    address: info.address,
  });

  // Wrap CDP account in a viem-compatible LocalAccount.
  // CDP's EvmServerAccount has sign, signMessage, signTransaction, signTypedData
  // but NOT signAuthorization (EIP-7702). Patch it so Alchemy Smart Wallet's
  // signPreparedCalls can sign the 7702 authorization tuple via CDP.
  const account = toAccount(cdpAccount);
  if (!account.signAuthorization) {
    account.signAuthorization = async (authorization) => {
      const hash = hashAuthorization(authorization);
      const rawSig = await cdpAccount.sign({ hash });
      const { r, s, yParity } = parseSignature(rawSig);
      // Normalise: SignAuthorizationReturnType always requires `address` (not contractAddress).
      const address = ("address" in authorization && authorization.address)
        ? authorization.address
        : (authorization as { contractAddress: Address }).contractAddress;
      return { address, chainId: authorization.chainId, nonce: authorization.nonce, r, s, yParity };
    };
  }
  return account;
}

/**
 * Mark a chain as having active delegation for this vault's agent wallet.
 */
export async function markChainDelegated(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<void> {
  const info = await getAgentWalletInfo(kv, vaultAddress);
  if (!info) throw new Error("No agent wallet exists for this vault");

  if (!info.delegatedChains.includes(chainId)) {
    info.delegatedChains.push(chainId);
    await kv.put(walletInfoKey(vaultAddress), JSON.stringify(info));
  }
}

/**
 * Check if an agent wallet exists and has delegation on a given chain.
 */
export async function isDelegatedOnChain(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<boolean> {
  const info = await getAgentWalletInfo(kv, vaultAddress);
  if (!info) return false;
  return info.delegatedChains.includes(chainId);
}

/**
 * Delete the agent wallet for a vault (revoke agent access).
 * The on-chain delegation should be revoked separately.
 * Note: This only removes the KV reference. The CDP account still exists
 * in CDP but cannot be used without the KV mapping.
 */
export async function deleteAgentWallet(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<void> {
  const info = await getAgentWalletInfo(kv, vaultAddress);
  const deletions = [
    kv.delete(walletInfoKey(vaultAddress)),
  ];
  if (info?.address) {
    deletions.push(kv.delete(`agent-reverse:${info.address.toLowerCase()}`));
  }
  await Promise.all(deletions);
  console.log(`[AgentWallet] Deleted wallet for vault ${vaultAddress}`);
}
