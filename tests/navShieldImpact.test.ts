/**
 * NAV Shield impact logic tests.
 *
 * These tests exercise checkNavImpact in isolation by mocking the RPC
 * provider's `call` (eth_call). They focus on threshold enforcement and the
 * partial-recovery rule: trades that improve the current unitaryValue are
 * allowed even if the vault is still below the 24h baseline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../src/abi/rigoblockVault.js";

const UPDATE_SELECTOR = encodeFunctionData({
  abi: RIGOBLOCK_VAULT_ABI,
  functionName: "updateUnitaryValue",
}).slice(0, 10);

// multicall(bytes[]) — no longer in the delegation whitelist, but the NAV
// shield still simulates multicall([tx, updateUnitaryValue]) from the vault
// owner to read the post-swap NAV atomically.
const MULTICALL_SELECTOR = "0xac9650d8" as Hex;

// ── Hoist mocks before the module under test imports getRpcProvider ──
const mockState = vi.hoisted(() => {
  const readContract = vi.fn(
    async (_args: { functionName: string }): Promise<bigint | `0x${string}`> => 1n,
  );
  // eth_call only — checkNavImpact must not use eth_simulateV1 (Nitro false positives).
  const call = vi.fn();
  const getRpcProvider = vi.fn(() => ({ readContract, call } as any));
  return {
    readContract,
    call,
    getRpcProvider,
  };
});

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockState.getRpcProvider,
}));

import { checkNavImpact } from "../src/services/navGuard.js";

const VAULT = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const CHAIN_ID = 42161;
const SWAP_DATA = "0xdeadbeef" as Hex;

function encodeNavReturn(unitaryValue: bigint): Hex {
  return encodeFunctionResult({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "updateUnitaryValue",
    result: [unitaryValue, unitaryValue * 1000n, 0n] as any,
  });
}

function encodeMulticallReturn(postUnitaryValue: bigint): Hex {
  return encodeFunctionResult({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "multicall",
    result: ["0x", encodeNavReturn(postUnitaryValue)] as any,
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

/** Route eth_calls by selector: updateUnitaryValue → pre NAV, multicall → post NAV. */
function setupClient(preUnitaryValue: bigint, postUnitaryValue: bigint) {
  mockState.call.mockImplementation(async (args: { data: Hex }) => {
    const selector = args.data.slice(0, 10);
    if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(preUnitaryValue) };
    if (selector === MULTICALL_SELECTOR) return { data: encodeMulticallReturn(postUnitaryValue) };
    throw new Error(`unexpected eth_call data: ${selector}`);
  });
}

describe("NAV Shield impact logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.readContract.mockReset();
    // readContract serves totalSupply (1n) and the vault owner address.
    mockState.readContract.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "owner" ? OWNER : 1n,
    );
    mockState.call.mockReset();
    mockState.call.mockRejectedValue(new Error("execution reverted"));
  });

  it("allows a trade within the max NAV drop threshold", async () => {
    setupClient(10000n, 9000n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.dropPct).toBe("10.0000");
    expect(result.impactPct).toBe("-10.0000");
  });

  it("blocks a trade that exceeds the max NAV drop threshold", async () => {
    setupClient(10000n, 8900n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
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
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, kv,
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
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, kv,
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
    expect(result.impactPct).toBe("-6.2500");
    expect(result.reason).toContain("below the 24h baseline");
  });

  it("allows trading in an empty vault (unitaryValue = 0)", async () => {
    setupClient(0n, 0n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("allows first deposit when vault has no outstanding shares (totalSupply = 0)", async () => {
    mockState.readContract.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "owner" ? OWNER : 0n,
    );
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("UNVERIFIED");
    expect(result.reason).toContain("no outstanding shares");
    expect(mockState.call).not.toHaveBeenCalled();
  });

  it("fails closed when pre-swap NAV cannot be read", async () => {
    mockState.call.mockRejectedValue(new Error("RPC timeout"));
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("Cannot simulate vault NAV impact");
  });

  it("reports TRADE_REVERTS when the multicall eth_call reverts", async () => {
    setupClient(10000n, 10000n);
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(10000n) };
      throw new Error("execution reverted");
    });
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TRADE_REVERTS");
    expect(result.reason).toContain("would revert on-chain");
  });

  it("surfaces the decoded revert reason from the multicall eth_call", async () => {
    // Regression (prod, crosschain sync 5000 USDC arb→eth): the multicall eth_call
    // reverts with NavImpactTooHigh (0x3471741b) — a genuine revert. The decoded
    // reason must reach the user.
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(10000n) };
      const navImpactError = Object.assign(new Error("execution reverted"), {
        data: "0x3471741b",
      });
      throw navImpactError;
    });
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TRADE_REVERTS");
    expect(result.reason).toContain("NavImpactTooHigh");
  });

  it("normalizes viem's misleading 'returned no data' wrapper for empty reverts", async () => {
    // viem reports empty revert data as 'The contract function "<unknown>" returned
    // no data ("0x")' — which read like a decoding artifact, not a revert.
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(10000n) };
      throw new Error('The contract function "<unknown>" returned no data ("0x").');
    });
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TRADE_REVERTS");
    expect(result.reason).toContain("reverted on-chain without a revert reason");
    expect(result.reason).not.toContain("returned no data");
  });

  it("uses only eth_call from the vault owner — no eth_simulateV1", async () => {
    // The NAV shield must be pure eth_call: eth_simulateV1 produces false positives
    // on Nitro chains (synthetic block diverges from real execution). The calls run
    // from the vault owner, who always passes the fallback write-mode gate — no
    // multicall delegation is required.
    setupClient(10000n, 9900n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.impactPct).toBe("-1.0000");
    // Exactly two eth_calls: updateUnitaryValue (pre) + multicall ([swap, updateUnitaryValue]).
    expect(mockState.call).toHaveBeenCalledTimes(2);
    const calls = mockState.call.mock.calls.map((c) => c[0] as { account: string; to: string; data: Hex });
    expect(calls.every((c) => c.account === OWNER && c.to === VAULT)).toBe(true);
    const selectors = calls.map((c) => c.data.slice(0, 10)).sort();
    expect(selectors).toEqual([UPDATE_SELECTOR, MULTICALL_SELECTOR].sort());
    // The multicall must wrap [swapData, updateUnitaryValue] so the post-NAV is atomic.
    const multicallCall = calls.find((c) => c.data.slice(0, 10) === MULTICALL_SELECTOR)!;
    expect(multicallCall.data).toContain(SWAP_DATA.slice(2));
  });

  it("skips the on-chain owner read when the caller passes a verified owner", async () => {
    // Latency: the authenticated operator IS the vault owner (verifyOperatorAuth),
    // so the caller passes it in and readContract must never be asked for "owner".
    setupClient(10000n, 9900n);
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, OWNER, createMockKV(),
    );
    expect(result.allowed).toBe(true);
    const readNames = mockState.readContract.mock.calls.map(
      (c) => (c[0] as { functionName: string }).functionName,
    );
    expect(readNames).not.toContain("owner");
    expect(readNames).toContain("totalSupply");
    const calls = mockState.call.mock.calls.map((c) => c[0] as { account: string });
    expect(calls.every((c) => c.account === OWNER)).toBe(true);
  });

  it("skips simulation when the operator has disabled the NAV shield", async () => {
    const result = await checkNavImpact(
      VAULT, SWAP_DATA, 0n, CHAIN_ID, undefined, createMockKV(), 0n,
    );
    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("DISABLED");
    expect(result.reason).toContain("disabled");
    expect(mockState.call).not.toHaveBeenCalled();
  });

});
