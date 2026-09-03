/**
 * Auth service tests — signature verification, ownership checks, timing.
 *
 * These test the logic WITHOUT making real RPC calls by using the pure functions
 * and error paths directly.
 */
import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildAuthMessage, AuthError, verifyOperatorSignatureOnly } from "../src/services/auth.js";

describe("buildAuthMessage", () => {
  it("returns a deterministic legacy message for any address when no timestamp", () => {
    const msg1 = buildAuthMessage("0xabc123");
    const msg2 = buildAuthMessage("0xdef456");
    // The message is wallet-wide, not address-specific
    expect(msg1).toBe(msg2);
  });

  it("includes the timestamp when provided", () => {
    const ts = 1741700000000;
    const msg = buildAuthMessage("0xabc", ts);
    expect(msg).toContain("Welcome to Rigoblock Operator");
    expect(msg).toContain("Sign this message to verify your wallet");
    expect(msg).toContain(`Timestamp: ${ts}`);
  });

  it("does NOT contain the wallet address (wallet-wide, not per-address)", () => {
    const addr = "0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c";
    const msg = buildAuthMessage(addr);
    expect(msg).not.toContain(addr);
  });

  it("legacy and timestamped messages are different", () => {
    const legacy = buildAuthMessage("0xabc");
    const timestamped = buildAuthMessage("0xabc", 1741700000000);
    expect(legacy).not.toBe(timestamped);
  });
});

describe("AuthError", () => {
  it("has correct name and status", () => {
    const err = new AuthError("test msg", 401);
    expect(err.name).toBe("AuthError");
    expect(err.status).toBe(401);
    expect(err.message).toBe("test msg");
    expect(err).toBeInstanceOf(Error);
  });

  it("supports 403 status", () => {
    const err = new AuthError("forbidden", 403);
    expect(err.status).toBe(403);
  });
});

describe("verifyOperatorSignatureOnly", () => {
  it("rejects missing parameters", async () => {
    expect(await verifyOperatorSignatureOnly("", "0x123", Date.now())).toBe(false);
    expect(await verifyOperatorSignatureOnly("0xabc", "", Date.now())).toBe(false);
    expect(await verifyOperatorSignatureOnly("0xabc", "0x123", NaN)).toBe(false);
  });

  it("rejects non-integer timestamps", async () => {
    expect(await verifyOperatorSignatureOnly("0xA0F9C380ad1E1be09046319fd907335B2B452B37", "0x123", 1.5)).toBe(false);
    expect(await verifyOperatorSignatureOnly("0xA0F9C380ad1E1be09046319fd907335B2B452B37", "0x123", Infinity)).toBe(false);
    expect(await verifyOperatorSignatureOnly("0xA0F9C380ad1E1be09046319fd907335B2B452B37", "0x123", NaN)).toBe(false);
  });

  it("rejects expired timestamps", async () => {
    const expired = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    expect(await verifyOperatorSignatureOnly("0xA0F9C380ad1E1be09046319fd907335B2B452B37", "0x123", expired)).toBe(false);
  });

  it("rejects future timestamps", async () => {
    const future = Date.now() + 2 * 60 * 1000; // 2 minutes from now
    expect(await verifyOperatorSignatureOnly("0xA0F9C380ad1E1be09046319fd907335B2B452B37", "0x123", future)).toBe(false);
  });

  it("rejects invalid address format", async () => {
    expect(await verifyOperatorSignatureOnly("0xnotanaddress", "0x123", Date.now())).toBe(false);
    expect(await verifyOperatorSignatureOnly("0x123", "0x123", Date.now())).toBe(false);
  });

  it("rejects invalid signature format", async () => {
    const validAddr = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";
    expect(await verifyOperatorSignatureOnly(validAddr, "0xbad_sig", Date.now())).toBe(false);
    expect(await verifyOperatorSignatureOnly(validAddr, "tooshort", Date.now())).toBe(false);
  });

  it("rejects signature from wrong signer", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    const victimAddr = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";
    const ts = Date.now();
    const msg = buildAuthMessage(victimAddr, ts);
    const sig = await attacker.signMessage({ message: msg });
    expect(await verifyOperatorSignatureOnly(victimAddr, sig, ts)).toBe(false);
  });

  it("accepts a valid signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const msg = buildAuthMessage(account.address, ts);
    const sig = await account.signMessage({ message: msg });
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
  });
});

describe("auth timestamp anti-replay (F3)", () => {
  // Each test uses a fresh random account — the anti-replay store is keyed by
  // address and module-global, so sharing an address across tests would make
  // later tests depend on earlier ones.

  async function signFor(account: ReturnType<typeof privateKeyToAccount>, ts: number) {
    const msg = buildAuthMessage(account.address, ts);
    return account.signMessage({ message: msg });
  }

  it("rejects replay of an already-consumed (address, sig, timestamp) triple", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const sig = await signFor(account, ts);
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
    // Exact replay — same signature, same timestamp — must now fail.
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(false);
  });

  it("rejects an older timestamp after a newer one was consumed", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const tsNew = Date.now();
    const tsOld = tsNew - 60_000;
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, tsNew), tsNew)).toBe(true);
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, tsOld), tsOld)).toBe(false);
  });

  it("rejects an equal timestamp with a fresh valid signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, ts), ts)).toBe(true);
    // A NEW signature over the SAME timestamp is still a replay — the timestamp
    // must be strictly increasing per address.
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, ts), ts)).toBe(false);
  });

  it("accepts a newer timestamp after an older one was consumed", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const tsOld = Date.now() - 120_000;
    const tsNew = Date.now();
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, tsOld), tsOld)).toBe(true);
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, tsNew), tsNew)).toBe(true);
  });

  it("tracks consumed timestamps independently per address", async () => {
    const accountA = privateKeyToAccount(generatePrivateKey());
    const accountB = privateKeyToAccount(generatePrivateKey());
    const tsA = Date.now();
    const tsB = tsA - 3_600_000; // B's timestamp is much older than A's
    expect(await verifyOperatorSignatureOnly(accountA.address, await signFor(accountA, tsA), tsA)).toBe(true);
    expect(await verifyOperatorSignatureOnly(accountB.address, await signFor(accountB, tsB), tsB)).toBe(true);
    // A cannot replay its old timestamp...
    expect(await verifyOperatorSignatureOnly(accountA.address, await signFor(accountA, tsA), tsA)).toBe(false);
    // ...but B's window is unaffected by A's.
    const tsB2 = tsB + 1;
    expect(await verifyOperatorSignatureOnly(accountB.address, await signFor(accountB, tsB2), tsB2)).toBe(true);
  });

  it("persists the consumed timestamp to KV when available", async () => {
    const { withEnv } = await import("../src/services/envContext.js");
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
        store.set(key, value);
      },
      delete: async (key: string) => { store.delete(key); },
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;

    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const env = { KV: kv } as any;
    await withEnv(env, async () => {
      expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, ts), ts)).toBe(true);
    });
    expect(store.get(`auth:ts:${account.address.toLowerCase()}`)).toBe(String(ts));

    // A second verification of the same triple fails even in a fresh async
    // scope, because KV (not just the in-memory mirror) recorded the timestamp.
    await withEnv(env, async () => {
      expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, ts), ts)).toBe(false);
    });
  });
});
