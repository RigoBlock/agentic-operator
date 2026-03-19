/**
 * Agent Wallet Service — per-vault EOA wallet management with Tether WDK.
 *
 * Uses Tether's WDK (`@tetherto/wdk-wallet-evm`) for BIP-39 seed phrase
 * generation and BIP-44 HD key derivation. The seed phrase is encrypted
 * with AES-256-GCM using a **per-vault derived key**:
 *
 *   encryptionKey = HKDF(AGENT_WALLET_SECRET, salt=vaultAddress)
 *
 * This means:
 *   - Compromising one vault's encrypted blob doesn't help with others
 *   - Each vault has a cryptographically independent encryption key
 *   - Key versioning allows safe rotation of the master secret
 *
 * WDK integration (v2 wallets):
 *   - BIP-39 mnemonic generated via WDK's SeedSignerEvm
 *   - BIP-44 path: m/44'/60'/0'/0/0 (standard Ethereum derivation)
 *   - HD key hierarchy: one seed → deterministic child keys
 *   - BIP-39 seed phrase stored encrypted (not raw private key)
 *   - Memory-safe key handling: WDK zeros private key buffers on dispose()
 *
 * Legacy support (v0–v1 wallets):
 *   - Random private key generated via viem's generatePrivateKey()
 *   - Raw private key stored encrypted
 *   - Existing wallets continue working — loaded via viem as before
 *   - No migration needed: old wallets stay on legacy, new wallets use WDK
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
// WDK: BIP-39 seed generation + BIP-44 HD key derivation
import { SeedSignerEvm } from "@tetherto/wdk-wallet-evm/signers";
import WalletManager from "@tetherto/wdk-wallet";

/** Current encryption version — v2 = WDK seed phrase storage */
const CURRENT_KEY_VERSION = 2;

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
async function deriveVaultKey(secret: string, vaultAddress: string, version: number = CURRENT_KEY_VERSION): Promise<CryptoKey> {
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
      info: encoder.encode(`agentic-operator-wallet-v${version}`),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Stored format: JSON { v: keyVersion, d: base64(iv + ciphertext), t: type } */
interface EncryptedKeyEnvelope {
  v: number;
  d: string;
  /** Key type: "seed" (WDK BIP-39 mnemonic) or "privkey" (raw hex). Absent = privkey (legacy). */
  t?: "seed" | "privkey";
}

/** Encrypt a secret (private key or seed phrase). Returns JSON envelope. */
async function encryptSecret(
  secret: string,
  masterSecret: string,
  vaultAddress: string,
  type: "seed" | "privkey",
): Promise<string> {
  const key = await deriveVaultKey(masterSecret, vaultAddress);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(secret);

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
    t: type,
  };

  return JSON.stringify(envelope);
}

