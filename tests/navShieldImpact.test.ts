/**
 * NAV Shield impact logic tests.
 *
 * These tests exercise checkNavImpact in isolation by mocking the unified
 * eth_simulateV1 simulation. They focus on threshold enforcement and the
 * partial-recovery rule: trades that improve the current unitaryValue are
 * allowed even if the vault is still below the 24h baseline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionResult, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const UPDATE_SELECTOR = encodeFunctionData({
  abi: RIGOBLOCK_VAULT_ABI,
  functionName: "updateUnitaryValue",
}).slice(0, 10);

import { encodeFunctionData } from "viem";

// ── Hoist mocks before the module under test imports getClient / simulateCalls ──
const mockState = vi.hoisted(() => {
  const simulateCalls = vi.fn();
  const getClient = vi.fn(() => ({ simulateCalls } as any));
  return {
    simulateCalls,
    getClient,
  };
});

vi.mock("../src/services/rpcClient.js", () => ({
  getClient: mockState.getClient,
}));

vi.mock("viem/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/actions")>();
  return {
    ...actual,
    simulateCalls: mockState.simulateCalls,
  };
});

const mockSimulateCalls = mockState.simulateCalls;

import { checkNavImpact } from "../src/services/navGuard.js";

const VAULT = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const EXECUTOR = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const CHAIN_ID = 42161;
const ALCHEMY_KEY = "test-key";
const SWAP_DATA = "0xdeadbeef" as Hex;

function encodeNavReturn(unitaryValue: bigint): Hex {
  return encodeFunctionResult({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "updateUnitaryValue",
    result: [unitaryValue, unitaryValue * 1000n, 0n] as any,
  });
}

function createMockKV(baseline?: { unitaryValue: string; recordedAt: number }): KVNamespace {
  const store = new Map<string, string>();
  if (baseline) {
    store.set(`nav-baseline:${VAULT.toLowerCase()}:${CHAIN_ID}`, JSON.stringify(baseline));
  }
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makePreNavSimulateResult(preUnitaryValue: bigint) {
  return {
    results: [
      { status: "success" as const, data: encodeNavReturn(preUnitaryValue), gasUsed: 50_000n },
    ],
  };
}

function makeSwapNavSimulateResult(
  postUnitaryValue: bigint,
  swapReverts = false,
) {
  const swapResult = swapReverts
    ? {
        status: "failure" as const,
        error: new Error("execution reverted: swap failed"),
        data: "0x" as Hex,
        gasUsed: 0n,
      }
    : {
        status: "success" as const,
        data: "0x" as Hex,
        gasUsed: 100_000n,
      };

  return {
    results: [
      swapResult,
      { status: "success" as const, data: encodeNavReturn(postUnitaryValue), gasUsed: 50_000n },
    ],
  };
}

function setupClient(preUnitaryValue: bigint, postUnitaryValue: bigint, swapReverts = false) {
  mockSimulateCalls.mockImplementation(async (_client: unknown, args: { calls: unknown[] }) => {
    if (args.calls.length === 1) {
      return makePreNavSimulateResult(preUnitaryValue);
    }
    return makeSwapNavSimulateResult(postUnitaryValue, swapReverts);
  });
}

describe("NAV Shield impact logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a trade within the max NAV drop threshold", async () => {
    setupClient(10000n, 9000n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.dropPct).toBe("10.0000");
    expect(result.impactPct).toBe("-10.0000");
    expect(result.gasUsed).toBe(100_000n);
    expect(mockSimulateCalls).toHaveBeenCalledTimes(2);
  });

  it("blocks a trade that exceeds the max NAV drop threshold", async () => {
    setupClient(10000n, 8900n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
    expect(Number(result.dropPct)).toBeGreaterThan(10);
    expect(result.impactPct).toBe("-11.0000");
  });

  it("allows a recovery trade that improves NAV while below baseline", async () => {
    // Baseline is higher than current NAV; the trade improves NAV but stays below baseline.
    setupClient(8000n, 8500n);
    const kv = createMockKV({ unitaryValue: "10000", recordedAt: Date.now() });
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, kv,
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.dropPct).toBe("0");
    expect(result.impactPct).toBe("6.2500");
    expect(result.reason).toContain("improves");
  });

  it("blocks a trade that worsens NAV while below baseline", async () => {
    setupClient(8000n, 7500n);
    const kv = createMockKV({ unitaryValue: "10000", recordedAt: Date.now() });
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, kv,
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
    expect(result.impactPct).toBe("-6.2500");
    expect(result.reason).toContain("below the 24h baseline");
  });

  it("allows trading in an empty vault (unitaryValue = 0)", async () => {
    setupClient(0n, 0n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("fails closed when pre-swap NAV cannot be read", async () => {
    mockSimulateCalls.mockRejectedValue(new Error("RPC timeout"));
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("Cannot simulate vault NAV impact");
  });

  it("reports TRADE_REVERTS when the swap itself fails", async () => {
    setupClient(10000n, 10000n, true);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, EXECUTOR, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TRADE_REVERTS");
    expect(result.reason).toContain("would revert on-chain");
  });

});
