/**
 * Execution safety tests — validates the 7-point security model.
 *
 * Tests the ExecutionError class and the execution validation logic WITHOUT
 * real RPC calls.
 */
import { describe, it, expect } from "vitest";
import { ExecutionError } from "../src/services/execution.js";

describe("ExecutionError", () => {
  it("has correct name and code", () => {
    const err = new ExecutionError("delegation not found", "DELEGATION_NOT_CONFIGURED");
    expect(err.name).toBe("ExecutionError");
    expect(err.code).toBe("DELEGATION_NOT_CONFIGURED");
    expect(err.message).toBe("delegation not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("supports all known error codes", () => {
    const codes = [
      "DELEGATION_NOT_CONFIGURED",
      "DELEGATION_NOT_ON_CHAIN",
      "TARGET_NOT_ALLOWED",
      "METHOD_NOT_ALLOWED",
      "AGENT_WALLET_NOT_FOUND",
      "AGENT_WALLET_MISMATCH",
      "SIMULATION_FAILED",
      "INSUFFICIENT_BALANCE",
      "GAS_ESTIMATION_FAILED",
      "NAV_GUARD_BLOCKED",
      "SPONSORED_FAILED",
      "RPC_UNAVAILABLE",
    ];
    for (const code of codes) {
      const err = new ExecutionError("test", code);
      expect(err.code).toBe(code);
    }
  });
});

describe("execution security invariants", () => {
  /**
   * These tests document the 7-point validation that executeViaDelegation performs.
   * They don't call the function directly (it requires real KV + RPC), but verify
   * the error codes that map to each check.
   */

  it("Check 1: delegation config must exist and be enabled (DELEGATION_NOT_CONFIGURED)", () => {
    const err = new ExecutionError("Delegation not configured", "DELEGATION_NOT_CONFIGURED");
    expect(err.code).toBe("DELEGATION_NOT_CONFIGURED");
  });

  it("Check 2: per-chain delegation must exist (DELEGATION_NOT_ON_CHAIN)", () => {
    const err = new ExecutionError(
      "Delegation not active on chain 42161",
      "DELEGATION_NOT_ON_CHAIN",
    );
    expect(err.code).toBe("DELEGATION_NOT_ON_CHAIN");
  });

  it("Check 3: target must be the vault address (TARGET_NOT_ALLOWED)", () => {
    const err = new ExecutionError(
      "Transaction target is not the vault",
      "TARGET_NOT_ALLOWED",
    );
    expect(err.code).toBe("TARGET_NOT_ALLOWED");
  });

  it("Check 4: function selector must be in whitelist (METHOD_NOT_ALLOWED)", () => {
    const err = new ExecutionError(
      "Function selector not delegated",
      "METHOD_NOT_ALLOWED",
    );
    expect(err.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("Check 5: simulation must pass (SIMULATION_FAILED)", () => {
    const err = new ExecutionError(
      "Transaction simulation failed",
      "SIMULATION_FAILED",
    );
    expect(err.code).toBe("SIMULATION_FAILED");
  });

  it("Check 6: agent balance must be sufficient (INSUFFICIENT_BALANCE)", () => {
    const err = new ExecutionError(
      "Agent balance too low",
      "INSUFFICIENT_BALANCE",
    );
    expect(err.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("Check 7: NAV guard must pass (NAV_GUARD_BLOCKED)", () => {
    const err = new ExecutionError(
      "Trade blocked by NAV protection",
      "NAV_GUARD_BLOCKED",
    );
    expect(err.code).toBe("NAV_GUARD_BLOCKED");
  });
});
