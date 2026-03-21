/**
 * Agent Wallet Service — per-vault EOA wallet management with Tether WDK.
 *
 * Uses Tether's WDK (`@tetherto/wdk-wallet-evm`) for BIP-39 seed phrase
 * generation and BIP-44 HD key derivation.
 *
 * Encryption at rest (v3, current):
 *   Uses Tether `@tetherto/wdk-secret-manager` (XSalsa20-Poly1305 via libsodium).
 *   Key: PBKDF2-SHA256(AGENT_WALLET_SECRET + vault-scoped salt, 100k iterations).
 *   The vault address is embedded as a prefix in the passkey so each vault's
 *   encryption key is cryptographically independent.
 *
 * Legacy support (v0–v2 wallets, AES-256-GCM via Web Crypto):
 *   Existing wallets continue working. Decrypted with AES-GCM, re-encrypted
 *   with WdkSecretManager on next rotation.
 *
 * Security model:
 *   - All key generation: WDK (BIP-39/BIP-44, memory-zeroed on dispose)
 *   - All new encryption: WdkSecretManager (XSalsa20-Poly1305)
 *   - Private keys never leave the Worker runtime unencrypted
 *   - Each vault has a unique agent wallet (no key reuse)
 *   - Per-vault passkey prefix isolates compromise blast radius
 *   - The EIP-7702 delegation framework limits what the agent wallet can do
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
// WDK: XSalsa20-Poly1305 encryption at rest
import { WdkSecretManager, wdkSaltGenerator } from "@tetherto/wdk-secret-manager";

/** Current encryption version — v3 = WdkSecretManager (XSalsa20-Poly1305) */
const CURRENT_KEY_VERSION = 3;

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

/** Stored format: JSON { v: keyVersion, d: base64(data), t: type, s?: salt(hex) } */
interface EncryptedKeyEnvelope {
  v: number;
  d: string;
  /** Key type: "seed" (WDK BIP-39 mnemonic) or "privkey" (raw hex). Absent = privkey (legacy). */
  t?: "seed" | "privkey";
  /** WdkSecretManager salt (hex, 16 bytes) — only present in v3+ */
  s?: string;
}

// ── WdkSecretManager helpers (v3 — XSalsa20-Poly1305) ─────────────────

/**
 * Build a per-vault passkey for WdkSecretManager.
 * Embeds the vault address so each vault gets a distinct encryption context
 * even if the same master secret is used.
 */
function vaultPasskey(masterSecret: string, vaultAddress: string): string {
  return `${masterSecret}:${vaultAddress.toLowerCase()}`;
}

/**
 * Encrypt a BIP-39 seed phrase using WdkSecretManager (XSalsa20-Poly1305).
 *
 * Flow: mnemonic → 16-byte entropy → WdkSecretManager internal PBKDF2 + XSalsa20 →
 * encryptedEntropy buffer stored as hex. On decrypt: entropy → mnemonic.
 * This stays within WdkSecretManager's 64-byte payload limit (entropy is always 16 bytes).
 */
async function encryptWithWdk(
  seedPhrase: string,
  masterSecret: string,
  vaultAddress: string,
): Promise<string> {
  const salt = wdkSaltGenerator.generate() as Buffer;
  const passkey = vaultPasskey(masterSecret, vaultAddress);
  const sm = new WdkSecretManager(passkey, salt);
  // Convert 12-word mnemonic → 16-byte BIP-39 entropy
  const entropy = sm.mnemonicToEntropy(seedPhrase) as Buffer;
  // generateAndEncrypt encrypts the entropy with PBKDF2-derived key + XSalsa20-Poly1305
  // (sodium_memzero zeroes out the entropy buffer after encrypting — intentional)
  const { encryptedEntropy } = await sm.generateAndEncrypt(entropy);
  const envelope: EncryptedKeyEnvelope = {
    v: CURRENT_KEY_VERSION,
    d: (encryptedEntropy as Buffer).toString("hex"),
    t: "seed",
    s: salt.toString("hex"),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt a v3 (WdkSecretManager) seed envelope.
 * Reverses encryptWithWdk: encryptedEntropy → 16-byte entropy → mnemonic.
 */
function decryptWithWdk(
  envelope: EncryptedKeyEnvelope,
  masterSecret: string,
  vaultAddress: string,
): string {
  if (!envelope.s) throw new Error("Missing salt in v3 envelope");
  const salt = Buffer.from(envelope.s, "hex");
  const passkey = vaultPasskey(masterSecret, vaultAddress);
  const sm = new WdkSecretManager(passkey, salt);
  const encryptedEntropy = Buffer.from(envelope.d, "hex");
  const entropy = sm.decrypt(encryptedEntropy) as Buffer;
  return sm.entropyToMnemonic(entropy);
}

/**
 * Encrypt a seed or private key for storage.
 * v3 (current, seed only): WdkSecretManager — mnemonic → entropy → XSalsa20-Poly1305.
 * Fallback for "privkey" type: AES-256-GCM v2 (no new wallets use this path;
 * only reached during key rotation of old pre-WDK wallets).
 */
async function encryptSecret(
  secret: string,
  masterSecret: string,
  vaultAddress: string,
  type: "seed" | "privkey",
): Promise<string> {
  if (type === "seed") {
    return encryptWithWdk(secret, masterSecret, vaultAddress);
  }
  // Legacy AES-256-GCM path for raw private key wallets created before WDK integration.
  // New wallets are always BIP-39 seeds; this branch is only reached during rotation.
  const key = await deriveVaultKey(masterSecret, vaultAddress);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret),
  );
  const combined = new Uint8Array(12 + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), 12);
  const envelope: EncryptedKeyEnvelope = {
    v: 2,
    d: btoa(String.fromCharCode(...combined)),
    t: "privkey",
  };
  return JSON.stringify(envelope);
}

/** Decrypt a secret from the envelope. Handles v0–v3. Returns { value, type }. */
async function decryptSecret(
  envelopeStr: string,
  masterSecret: string,
  vaultAddress: string,
): Promise<{ value: string; type: "seed" | "privkey" }> {
  let envelope: EncryptedKeyEnvelope;
  try {
    envelope = JSON.parse(envelopeStr);
  } catch {
    // Legacy format: raw base64 without version envelope
    envelope = { v: 0, d: envelopeStr };
  }

  let value: string;

  if (envelope.v >= 3) {
    // v3: WdkSecretManager (XSalsa20-Poly1305)
    value = decryptWithWdk(envelope, masterSecret, vaultAddress);
  } else {
    // v0–v2: AES-256-GCM via Web Crypto (legacy fallback)
    const key = envelope.v >= 1
      ? await deriveVaultKey(masterSecret, vaultAddress, envelope.v)
      : await deriveLegacyKey(masterSecret);

    const combined = Uint8Array.from(atob(envelope.d), (c) => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) },
      key,
      combined.slice(12),
    );
    value = new TextDecoder().decode(decrypted);
  }

  const type = envelope.t === "seed" ? "seed" : "privkey";
  return { value, type };
}

/** Legacy key derivation (v0) — global, not per-vault. For decrypting old wallets only. */
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
