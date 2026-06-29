/**
 * Pending-transaction fast-path tests.
 *
 * Verifies that common "is my transaction stuck?" questions are routed directly
 * to the check_pending_tx tool, and that the LLM can still reach the same tool
 * via the always-available CORE_TOOLS when the regex does not match.
 */
import { describe, it, expect } from "vitest";
import { tryFastPathPendingTx } from "../src/llm/client.js";
import { TOOL_DEFINITIONS } from "../src/llm/tools.js";
import { CORE_TOOLS, DOMAIN_TOOLS } from "../src/llm/prompts.js";

describe("tryFastPathPendingTx", () => {
  const matches = [
    "do I have a stuck sponsored transaction on alchemy?",
    "status of my pending transaction",
    "is my trade still pending?",
    "what happened to my swap?",
    "where is my transaction?",
    "did my trade go through?",
    "my swap is stuck",
    "status",
  ];

  for (const msg of matches) {
    it(`matches "${msg}"`, () => {
      const result = tryFastPathPendingTx(msg);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("check_pending_tx");
      expect(result!.args).toEqual({});
    });
  }

  const nonMatches = [
    "swap 1 ETH for USDC",
    "what is my balance?",
    "set up delegation",
  ];

  for (const msg of nonMatches) {
    it(`does not match "${msg}"`, () => {
      const result = tryFastPathPendingTx(msg);
      expect(result).toBeNull();
    });
  }
});

describe("check_pending_tx tool availability", () => {
  it("is defined in TOOL_DEFINITIONS", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toContain("check_pending_tx");
  });

  it("is in CORE_TOOLS so it is always available to the LLM", () => {
    expect(CORE_TOOLS).toContain("check_pending_tx");
  });

  it("is in the delegation domain", () => {
    expect(DOMAIN_TOOLS.delegation).toContain("check_pending_tx");
  });
});
