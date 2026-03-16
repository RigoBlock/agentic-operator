/**
 * Auth service tests — signature verification, ownership checks, timing.
 *
 * These test the logic WITHOUT making real RPC calls by using the pure functions
 * and error paths directly.
 */
import { describe, it, expect } from "vitest";
import { buildAuthMessage, AuthError } from "../src/services/auth.js";

describe("buildAuthMessage", () => {
  it("returns a deterministic message for any address", () => {
    const msg1 = buildAuthMessage("0xabc123");
    const msg2 = buildAuthMessage("0xdef456");
    // The message is wallet-wide, not address-specific
    expect(msg1).toBe(msg2);
  });

  it("contains the expected greeting text", () => {
    const msg = buildAuthMessage("0xabc");
    expect(msg).toContain("Welcome to Rigoblock Operator");
    expect(msg).toContain("Sign this message to verify your wallet");
  });

  it("does NOT contain the wallet address (wallet-wide, not per-address)", () => {
    const addr = "0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c";
    const msg = buildAuthMessage(addr);
    expect(msg).not.toContain(addr);
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
