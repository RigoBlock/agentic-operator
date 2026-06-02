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
