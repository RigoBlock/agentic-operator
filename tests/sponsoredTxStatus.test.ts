import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, ExecutionResult } from "../src/types.js";

const mockGetTransactionReceipt = vi.hoisted(() => vi.fn());
const mockGetSponsoredCallsStatus = vi.hoisted(() => vi.fn());

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: vi.fn(() => ({
    getTransactionReceipt: mockGetTransactionReceipt,
  })),
  ALCHEMY_ORIGIN: "https://trader.rigoblock.com",
}));

vi.mock("../src/services/bundler.js", () => ({
  executeSponsoredCalls: vi.fn(),
  getSponsoredCallsStatus: mockGetSponsoredCallsStatus,
}));

// Import AFTER mocks are declared
const { checkPendingTxStatus } = await import("../src/services/execution.js");

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

function makeReceipt(txHash: `0x${string}`) {
  return {
    status: "success" as const,
    transactionHash: txHash,
    blockHash: "0x1234",
    blockNumber: 123n,
    gasUsed: 100_000n,
    effectiveGasPrice: 10n ** 9n,
    logs: [],
    logsBloom: "0x" + "0".repeat(512),
    contractAddress: null,
    cumulativeGasUsed: 100_000n,
    from: "0x" + "11".repeat(20) as `0x${string}`,
    to: "0x" + "22".repeat(20) as `0x${string}`,
    transactionIndex: 0,
    type: "eip1559" as const,
  };
}

describe("checkPendingTxStatus — direct EVM hash lookup", () => {
  beforeEach(() => {
    mockGetTransactionReceipt.mockReset();
    mockGetSponsoredCallsStatus.mockReset();
  });

  it("returns a confirmed ExecutionResult for a mined EVM hash", async () => {
    const kv = makeKV();
    const env = { KV: kv, ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const txHash = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    mockGetTransactionReceipt.mockResolvedValueOnce(makeReceipt(txHash));

    const result = await checkPendingTxStatus(env, txHash, 1, "0x" + "33".repeat(20));

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(txHash);
    expect(result!.confirmed).toBe(true);
    expect(result!.sponsored).toBe(false);
    expect(mockGetTransactionReceipt).toHaveBeenCalledWith({ hash: txHash });
    expect(mockGetSponsoredCallsStatus).not.toHaveBeenCalled();
  });
});

describe("checkPendingTxStatus — sponsored UserOp resolution", () => {
  beforeEach(() => {
    mockGetTransactionReceipt.mockReset();
    mockGetSponsoredCallsStatus.mockReset();
  });

  it("uses the stored callId to resolve an EVM txHash via wallet_getCallsStatus", async () => {
    const kv = makeKV();
    const env = { KV: kv, ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const callId = "0xb31e63daa2c50ef6e0d99b21a0e18c6e2e1370264f9c77a192244621a2d20c18";
    const evmTxHash = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    const stored: ExecutionResult = {
      chainId: 1,
      confirmed: false,
      reverted: false,
      sponsored: true,
      callId: callId as `0x${string}`,
      gasCostEth: "0 (sponsored — status check timed out)",
    };
    await kv.put(`pending-tx:${callId}`, JSON.stringify(stored));

    // Sponsored status resolves to an EVM txHash
    mockGetSponsoredCallsStatus.mockResolvedValueOnce({
      callId,
      status: "success",
      receipts: [{
        transactionHash: evmTxHash,
        blockHash: "0x1234",
        blockNumber: 123n,
        gasUsed: 100_000n,
        status: "success" as const,
        logs: [],
      }],
    });

    mockGetTransactionReceipt.mockResolvedValueOnce(makeReceipt(evmTxHash));

    const result = await checkPendingTxStatus(env, callId, 1, "0x" + "33".repeat(20));

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(evmTxHash);
    expect(result!.confirmed).toBe(true);
    expect(result!.sponsored).toBe(true);
    expect(mockGetSponsoredCallsStatus).toHaveBeenCalledWith(callId, 1);
  });

  it("returns null when the stored sponsored callId is still pending", async () => {
    const kv = makeKV();
    const env = { KV: kv, ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const callId = "0xb31e63daa2c50ef6e0d99b21a0e18c6e2e1370264f9c77a192244621a2d20c18";

    const stored: ExecutionResult = {
      chainId: 1,
      confirmed: false,
      reverted: false,
      sponsored: true,
      callId: callId as `0x${string}`,
      gasCostEth: "0 (sponsored — status check timed out)",
    };
    await kv.put(`pending-tx:${callId}`, JSON.stringify(stored));

    mockGetTransactionReceipt.mockResolvedValueOnce(null);
    mockGetSponsoredCallsStatus.mockResolvedValueOnce({
      callId,
      status: "pending",
      receipts: undefined,
    });

    const result = await checkPendingTxStatus(env, callId, 1);
    expect(result).toBeNull();
  });
});
