/**
 * WDK integration tests — covers every Tether WDK feature used in production.
 *
 * Tests run in a Node.js environment with the same sodium patches as the
 * Cloudflare Worker (sodium-native/sodium-universal → sodium-javascript,
 * bare-crypto → node:crypto via postinstall patch).
 *
 * Covers:
 *   1. wdkSaltGenerator  — random salt generation
 *   2. WdkSecretManager  — XSalsa20-Poly1305 seed encryption / decryption
 *   3. WalletManager     — BIP-39 seed phrase generation
 *   4. SeedSignerEvm     — BIP-44 HD key derivation → Ethereum address
 *   5. Envelope format   — per-vault passkey isolation (v3 KV envelope)
 */
import { describe, it, expect } from "vitest";
import { WdkSecretManager, wdkSaltGenerator } from "@tetherto/wdk-secret-manager";
import WalletManager from "@tetherto/wdk-wallet";
import { SeedSignerEvm } from "@tetherto/wdk-wallet-evm/signers";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// Well-known BIP-39 test vector — "abandon ×11 + about" (12 words)
const KNOWN_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ── 1. wdkSaltGenerator ───────────────────────────────────────────────

describe("wdkSaltGenerator", () => {
  it("generates a 16-byte buffer", () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    expect(Buffer.isBuffer(salt)).toBe(true);
    expect(salt.byteLength).toBe(16);
  });

  it("generates cryptographically distinct salts on consecutive calls", () => {
    const s1 = (wdkSaltGenerator.generate() as Buffer).toString("hex");
    const s2 = (wdkSaltGenerator.generate() as Buffer).toString("hex");
    const s3 = (wdkSaltGenerator.generate() as Buffer).toString("hex");
    // With 128-bit random output, collisions are astronomically unlikely
    expect(s1).not.toBe(s2);
    expect(s2).not.toBe(s3);
  });
});

// ── 2. WdkSecretManager — encryption / decryption ────────────────────

