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

describe("auth session semantics (F3)", () => {
  // Security model: verification is IDEMPOTENT within the 24h validity
  // window. The frontend caches one wallet signature per address (localStorage,
  // 23h) and reuses it for every request — reads AND delegated executions —
  // so a still-valid (address, signature, timestamp) triple must be accepted
  // on every presentation. Replay protection comes from the timestamp being
  // cryptographically bound into the signed message (a captured signature
  // cannot be replayed with a different/fresher timestamp) and from the
  // bounded window. Single-use semantics were rejected because they break
  // the cached session and add no real security.

  async function signFor(account: ReturnType<typeof privateKeyToAccount>, ts: number) {
    const msg = buildAuthMessage(account.address, ts);
    return account.signMessage({ message: msg });
  }

  it("accepts the same cached credential on every presentation (session reuse)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const sig = await signFor(account, ts);
    // Simulate the frontend's cached session being presented repeatedly —
    // e.g. x402 middleware then route handler, then the next chat message.
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
  });

  it("accepts different credentials from the same wallet in any order", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const tsNew = Date.now();
    const tsOld = tsNew - 60_000;
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, tsNew), tsNew)).toBe(true);
    // An older timestamp with its own valid signature is a separate valid
    // credential — e.g. two devices holding the same wallet.
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, tsOld), tsOld)).toBe(true);
  });

  it("rejects a signature replayed against a different timestamp", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const sig = await signFor(account, ts);
    // The attacker moves the captured credential to a fresh timestamp: the
    // signature no longer matches the signed message.
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts + 1)).toBe(false);
    expect(await verifyOperatorSignatureOnly(account.address, sig, Date.now())).toBe(false);
  });

  it("rejects a foreign signature over the victim's message", async () => {
    const attacker = privateKeyToAccount(generatePrivateKey());
    const victim = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    // Attacker signs the victim-addressed message with their own key.
    const sig = await signFor(attacker, ts);
    expect(await verifyOperatorSignatureOnly(victim.address, sig, ts)).toBe(false);
  });

  it("still rejects expired and future credentials", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const expired = Date.now() - 25 * 60 * 60 * 1000;
    const future = Date.now() + 5 * 60 * 1000;
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, expired), expired)).toBe(false);
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, future), future)).toBe(false);
  });
});

describe("middleware + route double-verification (no consumption side effects)", () => {
  // A single logical request verifies the same credentials twice — the x402
  // middleware verifies the X-Auth-* headers, then the route handler calls
  // verifyOperatorAuth with the same signature. With idempotent verification
  // this is naturally safe, with or without any request-scope wrapper.

  async function signFor(account: ReturnType<typeof privateKeyToAccount>, ts: number) {
    const msg = buildAuthMessage(account.address, ts);
    return account.signMessage({ message: msg });
  }

  it("accepts the same triple verified twice in sequence", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const sig = await signFor(account, ts);
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
    expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
  });

  it("accepts newer credentials after older ones, and vice versa", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts1 = Date.now();
    const ts2 = ts1 + 1_000;
    const sig1 = await signFor(account, ts1);
    expect(await verifyOperatorSignatureOnly(account.address, sig1, ts1)).toBe(true);
    expect(await verifyOperatorSignatureOnly(account.address, await signFor(account, ts2), ts2)).toBe(true);
    // The older credential is still valid within its window — no ordering.
    expect(await verifyOperatorSignatureOnly(account.address, sig1, ts1)).toBe(true);
  });

  it("verifies credentials independently per address", async () => {
    const accountA = privateKeyToAccount(generatePrivateKey());
    const accountB = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    expect(await verifyOperatorSignatureOnly(accountA.address, await signFor(accountA, ts), ts)).toBe(true);
    expect(await verifyOperatorSignatureOnly(accountB.address, await signFor(accountB, ts), ts)).toBe(true);
  });
});


describe("verification is side-effect free (regression: cached-session re-sign loop)", () => {
  // The production re-authentication loop was caused by verification CONSUMING
  // the credential (recording it in KV / an in-memory store and rejecting
  // reuse), while the frontend legitimately re-presents its cached session
  // signature for 23h. These tests pin the contract: verifying a signature
  // never writes state, so a valid credential can be presented any number of
  // times within its window.

  async function signFor(account: ReturnType<typeof privateKeyToAccount>, ts: number) {
    const msg = buildAuthMessage(account.address, ts);
    return account.signMessage({ message: msg });
  }

  it("never writes to KV when verifying a valid credential", async () => {
    const { withEnv } = await import("../src/services/envContext.js");
    const writes: string[] = [];
    const kv = {
      get: async () => null,
      put: async (key: string) => { writes.push(key); },
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;

    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const sig = await signFor(account, ts);
    await withEnv({ KV: kv } as any, async () => {
      expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
      expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
    });
    expect(writes).toEqual([]);
  });

  it("accepts a cached credential across any number of simulated requests", async () => {
    // Models the frontend loop: one cached (signature, timestamp) pair sent
    // with every chat message, twice per request (x402 middleware + route).
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const sig = await signFor(account, ts);
    for (let request = 0; request < 5; request++) {
      expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
      expect(await verifyOperatorSignatureOnly(account.address, sig, ts)).toBe(true);
    }
  });
});
