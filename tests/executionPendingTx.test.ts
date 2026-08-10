/**
 * Pending-transaction status lookup tests.
 *
 * Validates that checkPendingTxStatus never calls eth_getTransactionReceipt with a
 * non-EVM identifier (e.g. a 128-byte sponsored callId), and that it resolves
 * sponsored callIds via wallet_getCallsStatus first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Hex, type TransactionReceipt } from "viem";
import { checkPendingTxStatus } from "../src/services/execution.js";
import { getSponsoredCallsStatus } from "../src/services/bundler.js";
import { getRpcProvider } from "../src/services/rpcClient.js";
import type { Env, ExecutionResult } from "../src/types.js";

vi.mock("../src/services/bundler.js", () => ({
  getSponsoredCallsStatus: vi.fn(),
  executeSponsoredCalls: vi.fn(),
}));

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: vi.fn(),
  ALCHEMY_ORIGIN: "https://trader.rigoblock.com",
}));

function makeKV(store = new Map<string, string>()) {
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

const MOCK_TX_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
const MOCK_CALL_ID = "0x0000000000000000000000000000000000000000000000000000000000002105abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
const MOCK_USER_OP_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;

function makeReceipt(overrides?: Partial<TransactionReceipt>): TransactionReceipt {
  return {
    status: "success",
    blockNumber: 123n,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
    transactionIndex: 0,
    from: "0x0000000000000000000000000000000000000001" as Hex,
    to: "0x0000000000000000000000000000000000000002" as Hex,
    gasUsed: 100000n,
    cumulativeGasUsed: 100000n,
    effectiveGasPrice: 1000000000n,
    logs: [],
    logsBloom: "0x" + "0".repeat(512),
    type: "eip1559",
    ...overrides,
  } as TransactionReceipt;
}

describe("checkPendingTxStatus", () => {
  let kvStore: Map<string, string>;
  let publicClient: { getTransactionReceipt: ReturnType<typeof vi.fn> };
  let env: Env;

  beforeEach(() => {
    kvStore = new Map<string, string>();
    publicClient = { getTransactionReceipt: vi.fn() };
    (getRpcProvider as ReturnType<typeof vi.fn>).mockReturnValue(publicClient);
    (getSponsoredCallsStatus as ReturnType<typeof vi.fn>).mockReset();
    env = { KV: makeKV(kvStore), ALCHEMY_API_KEY: "test-key" } as unknown as Env;
  });

  it("returns a receipt for a valid 64-byte EVM hash", async () => {
    publicClient.getTransactionReceipt.mockResolvedValue(makeReceipt());

    const result = await checkPendingTxStatus(env, MOCK_TX_HASH, 8453);

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(MOCK_TX_HASH);
    expect(result!.confirmed).toBe(true);
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
    expect(getSponsoredCallsStatus).not.toHaveBeenCalled();
  });

  it("normalizes an uppercase EVM hash to lowercase for lookup", async () => {
    publicClient.getTransactionReceipt.mockResolvedValue(makeReceipt());
    const upper = ("0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890" as Hex);

    await checkPendingTxStatus(env, upper, 8453);

    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: upper.toLowerCase() as Hex });
  });

  it("never calls eth_getTransactionReceipt with a 128-byte sponsored callId", async () => {
    (getSponsoredCallsStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: MOCK_CALL_ID,
      status: "pending",
      receipts: undefined,
    });

    const result = await checkPendingTxStatus(env, MOCK_CALL_ID, 8453);

    expect(result).toBeNull();
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(getSponsoredCallsStatus).toHaveBeenCalledWith(MOCK_CALL_ID, 8453);
  });

  it("resolves a 128-byte callId to an EVM hash when the bundler returns a receipt", async () => {
    (getSponsoredCallsStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: MOCK_CALL_ID,
      status: "success",
      receipts: [{
        transactionHash: MOCK_TX_HASH,
        blockHash: "0x01" as Hex,
        blockNumber: 123n,
        gasUsed: 100000n,
        status: "success",
        logs: [],
      }],
    });
    publicClient.getTransactionReceipt.mockResolvedValue(makeReceipt());

    const result = await checkPendingTxStatus(env, MOCK_CALL_ID, 8453);

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(MOCK_TX_HASH);
    expect(result!.confirmed).toBe(true);
    expect(getSponsoredCallsStatus).toHaveBeenCalledWith(MOCK_CALL_ID, 8453);
    expect(publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
  });

  it("uses the stored callId when the lookup input is a 64-byte userOp hash", async () => {
    // Old pending record was stored under the 128-byte callId
    const stored: ExecutionResult = {
      chainId: 8453,
      confirmed: false,
      reverted: false,
      sponsored: true,
      callId: MOCK_CALL_ID,
    };
    kvStore.set(`pending-tx:${MOCK_CALL_ID}`, JSON.stringify(stored));

    (getSponsoredCallsStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: MOCK_CALL_ID,
      status: "success",
      receipts: [{
        transactionHash: MOCK_TX_HASH,
        blockHash: "0x01" as Hex,
        blockNumber: 123n,
        gasUsed: 100000n,
        status: "success",
        logs: [],
      }],
    });
    publicClient.getTransactionReceipt.mockResolvedValue(makeReceipt());

    const result = await checkPendingTxStatus(env, MOCK_CALL_ID, 8453);

    expect(result).not.toBeNull();
    expect(result!.txHash).toBe(MOCK_TX_HASH);
    expect(getSponsoredCallsStatus).toHaveBeenCalledWith(MOCK_CALL_ID, 8453);
  });

  it("cleans up the callId and resolved hash KV keys after a sponsored tx lands", async () => {
    kvStore.set(`pending-tx:${MOCK_CALL_ID}`, JSON.stringify({
      chainId: 8453,
      confirmed: false,
      reverted: false,
      sponsored: true,
      callId: MOCK_CALL_ID,
    }));
    (getSponsoredCallsStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      callId: MOCK_CALL_ID,
      status: "success",
      receipts: [{
        transactionHash: MOCK_TX_HASH,
        blockHash: "0x01" as Hex,
        blockNumber: 123n,
        gasUsed: 100000n,
        status: "success",
        logs: [],
      }],
    });
    publicClient.getTransactionReceipt.mockResolvedValue(makeReceipt());

    await checkPendingTxStatus(env, MOCK_CALL_ID, 8453, "0xVaultVaultVaultVaultVaultVaultVaultVault");

    expect(kvStore.has(`pending-tx:${MOCK_CALL_ID}`)).toBe(false);
    expect(kvStore.has(`pending-tx:${MOCK_TX_HASH}`)).toBe(false);
    expect(kvStore.has("pending-tx-by-vault:0xvaultvaultvaultvaultvaultvaultvaultvault:8453")).toBe(false);
  });

  it("returns null for an invalid hash without making RPC calls", async () => {
    const result = await checkPendingTxStatus(env, "not-a-hash", 8453);

    expect(result).toBeNull();
    expect(publicClient.getTransactionReceipt).not.toHaveBeenCalled();
    expect(getSponsoredCallsStatus).not.toHaveBeenCalled();
  });
});
