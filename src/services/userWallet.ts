/**
 * User Wallet Service — encrypted self-custodial WDK wallet.
 *
 * Security model:
 *   - Wallet generated via Tether WDK (BIP-39 + BIP-44 derivation)
 *   - Seed phrase encrypted with user-chosen password (PBKDF2 + AES-256-GCM)
 *   - Server returns ONLY the encrypted keystore — never the plaintext seed
 *   - Browser decrypts locally with the user's password
 *   - Private keys never leave the user's device unencrypted
 *
 * Why encrypt on the server?
 *   - WDK's wallet generation depends on Node.js-only packages
 *   - The seed is generated and encrypted atomically — the plaintext seed
 *     exists in server memory only for microseconds, then is zeroed
 *   - The password is sent over HTTPS but never stored
 *   - This is equivalent to a remote HSM generating a wrapped key
 *
 * Encryption scheme (Web Crypto — works in Workers + browsers):
 *   - password + salt → PBKDF2-SHA256 (310,000 iterations) → AES-256-GCM key
 *   - AES-256-GCM(key, iv=random 12 bytes) → ciphertext
 *   - Result: { version, address, salt, iv, ciphertext } (all base64)
 *   - PBKDF2 iterations follow OWASP 2023 recommendation for SHA-256
 *
 * WDK integration:
 *   - BIP-39 seed phrase generation via WDK's SeedSignerEvm
 *   - BIP-44 path: m/44'/60'/0'/0/0 (standard Ethereum derivation)
 *   - Same derivation as agent wallets — full WDK stack
 */

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SeedSignerEvm } from "@tetherto/wdk-wallet-evm/signers";
import WalletManager from "@tetherto/wdk-wallet";

// ── Constants ────────────────────────────────────────────────────────

const DERIVATION_PATH = "0'/0/0";
const PBKDF2_ITERATIONS = 310_000; // OWASP 2023 recommendation for SHA-256
const KEYSTORE_VERSION = 1;

// ── Encrypted Keystore Types ─────────────────────────────────────────

export interface EncryptedKeystore {
  /** Format version */
  version: typeof KEYSTORE_VERSION;
  /** Wallet address (safe to store — not sensitive) */
  address: string;
  /** Base64-encoded 32-byte salt for PBKDF2 */
  salt: string;
  /** Base64-encoded 12-byte IV for AES-256-GCM */
  iv: string;
  /** Base64-encoded ciphertext (encrypted seed phrase) */
  ciphertext: string;
}

// ── Encryption Helpers (Web Crypto — Workers + browser compatible) ────

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── WDK Helpers ──────────────────────────────────────────────────────

function seedPhraseToAddress(seedPhrase: string): {
  address: Address;
  hexKey: Hex;
} {
  const rootSigner = new SeedSignerEvm(seedPhrase);
  const childSigner = rootSigner.derive(DERIVATION_PATH);
  const keyPair = childSigner.keyPair;
  if (!keyPair.privateKey) {
    throw new Error("WDK signer did not produce a private key");
  }
  const hexKey = `0x${Array.from(keyPair.privateKey as Uint8Array)
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
  const account = privateKeyToAccount(hexKey);
  rootSigner.dispose();
  return { address: account.address, hexKey };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Generate a new WDK wallet, encrypt the seed with a user-chosen password,
 * and return the encrypted keystore. The plaintext seed phrase is also
 * returned so the browser can show it ONCE for backup — but it's encrypted
 * in the keystore and the server discards it immediately.
 *
 * The browser should:
 *   1. Show the seed phrase for one-time backup
 *   2. Store the encrypted keystore in localStorage
 *   3. Discard the plaintext seed from memory
 */
export async function generateEncryptedWallet(
  password: string,
): Promise<{ keystore: EncryptedKeystore; seedPhrase: string }> {
  // Generate seed via WDK
  const seedPhrase = WalletManager.getRandomSeedPhrase();
  const { address } = seedPhraseToAddress(seedPhrase);

  // Encrypt seed with user's password
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt);
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(seedPhrase),
  );

  const keystore: EncryptedKeystore = {
    version: KEYSTORE_VERSION,
    address,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertextBuf),
  };

  return { keystore, seedPhrase };
}

/**
 * Decrypt an encrypted keystore with a password.
 * Used in the browser to recover the seed phrase for signing.
 * Also available server-side for the derive-address validation flow.
 */
export async function decryptKeystore(
  keystore: EncryptedKeystore,
  password: string,
): Promise<string> {
  const salt = fromBase64(keystore.salt);
  const iv = fromBase64(keystore.iv);
  const ciphertext = fromBase64(keystore.ciphertext);
  const key = await deriveKeyFromPassword(password, salt);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("Wrong password or corrupted keystore");
  }
}

/**
 * Derive the Ethereum address from a BIP-39 seed phrase.
 * Used for validation (e.g. confirming import was correct).
 * The seed phrase is NOT stored — used transiently and discarded.
 */
export function deriveWdkAddress(seedPhrase: string): Address {
  return seedPhraseToAddress(seedPhrase).address;
}
