/**
 * Execution-mode decision tests (frontend logic, from delegation-status.js).
 *
 * Regression guard for the delegation bug where operating on Arbitrum while the
 * wallet had HyperEVM selected flipped the chat to manual mode: the mode must
 * depend on whether delegation is active on ANY chain, never on the wallet's
 * currently selected chain. The tool's chain is what matters — the backend
 * picks the executor per transaction chain, and the tx modal auto-switches the
 * wallet to the transaction's chain when the operator signs manually.
 */
import { describe, it, expect, vi } from "vitest";

// delegation-status.js → state.js reads DOM elements at module load time.
vi.stubGlobal("document", { getElementById: () => null });

// @ts-expect-error plain-JS frontend module without type declarations
const { computeExecutionMode } = await import("../public/frontend/delegation-status.js");

describe("computeExecutionMode", () => {
  it("stays delegated when the wallet chain has no delegation but another chain does (HyperEVM selected, Arbitrum delegated)", () => {
    // Status queried for HyperEVM (999): no KV config, no on-chain delegation there,
    // but on-chain delegation exists on Arbitrum (42161) — the reported bug scenario.
    const state = {
      enabled: false,
      isActiveOnChain: false,
      isActiveInKV: false,
      activeChains: [],
      delegatedChains: [42161],
    };
    expect(computeExecutionMode(state)).toBe("delegated");
  });

  it("delegates when delegation is active on the queried chain", () => {
    const state = {
      enabled: true,
      isActiveOnChain: true,
      activeChains: [42161],
      delegatedChains: [42161],
    };
    expect(computeExecutionMode(state)).toBe("delegated");
  });

  it("delegates when the KV config lists active chains even if on-chain verify is unavailable", () => {
    const state = {
      enabled: true,
      isActiveOnChain: undefined,
      activeChains: [8453, 42161],
      delegatedChains: [],
    };
    expect(computeExecutionMode(state)).toBe("delegated");
  });

  it("falls back to manual when there is no delegation anywhere", () => {
    const state = {
      enabled: false,
      isActiveOnChain: false,
      activeChains: [],
      delegatedChains: [],
    };
    expect(computeExecutionMode(state)).toBe("manual");
  });

  it("falls back to manual on a missing or partial state", () => {
    expect(computeExecutionMode(null)).toBe("manual");
    expect(computeExecutionMode({})).toBe("manual");
    expect(computeExecutionMode({ enabled: true, isActiveOnChain: false })).toBe("manual");
  });

  it("forces manual when the agent wallet changed (old on-chain delegations are invalid)", () => {
    const state = {
      enabled: true,
      isActiveOnChain: true,
      activeChains: [42161],
      delegatedChains: [42161],
      walletChanged: true,
    };
    expect(computeExecutionMode(state)).toBe("manual");
  });
});