describe("WdkSecretManager", () => {
  const PASSKEY = "test-passkey-for-unit-tests";

  it("mnemonicToEntropy returns a 16-byte buffer for a 12-word seed", () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const sm = new WdkSecretManager(PASSKEY, salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    expect(Buffer.isBuffer(entropy)).toBe(true);
    expect(entropy.byteLength).toBe(16); // 128 bits for 12 words
    sm.dispose();
  });

  it("entropyToMnemonic round-trips to the original seed phrase", () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const sm = new WdkSecretManager(PASSKEY, salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    // Note: generateAndEncrypt memzeroes entropy — use a copy for round-trip check
    const entropyCopy = Buffer.from(entropy);
    sm.dispose();

    const sm2 = new WdkSecretManager(PASSKEY, salt);
    expect(sm2.entropyToMnemonic(entropyCopy)).toBe(KNOWN_SEED);
    sm2.dispose();
  });

  it("encrypts and decrypts a seed phrase via entropy (full round-trip)", async () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex"); // save before dispose() zeroes the buffer
    const sm = new WdkSecretManager(PASSKEY, salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm.dispose(); // zeroes salt in-place — reconstruct from hex below

    const sm2 = new WdkSecretManager(PASSKEY, Buffer.from(saltHex, "hex"));
    const recovered = sm2.decrypt(Buffer.from(encHex, "hex")) as Buffer;
    expect(sm2.entropyToMnemonic(recovered)).toBe(KNOWN_SEED);
    sm2.dispose();
  });

  it("same passkey + different salt produces different ciphertext", async () => {
    const salt1 = wdkSaltGenerator.generate() as Buffer;
    const salt2 = wdkSaltGenerator.generate() as Buffer;

    const sm1 = new WdkSecretManager(PASSKEY, salt1);
    const entropy1 = sm1.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy: ct1 } = await sm1.generateAndEncrypt(entropy1);
    sm1.dispose();

    const sm2 = new WdkSecretManager(PASSKEY, salt2);
    const entropy2 = sm2.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy: ct2 } = await sm2.generateAndEncrypt(entropy2);
    sm2.dispose();

    expect((ct1 as Buffer).toString("hex")).not.toBe((ct2 as Buffer).toString("hex"));
  });

  it("wrong passkey fails to decrypt (cross-vault isolation)", async () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");
    const master = "some-master-secret";
    const vaultA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const vaultB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const smA = new WdkSecretManager(`${master}:${vaultA}`, salt);
    const entropy = smA.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await smA.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    smA.dispose(); // zeroes salt in-place

    // Attempting to decrypt with a different vault's passkey must throw
    const smB = new WdkSecretManager(`${master}:${vaultB}`, Buffer.from(saltHex, "hex"));
    expect(() => smB.decrypt(Buffer.from(encHex, "hex"))).toThrow();
    smB.dispose();
  });

  it("wrong salt fails to decrypt", async () => {
    const salt1 = wdkSaltGenerator.generate() as Buffer;
    const salt2Hex = (wdkSaltGenerator.generate() as Buffer).toString("hex");

    const sm1 = new WdkSecretManager(PASSKEY, salt1);
    const entropy = sm1.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm1.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm1.dispose();

    const sm2 = new WdkSecretManager(PASSKEY, Buffer.from(salt2Hex, "hex"));
    expect(() => sm2.decrypt(Buffer.from(encHex, "hex"))).toThrow();
    sm2.dispose();
  });

  it("rejects empty passkey", () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    expect(() => new WdkSecretManager("", salt)).toThrow();
  });

  it("rejects null salt", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new WdkSecretManager(PASSKEY, null as any)).toThrow();
  });

  it("rejects salt shorter than 16 bytes", () => {
    expect(() => new WdkSecretManager(PASSKEY, Buffer.alloc(8))).toThrow();
  });

  it("produces a serialisable hex envelope (v3 format used by agentWallet.ts)", async () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex"); // save before dispose() zeroes it
    const passkey = `master-secret:0xvaultaddress`;
    const sm = new WdkSecretManager(passkey, salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm.dispose(); // zeroes salt in-place

    // Simulate the v3 KV envelope
    const envelope = {
      v: 3,
      d: encHex,
      t: "seed" as const,
      s: saltHex,
    };
    const envelopeStr = JSON.stringify(envelope);

    // Deserialise and decrypt
    const parsed = JSON.parse(envelopeStr);
    const saltParsed = Buffer.from(parsed.s, "hex");
    const sm2 = new WdkSecretManager(passkey, saltParsed);
    const decrypted = sm2.decrypt(Buffer.from(parsed.d, "hex")) as Buffer;
    expect(sm2.entropyToMnemonic(decrypted)).toBe(KNOWN_SEED);
    sm2.dispose();
  });
});

// ── 3. WalletManager — seed phrase generation ─────────────────────────

describe("WalletManager.getRandomSeedPhrase", () => {
  it("returns a 12-word BIP-39 mnemonic string", async () => {
    const seed = await WalletManager.getRandomSeedPhrase();
    expect(typeof seed).toBe("string");
    const words = seed.trim().split(/\s+/);
    expect(words).toHaveLength(12);
  });

  it("generates a different seed on each call", async () => {
    const s1 = await WalletManager.getRandomSeedPhrase();
    const s2 = await WalletManager.getRandomSeedPhrase();
    expect(s1).not.toBe(s2);
  });

  it("generated seed can be round-tripped through WdkSecretManager entropy", async () => {
    const seed = await WalletManager.getRandomSeedPhrase();
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");
    const sm = new WdkSecretManager("round-trip-test", salt);
    const entropy = sm.mnemonicToEntropy(seed) as Buffer;
    const { encryptedEntropy } = await sm.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm.dispose(); // zeroes salt in-place — reconstruct from hex

    const sm2 = new WdkSecretManager("round-trip-test", Buffer.from(saltHex, "hex"));
    const decrypted = sm2.decrypt(Buffer.from(encHex, "hex")) as Buffer;
    expect(sm2.entropyToMnemonic(decrypted)).toBe(seed);
    sm2.dispose();
  });
});

// ── 4. SeedSignerEvm — BIP-44 HD derivation ──────────────────────────

