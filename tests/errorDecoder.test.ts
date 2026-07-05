/**
 * Revert-data decoder tests.
 */
import { describe, it, expect } from "vitest";
import { decodeRevertData, extractRevertData } from "../src/services/errorDecoder.js";

describe("decodeRevertData", () => {
  it("decodes Error(string) revert messages", () => {
    // Error(string) selector = 0x08c379a0 + offset + length + "hello"
    const data = "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000568656c6c6f000000000000000000000000000000000000000000000000000000";
    const decoded = decodeRevertData(data);
    expect(decoded).toContain("hello");
  });

  it("decodes NavImpactTooHigh with sync-specific guidance", () => {
    // NavImpactTooHigh() selector = 0x3471741b
    const data = "0x3471741b";
    const decoded = decodeRevertData(data);
    expect(decoded).toBeTruthy();
    expect(decoded).toMatch(/NavImpactTooHigh/i);
    expect(decoded).toMatch(/virtual supply is not reduced/i);
  });

  it("decodes EffectiveSupplyTooLow", () => {
    const data = "0x0f6e887f";
    const decoded = decodeRevertData(data);
    expect(decoded).toBeTruthy();
    expect(decoded).toMatch(/EffectiveSupplyTooLow/i);
  });

  it("decodes OutputAmountTooLow", () => {
    const data = "0xd99e07af";
    const decoded = decodeRevertData(data);
    expect(decoded).toBeTruthy();
    expect(decoded).toMatch(/OutputAmountTooLow/i);
  });

  it("returns null for invalid hex", () => {
    expect(decodeRevertData("")).toBeNull();
    expect(decodeRevertData("not hex")).toBeNull();
    expect(decodeRevertData("0x")).toBeNull();
  });
});

describe("extractRevertData", () => {
  it("extracts revert data hex from error messages", () => {
    const msg = "execution reverted: revert data: 0x3471741b";
    expect(extractRevertData(msg)).toBe("0x3471741b");
  });

  it("returns null when no revert data is present", () => {
    expect(extractRevertData("some random error")).toBeNull();
  });
});