/** Decrypt a secret from the envelope format. Returns { value, type }. */
async function decryptSecret(
  envelopeStr: string,
  masterSecret: string,
  vaultAddress: string,
): Promise<{ value: string; type: "seed" | "privkey" }> {
  // Support both old format (raw base64) and new envelope format
  let envelope: EncryptedKeyEnvelope;
  try {
    envelope = JSON.parse(envelopeStr);
  } catch {
    // Legacy format: raw base64 without version envelope
    envelope = { v: 0, d: envelopeStr };
  }

  // For v0 (legacy), use the old global derivation; for v1+, use per-vault
  // CRITICAL: pass envelope.v (not CURRENT_KEY_VERSION) so v1 wallets
  // decrypt with the same HKDF info they were encrypted with.
  const key = envelope.v >= 1
    ? await deriveVaultKey(masterSecret, vaultAddress, envelope.v)
    : await deriveLegacyKey(masterSecret);

  const combined = Uint8Array.from(atob(envelope.d), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );

  const value = new TextDecoder().decode(decrypted);
  // v0–v1 are always raw private keys; v2+ with t="seed" are BIP-39 mnemonics
  const type = envelope.t === "seed" ? "seed" : "privkey";
  return { value, type };
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

// ── WDK helpers ───────────────────────────────────────────────────────

/** BIP-44 derivation path for the first Ethereum account */
const WDK_DERIVATION_PATH = "0'/0/0";

/**
 * Derive a viem PrivateKeyAccount from a WDK BIP-39 seed phrase.
 * Uses WDK's SeedSignerEvm for BIP-44 HD derivation, then extracts the
 * raw private key to create a viem account (needed for tx signing in the Worker).
 */
function seedToViemAccount(seedPhrase: string): { account: PrivateKeyAccount; signer: InstanceType<typeof SeedSignerEvm> } {
  const rootSigner = new SeedSignerEvm(seedPhrase);
  const childSigner = rootSigner.derive(WDK_DERIVATION_PATH);

  // Extract raw private key from WDK's key pair
  const keyPair = childSigner.keyPair;
  if (!keyPair.privateKey) {
    throw new Error("WDK signer did not produce a private key");
  }

  // Convert Uint8Array to hex string for viem
  const hexKey = `0x${Array.from(keyPair.privateKey as Uint8Array).map((b: number) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
  const account = privateKeyToAccount(hexKey);

  return { account, signer: rootSigner };
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
 * Create a new agent wallet for a vault using Tether WDK.
 *
 * Generates a BIP-39 seed phrase via WDK, derives the first Ethereum
 * account via BIP-44 (m/44'/60'/0'/0/0), encrypts the seed phrase with
 * a per-vault derived key, and stores both the wallet info and encrypted
 * seed in KV.
 *
 * If a wallet already exists for this vault (legacy or WDK), returns it.
 */
export async function createAgentWallet(
  kv: KVNamespace,
  vaultAddress: string,
  secret: string,
): Promise<AgentWalletInfo> {
  // Check if one already exists (legacy or WDK — don't overwrite)
  const existing = await getAgentWalletInfo(kv, vaultAddress);
  if (existing) return existing;

  // Generate BIP-39 seed phrase via WDK
  const seedPhrase = WalletManager.getRandomSeedPhrase();

  // Derive the first Ethereum account via WDK's BIP-44 HD derivation
  const { account, signer } = seedToViemAccount(seedPhrase);

  const info: AgentWalletInfo = {
    address: account.address,
    vaultAddress: vaultAddress.toLowerCase() as Address,
    delegatedChains: [],
    createdAt: Date.now(),
  };

  // Encrypt the seed phrase (not the raw private key) with per-vault key
  const encryptedSeed = await encryptSecret(seedPhrase, secret, vaultAddress, "seed");
  await Promise.all([
    kv.put(walletInfoKey(vaultAddress), JSON.stringify(info)),
    kv.put(walletKeyKey(vaultAddress), encryptedSeed),
    // Reverse lookup: agent address → vault address (used by gas-policy webhook)
    kv.put(`agent-reverse:${account.address.toLowerCase()}`, vaultAddress.toLowerCase()),
  ]);

  // Zero private key material from WDK signer memory
  signer.dispose();

  console.log(`[AgentWallet] Created WDK wallet ${account.address} for vault ${vaultAddress} (BIP-44 m/44'/60'/0'/0/0)`);
  return info;
}

/**
 * Load the agent wallet account (with signing capability) for a vault.
 * Supports both WDK wallets (v2, seed phrase) and legacy wallets (v0–v1, raw private key).
 * Returns null if no agent wallet exists.
 */
export async function loadAgentWalletAccount(
  kv: KVNamespace,
  vaultAddress: string,
  secret: string,
): Promise<PrivateKeyAccount | null> {
  const encryptedKey = await kv.get(walletKeyKey(vaultAddress));
  if (!encryptedKey) return null;

  const { value, type } = await decryptSecret(encryptedKey, secret, vaultAddress);

  if (type === "seed") {
    // WDK wallet: derive account from BIP-39 seed phrase
    const { account, signer } = seedToViemAccount(value);
    // Zero the root signer's key material after extraction
    signer.dispose();
    return account;
  }

  // Legacy wallet: raw private key
  return privateKeyToAccount(value as Hex);
}

/**
 * Rotate the encryption key for a vault's agent wallet.
 *
 * Decrypts with the old secret, re-encrypts with the new secret.
 * Preserves the key type (seed or privkey) during rotation.
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

  // Decrypt with old secret (auto-detects seed vs privkey)
  const { value, type } = await decryptSecret(encryptedKey, oldSecret, vaultAddress);

  // Re-encrypt with new secret, preserving the original type
  const newEncryptedKey = await encryptSecret(value, newSecret, vaultAddress, type);
  await kv.put(walletKeyKey(vaultAddress), newEncryptedKey);

  console.log(`[AgentWallet] Rotated key for vault ${vaultAddress} (type=${type})`);
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
