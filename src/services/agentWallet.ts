/**
 * Agent Wallet Service — per-vault EOA wallet management.
 *
 * Each smart pool gets its own agent wallet (simple EOA). The private key
 * is encrypted with AES-256-GCM using a **per-vault derived key**:
 *
 *   encryptionKey = HKDF(AGENT_WALLET_SECRET, salt=vaultAddress)
 *
 * This means:
 *   - Compromising one vault's encrypted blob doesn't help with others
 *   - Each vault has a cryptographically independent encryption key
 *   - Key versioning allows safe rotation of the master secret
 *
 * Security model:
 *   - Private keys never leave the Worker runtime unencrypted
 *   - Each vault has a unique agent wallet (no key reuse)
 *   - Per-vault key derivation isolates compromise blast radius
 *   - The EIP-7702 delegation framework limits what the agent wallet can do
 *   - KV key: `agent-wallet:${vaultAddress}` (lowercased)
 *
 * Key rotation procedure:
 *   1. Set AGENT_WALLET_SECRET_V2 in wrangler secrets
 *   2. Call rotateAgentWalletKey() for each vault — decrypts with old, re-encrypts with new
 *   3. Once all vaults migrated, rename V2 → AGENT_WALLET_SECRET, remove old
 */

import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import type { Address, Hex } from "viem";
import type { AgentWalletInfo, Env } from "../types.js";

/** Current encryption version */
const CURRENT_KEY_VERSION = 1;

// ── KV key helpers ────────────────────────────────────────────────────

function walletInfoKey(vaultAddress: string): string {
  return `agent-wallet:${vaultAddress.toLowerCase()}`;
}

function walletKeyKey(vaultAddress: string): string {
  return `agent-wallet-key:${vaultAddress.toLowerCase()}`;
}

// ── Encryption helpers (AES-256-GCM via Web Crypto) ───────────────────

/**
 * Derive a per-vault 256-bit encryption key.
 *
 * Uses HKDF with the vault address as salt, so each vault gets a
 * cryptographically independent key from the same master secret.
 */
async function deriveVaultKey(secret: string, vaultAddress: string): Promise<CryptoKey> {
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
      // Salt is the vault address — makes each vault's key independent
      salt: encoder.encode(`vault:${vaultAddress.toLowerCase()}`),
      info: encoder.encode(`agentic-operator-wallet-v${CURRENT_KEY_VERSION}`),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Stored format: JSON { v: keyVersion, d: base64(iv + ciphertext) } */
interface EncryptedKeyEnvelope {
  v: number;
  d: string;
}

/** Encrypt a private key. Returns JSON envelope with version + base64(iv + ciphertext). */
async function encryptPrivateKey(
  privateKey: Hex,
  secret: string,
  vaultAddress: string,
): Promise<string> {
  const key = await deriveVaultKey(secret, vaultAddress);
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

  const envelope: EncryptedKeyEnvelope = {
    v: CURRENT_KEY_VERSION,
    d: btoa(String.fromCharCode(...combined)),
  };

  return JSON.stringify(envelope);
}

/** Decrypt a private key from the envelope format. */
async function decryptPrivateKey(
  envelopeStr: string,
  secret: string,
  vaultAddress: string,
): Promise<Hex> {
  // Support both old format (raw base64) and new envelope format
  let envelope: EncryptedKeyEnvelope;
  try {
    envelope = JSON.parse(envelopeStr);
  } catch {
    // Legacy format: raw base64 without version envelope
    envelope = { v: 0, d: envelopeStr };
  }

  // For v0 (legacy), use the old global derivation; for v1+, use per-vault
  const key = envelope.v >= 1
    ? await deriveVaultKey(secret, vaultAddress)
    : await deriveLegacyKey(secret);

  const combined = Uint8Array.from(atob(envelope.d), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted) as Hex;
}

/** Legacy key derivation (v0) — global, not per-vault. For migration only. */
async function deriveLegacyKey(secret: string): Promise<CryptoKey> {
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
 * Generates a fresh EOA, encrypts the private key with a per-vault derived
 * key, and stores both the wallet info and encrypted key in KV.
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

  // Encrypt with per-vault key and store
  const encryptedKey = await encryptPrivateKey(privateKey, secret, vaultAddress);
  await Promise.all([
    kv.put(walletInfoKey(vaultAddress), JSON.stringify(info)),
    kv.put(walletKeyKey(vaultAddress), encryptedKey),
    // Reverse lookup: agent address → vault address (used by gas-policy webhook)
    kv.put(`agent-reverse:${account.address.toLowerCase()}`, vaultAddress.toLowerCase()),
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

  const privateKey = await decryptPrivateKey(encryptedKey, secret, vaultAddress);
  return privateKeyToAccount(privateKey);
}

/**
 * Rotate the encryption key for a vault's agent wallet.
 *
 * Decrypts with the old secret, re-encrypts with the new secret.
 * Call this for every vault when rotating AGENT_WALLET_SECRET.
 */
export async function rotateAgentWalletKey(
  kv: KVNamespace,
  vaultAddress: string,
  oldSecret: string,
  newSecret: string,
): Promise<void> {
  const encryptedKey = await kv.get(walletKeyKey(vaultAddress));
  if (!encryptedKey) throw new Error("No agent wallet key found for this vault");

  // Decrypt with old secret
  const privateKey = await decryptPrivateKey(encryptedKey, oldSecret, vaultAddress);

  // Re-encrypt with new secret (and new per-vault derivation)
  const newEncryptedKey = await encryptPrivateKey(privateKey, newSecret, vaultAddress);
  await kv.put(walletKeyKey(vaultAddress), newEncryptedKey);

  console.log(`[AgentWallet] Rotated key for vault ${vaultAddress}`);
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
  // Clean up reverse lookup before deleting the wallet info
  const info = await getAgentWalletInfo(kv, vaultAddress);
  const deletions = [
    kv.delete(walletInfoKey(vaultAddress)),
    kv.delete(walletKeyKey(vaultAddress)),
  ];
  if (info?.address) {
    deletions.push(kv.delete(`agent-reverse:${info.address.toLowerCase()}`));
  }
  await Promise.all(deletions);
  console.log(`[AgentWallet] Deleted wallet for vault ${vaultAddress}`);
}
