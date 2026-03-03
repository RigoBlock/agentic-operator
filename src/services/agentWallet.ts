/**
 * Agent Wallet Service — per-vault EOA wallet management.
 *
 * Each smart pool gets its own agent wallet (simple EOA). The private key
 * is encrypted with AES-256-GCM using the AGENT_WALLET_SECRET env var
 * and stored in Cloudflare KV.
 *
 * The agent wallet is what executes transactions in "delegated" mode.
 * The pool operator grants fine-grained permission to this wallet via
 * EIP-7702 + MetaMask Delegation Toolkit, constraining it to specific
 * function selectors on the vault contract.
 *
 * Security model:
 *   - Private keys never leave the Worker runtime unencrypted
 *   - Each vault has a unique agent wallet (no key reuse)
 *   - The delegation framework limits what the agent wallet can do
 *   - KV key: `agent-wallet:${vaultAddress}` (lowercased)
 */

import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import type { Address, Hex } from "viem";
import type { AgentWalletInfo, Env } from "../types.js";

// ── KV key helpers ────────────────────────────────────────────────────

function walletInfoKey(vaultAddress: string): string {
  return `agent-wallet:${vaultAddress.toLowerCase()}`;
}

function walletKeyKey(vaultAddress: string): string {
  return `agent-wallet-key:${vaultAddress.toLowerCase()}`;
}

// ── Encryption helpers (AES-256-GCM via Web Crypto) ───────────────────

/** Derive a 256-bit key from the secret string using HKDF. */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("agentic-operator-wallet-v1"),
      info: encoder.encode("agent-wallet-encryption"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a private key. Returns base64(iv + ciphertext). */
async function encryptPrivateKey(privateKey: Hex, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(privateKey);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/** Decrypt a private key from base64(iv + ciphertext). */
async function decryptPrivateKey(encrypted: string, secret: string): Promise<Hex> {
  const key = await deriveKey(secret);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted) as Hex;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Get the agent wallet info for a vault (without the private key).
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
 * Create a new agent wallet for a vault. If one already exists, returns it.
 *
 * Generates a fresh EOA, encrypts the private key, and stores both
 * the wallet info and encrypted key in KV.
 */
export async function createAgentWallet(
  kv: KVNamespace,
  vaultAddress: string,
  secret: string,
): Promise<AgentWalletInfo> {
  // Check if one already exists
  const existing = await getAgentWalletInfo(kv, vaultAddress);
  if (existing) return existing;

  // Generate new EOA
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const info: AgentWalletInfo = {
    address: account.address,
    vaultAddress: vaultAddress.toLowerCase() as Address,
    delegatedChains: [],
    createdAt: Date.now(),
  };

  // Encrypt and store
  const encryptedKey = await encryptPrivateKey(privateKey, secret);
  await Promise.all([
    kv.put(walletInfoKey(vaultAddress), JSON.stringify(info)),
    kv.put(walletKeyKey(vaultAddress), encryptedKey),
  ]);

  console.log(`[AgentWallet] Created wallet ${account.address} for vault ${vaultAddress}`);
  return info;
}

/**
 * Load the agent wallet account (with signing capability) for a vault.
 * Returns null if no agent wallet exists.
 */
export async function loadAgentWalletAccount(
  kv: KVNamespace,
  vaultAddress: string,
  secret: string,
): Promise<PrivateKeyAccount | null> {
  const encryptedKey = await kv.get(walletKeyKey(vaultAddress));
  if (!encryptedKey) return null;

  const privateKey = await decryptPrivateKey(encryptedKey, secret);
  return privateKeyToAccount(privateKey);
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
 */
export async function deleteAgentWallet(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<void> {
  await Promise.all([
    kv.delete(walletInfoKey(vaultAddress)),
    kv.delete(walletKeyKey(vaultAddress)),
  ]);
  console.log(`[AgentWallet] Deleted wallet for vault ${vaultAddress}`);
}
