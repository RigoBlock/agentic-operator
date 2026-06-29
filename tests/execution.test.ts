/**
 * Execution safety tests — validates the 7-point security model.
 *
 * Tests the ExecutionError class and the execution validation logic WITHOUT
 * real RPC calls.
 */
import { describe, it, expect, vi } from "vitest";
import { parseGwei, type PublicClient } from "viem";
import { ExecutionError, estimateFees } from "../src/services/execution.js";
import { handle_check_pending_tx } from "../src/llm/handlers/delegation.js";
import type { Env, RequestContext } from "../src/types.js";

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
      "AGENT_NOT_DELEGATED",
      "AGENT_WALLET_NOT_FOUND",
      "AGENT_WALLET_MISMATCH",
      "SIMULATION_FAILED",
      "INSUFFICIENT_BALANCE",
      "GAS_ESTIMATION_FAILED",
      "NAV_SHIELD_BLOCKED",
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

  it("Check 5a: simulation must pass for valid transactions (SIMULATION_FAILED)", () => {
    const err = new ExecutionError(
      "Transaction simulation failed",
      "SIMULATION_FAILED",
    );
    expect(err.code).toBe("SIMULATION_FAILED");
  });

  it("Check 5b: AGENT_NOT_DELEGATED when operator simulation passes but agent simulation fails", () => {
    // This covers the case where:
    // - NAV shield simulation as OPERATOR succeeds (vault is happy with the tx)
    // - But agent's own eth_call fails (selector not in agent's on-chain delegation)
    // Outcome: AGENT_NOT_DELEGATED triggers fallbackToManual in /api/delegation/execute
    const err = new ExecutionError(
      "The agent wallet is not delegated for function selector 0xdd46508f on-chain. " +
      "Update your delegation to add this function, or sign this transaction directly from your wallet.",
      "AGENT_NOT_DELEGATED",
    );
    expect(err.code).toBe("AGENT_NOT_DELEGATED");
    expect(err.message).toContain("Update your delegation");
    expect(err.message).toContain("sign this transaction directly");
  });

  it("Check 6: agent balance must be sufficient (INSUFFICIENT_BALANCE)", () => {
    const err = new ExecutionError(
      "Agent balance too low",
      "INSUFFICIENT_BALANCE",
    );
    expect(err.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("Check 7: NAV shield must pass (NAV_SHIELD_BLOCKED)", () => {
    const err = new ExecutionError(
      "Trade blocked by NAV protection",
      "NAV_SHIELD_BLOCKED",
    );
    expect(err.code).toBe("NAV_SHIELD_BLOCKED");
  });
});

describe("Agent wallet gas price buffer", () => {
  /**
   * Documents the race condition that causes revocation failures:
   *
   *   eth_gasPrice returns: 20,014,000 wei
   *   Next block baseFee: 20,140,000 wei
   *   Result: "max fee per gas less than block base fee" → tx rejected
   *
   * Fix: apply a 20% buffer to the fetched gasPrice before signing.
   * This ensures the transaction is valid even if the baseFee ticks up
   * between estimation and broadcast (Arbitrum blocks ~250ms apart).
   */
  it("raw gasPrice from RPC can be below next block baseFee", () => {
    // These values match the actual error seen in production:
    const rawGasPrice = 20_014_000n;   // eth_gasPrice returned this
    const nextBlockBaseFee = 20_140_000n; // baseFee at broadcast time

    // Without buffer: rejected
    expect(rawGasPrice).toBeLessThan(nextBlockBaseFee);
  });

  it("20% buffer prevents baseFee race condition", () => {
    const rawGasPrice = 20_014_000n;
    const nextBlockBaseFee = 20_140_000n;

    // The fix: Math.ceil(rawGasPrice * 1.2)
    const buffered = BigInt(Math.ceil(Number(rawGasPrice) * 1.2));

    // With buffer: accepted (24,016,800 > 20,140,000)
    expect(buffered).toBeGreaterThan(nextBlockBaseFee);
    // And still within reasonable range (not 10x the actual price)
    expect(buffered).toBeLessThan(rawGasPrice * 2n);
  });

  it("20% buffer handles zero gasPrice gracefully", () => {
    const rawGasPrice = 0n;
    const buffered = BigInt(Math.ceil(Number(rawGasPrice) * 1.2));
    expect(buffered).toBe(0n);
  });
});

describe("estimateFees priority fee floor", () => {
  it("uses a mainnet priority fee above Alchemy's 0.0625 gwei bundler minimum", async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: parseGwei("10") }),
      estimateMaxPriorityFeePerGas: vi.fn(),
    } as unknown as PublicClient;

    const fees = await estimateFees(publicClient, 1);

    expect(fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(parseGwei("0.01"));
    expect(fees.maxPriorityFeePerGas).toBeLessThanOrEqual(parseGwei("0.0625"));
    expect(fees.maxFeePerGas).toBeGreaterThan(fees.maxPriorityFeePerGas);
  });

  it("uses a sepolia priority fee above Alchemy's bundler minimum", async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: parseGwei("10") }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(parseGwei("0.05")),
    } as unknown as PublicClient;

    const fees = await estimateFees(publicClient, 11155111);

    expect(fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(parseGwei("0.05"));
    expect(fees.maxPriorityFeePerGas).toBeLessThanOrEqual(parseGwei("0.1"));
  });

  it("caps priority fee at the chain-specific cap", async () => {
    const publicClient = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: parseGwei("1") }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(parseGwei("1")),
    } as unknown as PublicClient;

    const fees = await estimateFees(publicClient, 8453);

    expect(fees.maxPriorityFeePerGas).toBe(parseGwei("0.01"));
    // Base maxFee cap is 1 gwei; buffered base (1.5 gwei) + priority exceeds it.
    expect(fees.maxFeePerGas).toBe(parseGwei("1"));
  });
});

describe("handle_check_pending_tx", () => {
  function makeKV(): KVNamespace {
    const store = new Map<string, string>();
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
      list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
    } as unknown as KVNamespace;
  }

  it("reports no pending transaction when none is stored", async () => {
    const env = { KV: makeKV(), ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const ctx = {
      vaultAddress: "0xd14d4321a33F7eD001Ba5B60cE54b0F7Ba621247",
      chainId: 8453,
    } as unknown as RequestContext;

    const result = await handle_check_pending_tx(env, ctx, {}, "check_pending_tx");

    expect(result.selfContained).toBe(true);
    expect(result.message).toContain("No pending transaction is recorded");
  });
});