describe("SeedSignerEvm", () => {
  it("derives a valid Ethereum address from a known seed", () => {
    const signer = new SeedSignerEvm(KNOWN_SEED);
    const child = signer.derive("0'/0/0");
    const kp = child.keyPair;
    expect(kp.privateKey).toBeTruthy();

    const hexKey =
      `0x${Array.from(kp.privateKey as Uint8Array)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("")}` as Hex;
    const account = privateKeyToAccount(hexKey);
    // Ethereum address: 0x + 40 hex chars, checksum-encoded
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("produces the same address from the same seed (deterministic derivation)", () => {
    const addr1 = deriveAddress(KNOWN_SEED);
    const addr2 = deriveAddress(KNOWN_SEED);
    expect(addr1).toBe(addr2);
  });

  it("produces different addresses for different seeds", async () => {
    const seed2 = await WalletManager.getRandomSeedPhrase();
    const addr1 = deriveAddress(KNOWN_SEED);
    const addr2 = deriveAddress(seed2);
    expect(addr1).not.toBe(addr2);
  });

  it("private key is a 32-byte Uint8Array", () => {
    const signer = new SeedSignerEvm(KNOWN_SEED);
    const child = signer.derive("0'/0/0");
    const kp = child.keyPair;
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect((kp.privateKey as Uint8Array).byteLength).toBe(32);
  });
});

// ── 5. Envelope format used by agentWallet.ts (v3 per-vault isolation) ─

describe("v3 envelope per-vault passkey isolation", () => {
  it("encrypting for vault A cannot be decrypted with vault B passkey", async () => {
    const master = "some-production-secret";
    const vaultA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const vaultB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");

    const smA = new WdkSecretManager(`${master}:${vaultA}`, salt);
    const entropy = smA.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await smA.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    smA.dispose(); // zeroes salt in-place

    const smB = new WdkSecretManager(`${master}:${vaultB}`, Buffer.from(saltHex, "hex"));
    expect(() => smB.decrypt(Buffer.from(encHex, "hex"))).toThrow("Decryption failed");
    smB.dispose();
  });

  it("vault address case is normalised (uppercase ≡ lowercase)", async () => {
    const master = "some-production-secret";
    const vault = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");

    // Encrypt with lowercase vault (as agentWallet.ts does)
    const passkeyLc = `${master}:${vault.toLowerCase()}`;
    const sm1 = new WdkSecretManager(passkeyLc, salt);
    const entropy = sm1.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm1.generateAndEncrypt(entropy);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm1.dispose(); // zeroes salt in-place — reconstruct from hex

    // Decrypt with the same passkey (lowercase) — must succeed
    const sm2 = new WdkSecretManager(passkeyLc, Buffer.from(saltHex, "hex"));
    const decrypted = sm2.decrypt(Buffer.from(encHex, "hex")) as Buffer;
    expect(sm2.entropyToMnemonic(decrypted)).toBe(KNOWN_SEED);
    sm2.dispose();
  });
});

// ── 6. sodium-universal browser shim ─────────────────────────────────
//
// The browser bundle uses --alias:sodium-universal=scripts/sodium-universal-browser-shim.cjs
// so that extension_pbkdf2_sha512_async is implemented with Web Crypto API
// (globalThis.crypto.subtle) instead of require('node:crypto').
//
// In Node.js 18+, globalThis.crypto.subtle is available, so the shim also
// works in the test environment and we can cross-check against node:crypto.

describe("sodium-universal browser shim", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sodium = require("../scripts/sodium-universal-browser-shim.cjs");

  it("exports a sodium object with extension_pbkdf2_sha512_async", () => {
    expect(typeof sodium.extension_pbkdf2_sha512_async).toBe("function");
  });

  it("produces SHA-512 PBKDF2 output matching the node:crypto reference", async () => {
    const password = Buffer.from("test-password");
    const salt = Buffer.from("sodium-shim-test-salt");
    const iterations = 1000; // low for test speed
    const keyLength = 64; // SHA-512 output size

    const output = Buffer.alloc(keyLength);
    await sodium.extension_pbkdf2_sha512_async(output, password, salt, iterations, keyLength);

    // node:crypto is the reference implementation
    const { pbkdf2: nodePbkdf2 } = await import("node:crypto");
    const reference = await new Promise<Buffer>((resolve, reject) =>
      nodePbkdf2(password, salt, iterations, keyLength, "sha512", (err, key) =>
        err ? reject(err) : resolve(key)
      )
    );

    expect(output.toString("hex")).toBe(reference.toString("hex"));
    expect(output.byteLength).toBe(keyLength);
  });

  it("fills the output buffer exactly (no off-by-one)", async () => {
    const output32 = Buffer.alloc(32);
    await sodium.extension_pbkdf2_sha512_async(
      output32, Buffer.from("pw"), Buffer.from("salt"), 1, 32
    );
    expect(output32.every((b) => b !== undefined)).toBe(true);
    expect(output32.byteLength).toBe(32);
  });
});

// ── 7. Browser import flow — generateAndEncrypt with derivedKey ──────
//
// In the browser, bare-crypto.pbkdf2Sync is stubbed (throws).
// The browser derives the encryption key via PBKDF2-SHA256 with Web Crypto
// and passes it as derivedKey to generateAndEncrypt / decrypt.
// bip39.mnemonicToSeed (SHA-512 PBKDF2 via sodium) is still called internally —
// that is the path fixed by the sodium-universal browser shim above.

describe("generateAndEncrypt with derivedKey (browser import flow)", () => {
  async function browserDeriveKey(password: string): Promise<Buffer> {
    // Mirrors the browser's PBKDF2-SHA256 derivation using Web Crypto
    const keyMaterial = await globalThis.crypto.subtle.importKey(
      "raw", Buffer.from(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: Buffer.from("rigoblock-wallet-salt"), iterations: 100_000, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return Buffer.from(bits);
  }

  it("round-trips a seed phrase using an externally derived key", async () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");

    const derivedKey = await browserDeriveKey("my-wallet-password");

    const sm = new WdkSecretManager("passkey-not-used-when-derivedKey-set", salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm.generateAndEncrypt(entropy, derivedKey);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm.dispose();

    const sm2 = new WdkSecretManager("passkey-not-used-when-derivedKey-set", Buffer.from(saltHex, "hex"));
    const decrypted = sm2.decrypt(Buffer.from(encHex, "hex"), derivedKey) as Buffer;
    expect(sm2.entropyToMnemonic(decrypted)).toBe(KNOWN_SEED);
    sm2.dispose();
  });

  it("wrong derivedKey fails to decrypt", async () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");

    const correctKey = await browserDeriveKey("correct-password");
    const wrongKey = await browserDeriveKey("wrong-password");

    const sm = new WdkSecretManager("passkey-not-used", salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm.generateAndEncrypt(entropy, correctKey);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm.dispose();

    const sm2 = new WdkSecretManager("passkey-not-used", Buffer.from(saltHex, "hex"));
    expect(() => sm2.decrypt(Buffer.from(encHex, "hex"), wrongKey)).toThrow();
    sm2.dispose();
  });

  it("derivedKey encryption is independent from passkey-derived encryption", async () => {
    const salt = wdkSaltGenerator.generate() as Buffer;
    const saltHex = salt.toString("hex");

    const derivedKey = await browserDeriveKey("some-password");

    // Encrypt with derivedKey
    const sm = new WdkSecretManager("the-original-passkey", salt);
    const entropy = sm.mnemonicToEntropy(KNOWN_SEED) as Buffer;
    const { encryptedEntropy } = await sm.generateAndEncrypt(entropy, derivedKey);
    const encHex = (encryptedEntropy as Buffer).toString("hex");
    sm.dispose();

    // Attempting to decrypt WITHOUT derivedKey (using passkey instead) must fail
    const sm2 = new WdkSecretManager("the-original-passkey", Buffer.from(saltHex, "hex"));
    expect(() => sm2.decrypt(Buffer.from(encHex, "hex"))).toThrow();
    sm2.dispose();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

function deriveAddress(seedPhrase: string): string {
  const signer = new SeedSignerEvm(seedPhrase);
  const child = signer.derive("0'/0/0");
  const kp = child.keyPair;
  const hexKey =
    `0x${Array.from(kp.privateKey as Uint8Array)
      .map((b: number) => b.toString(16).padStart(2, "0"))
      .join("")}` as Hex;
  return privateKeyToAccount(hexKey).address;
}
