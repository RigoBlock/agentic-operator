/**
 * NAV Shield impact logic tests.
 *
 * These tests exercise checkNavImpact in isolation by mocking the RPC client.
 * They focus on the threshold enforcement and the partial-recovery rule:
 * trades that improve the current unitaryValue are allowed even if the vault
 * is still below the 24h baseline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const UPDATE_SELECTOR = encodeFunctionData({
  abi: RIGOBLOCK_VAULT_ABI,
  functionName: "updateUnitaryValue",
}).slice(0, 10);

const MULTICALL_SELECTOR = encodeFunctionData({
  abi: RIGOBLOCK_VAULT_ABI,
  functionName: "multicall",
  args: [["0x", "0x"]],
}).slice(0, 10);

// ── Hoist mocks before the module under test imports getClient ──
const mockState = vi.hoisted(() => {
  const call = vi.fn();
  return {
    call,
    getClient: vi.fn(() => ({ call })),
  };
});

vi.mock("../src/services/vault.js", () => ({
  getClient: mockState.getClient,
}));

const mockCall = mockState.call;

import { checkNavImpact } from "../src/services/navGuard.js";

const VAULT = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const CALLER = "0x2222222222222222222222222222222222222222" as `0x${string}`;
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

function encodeMulticallReturn(postUnitaryValue: bigint): Hex {
  const navBytes = encodeNavReturn(postUnitaryValue);
  return encodeFunctionResult({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "multicall",
    result: ["0x", navBytes],
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

function setupClient(preUnitaryValue: bigint, postUnitaryValue: bigint, swapReverts = false) {
  mockCall.mockImplementation(async ({ data }: { data?: Hex }) => {
    const selector = data?.slice(0, 10);

    if (selector === UPDATE_SELECTOR) {
      return { data: encodeNavReturn(preUnitaryValue) };
    }

    if (selector === MULTICALL_SELECTOR) {
      if (swapReverts) {
        throw new Error("execution reverted: swap failed");
      }
      return { data: encodeMulticallReturn(postUnitaryValue) };
    }

    throw new Error(`Unexpected selector: ${selector}`);
  });
}

describe("NAV Shield impact logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a trade within the max NAV drop threshold", async () => {
    setupClient(10000n, 9000n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.dropPct).toBe("10.0000");
    expect(result.impactPct).toBe("-10.0000");
  });

  it("blocks a trade that exceeds the max NAV drop threshold", async () => {
    setupClient(10000n, 8900n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, createMockKV(),
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
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, kv,
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
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, kv,
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
    expect(result.impactPct).toBe("-6.2500");
    expect(result.reason).toContain("below the 24h baseline");
  });

  it("allows trading in an empty vault (unitaryValue = 0)", async () => {
    setupClient(0n, 0n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("fails closed when pre-swap NAV cannot be read", async () => {
    mockCall.mockRejectedValue(new Error("RPC timeout"));
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("Cannot read vault NAV");
  });

  it("reports TRADE_REVERTS when the swap itself fails", async () => {
    setupClient(10000n, 10000n, true);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, ALCHEMY_KEY, CALLER, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TRADE_REVERTS");
    expect(result.reason).toContain("would revert on-chain");
  });
});
