import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types.js";

const mockGetTransactionReceipt = vi.hoisted(() => vi.fn());
const mockGetSponsoredCallsStatus = vi.hoisted(() => vi.fn());

vi.mock("../src/services/vault.js", () => ({
  getClient: vi.fn(() => ({
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

describe("checkPendingTxStatus — sponsored UserOp resolution", () => {
  beforeEach(() => {
    mockGetTransactionReceipt.mockReset();
    mockGetSponsoredCallsStatus.mockReset();
  });

  it("resolves a UserOp callId to an EVM txHash via wallet_getCallsStatus", async () => {
    const kv = makeKV();
    const env = { KV: kv, ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const callId = "0xb31e63daa2c50ef6e0d99b21a0e18c6e2e1370264f9c77a192244621a2d20c18";
    const evmTxHash = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    // First lookup: no EVM receipt for the callId
    mockGetTransactionReceipt.mockResolvedValueOnce(null);

    // Sponsored status resolves to an EVM txHash
    mockGetSponsoredCallsStatus.mockResolvedValueOnce({
      callId,
      status: "success",
      receipts: [{
        transactionHash: evmTxHash,
        blockHash: "0x1234",
        blockNumber: 123n,
        gasUsed: 100_000n,
        status: "success",
        logs: [],
      }],
    });

    // Second lookup: full EVM receipt for the resolved txHash
    mockGetTransactionReceipt.mockResolvedValueOnce({
      status: "success",
      transactionHash: evmTxHash,
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
      type: "eip1559",
    });

    const result = await checkPendingTxStatus(env, callId, 1, "0x" + "33".repeat(20));

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(evmTxHash);
    expect(result!.confirmed).toBe(true);
    expect(result!.sponsored).toBe(false);
    expect(mockGetSponsoredCallsStatus).toHaveBeenCalledWith(callId, 1, "test-key");
  });

  it("returns null when no EVM receipt and sponsored status is still pending", async () => {
    const kv = makeKV();
    const env = { KV: kv, ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const callId = "0xb31e63daa2c50ef6e0d99b21a0e18c6e2e1370264f9c77a192244621a2d20c18";

    mockGetTransactionReceipt.mockResolvedValueOnce(null);
    mockGetSponsoredCallsStatus.mockResolvedValueOnce({
      callId,
      status: "pending",
      receipts: undefined,
    });

    const result = await checkPendingTxStatus(env, callId, 1);
    expect(result).toBeNull();
  });

  it("falls back to the last 32 bytes of a 64-byte callId", async () => {
    const kv = makeKV();
    const env = { KV: kv, ALCHEMY_API_KEY: "test-key" } as unknown as Env;
    const userOpHash = "0xb31e63daa2c50ef6e0d99b21a0e18c6e2e1370264f9c77a192244621a2d20c18";
    const longCallId = `0x${"0".repeat(64)}${userOpHash.slice(2)}`;
    const evmTxHash = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    // First EVM receipt lookup for the 64-byte id returns nothing
    mockGetTransactionReceipt.mockResolvedValueOnce(null);

    // First wallet_getCallsStatus with the full 64-byte id fails
    mockGetSponsoredCallsStatus.mockRejectedValueOnce(new Error("unknown callId"));

    // Fallback to the last 32 bytes succeeds
    mockGetSponsoredCallsStatus.mockResolvedValueOnce({
      callId: userOpHash,
      status: "success",
      receipts: [{
        transactionHash: evmTxHash,
        blockHash: "0x1234",
        blockNumber: 123n,
        gasUsed: 100_000n,
        status: "success",
        logs: [],
      }],
    });

    mockGetTransactionReceipt.mockResolvedValueOnce({
      status: "success",
      transactionHash: evmTxHash,
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
      type: "eip1559",
    });

    const result = await checkPendingTxStatus(env, longCallId, 1, "0x" + "33".repeat(20));

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(evmTxHash);
    expect(mockGetSponsoredCallsStatus).toHaveBeenCalledTimes(2);
    expect(mockGetSponsoredCallsStatus).toHaveBeenNthCalledWith(1, longCallId, 1, "test-key");
    expect(mockGetSponsoredCallsStatus).toHaveBeenNthCalledWith(2, userOpHash, 1, "test-key");
  });
});
