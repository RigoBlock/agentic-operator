/**
 * TransactionFlow tests — unified execution-mode engine.
 *
 * These tests verify the single KV preference and decision logic shared by
 * web, Telegram, and direct tools.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecuteTxList } = vi.hoisted(() => ({ mockExecuteTxList: vi.fn() }));
vi.mock("../src/services/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/execution.js")>();
  return {
    ...actual,
    executeTxList: mockExecuteTxList,
  };
});

import {
  getExecutionModePreference,
  setExecutionModePreference,
  getOperatorExecModeKey,
  runTransactionFlow,
} from "../src/services/transactionFlow.js";
import type { Env, UnsignedTransaction } from "../src/types.js";
import type { TxExecOutcome } from "../src/services/execution.js";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(kv: KVNamespace): Env {
  return { KV: kv } as unknown as Env;
}

function makeTx(overrides?: Partial<UnsignedTransaction>): UnsignedTransaction {
  return {
    from: "0x2222222222222222222222222222222222222222",
    to: "0x1111111111111111111111111111111111111111",
    data: "0x",
    value: "0x0",
    chainId: 8453,
    gas: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    description: "test tx",
    navShieldChecked: true,
    ...overrides,
  };
}

const OPERATOR = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";
const VAULT = "0x1111111111111111111111111111111111111111";

describe("execution-mode preference KV helpers", () => {
  it("defaults to confirm when no preference is stored", async () => {
    const kv = createMockKV();
    const mode = await getExecutionModePreference(kv, OPERATOR);
    expect(mode).toBe("confirm");
  });

  it("stores and retrieves the operator preference", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "autonomous");
    expect(await getExecutionModePreference(kv, OPERATOR)).toBe("autonomous");

    await setExecutionModePreference(kv, OPERATOR, "confirm");
    expect(await getExecutionModePreference(kv, OPERATOR)).toBe("confirm");
  });

  it("allows maxPriorityFeePerGas=0x0 (Arbitrum has no priority fee)", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "confirm");

    const tx = makeTx({
      chainId: 42161,
      maxPriorityFeePerGas: "0x0",
      description: "Arbitrum tx",
    });

    const result = await runTransactionFlow(
      makeEnv(kv),
      OPERATOR,
      VAULT,
      [tx],
      "Ready",
      { requestConfirmation: async () => {} },
    );

    expect(result.kind).toBe("pending_confirmation");
  });

  it("uses a single lowercased KV key", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR.toUpperCase(), "autonomous");
    const stored = await kv.get(getOperatorExecModeKey(OPERATOR.toLowerCase()));
    expect(stored).toBe("autonomous");
  });
});

describe("runTransactionFlow", () => {
  beforeEach(() => {
    mockExecuteTxList.mockReset();
  });

  it("returns pending_confirmation with stored executable transactions in confirm mode", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "confirm");
    const txs = [makeTx()];
    const requested: UnsignedTransaction[] = [];

    const result = await runTransactionFlow(
      makeEnv(kv),
      OPERATOR,
      VAULT,
      txs,
      "Ready",
      {
        requestConfirmation: async (pending) => {
          requested.push(...pending);
        },
      },
    );

    expect(result.kind).toBe("pending_confirmation");
    expect(result.transactions).toEqual(txs);
    expect(result.operationId).toBeDefined();
    expect(requested).toEqual(txs);
    expect(mockExecuteTxList).not.toHaveBeenCalled();

    // Verify the simulation was stored in KV and is consumable.
    const storedRaw = await kv.get(`pending-sim:${result.operationId}`);
    expect(storedRaw).not.toBeNull();
    const stored = JSON.parse(storedRaw!);
    expect(stored.vaultAddress).toBe(VAULT);
    expect(stored.txs).toHaveLength(1);
  });

  it("throws early for non-executable transactions in confirm mode", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "confirm");

    const cases = [
      { tx: makeTx({ operatorOnly: true, description: "operator only" }), reason: /owner.*sign/i },
      { tx: makeTx({ revertWarning: "would revert", description: "revert warning" }), reason: /simulation failed/i },
      { tx: makeTx({ gas: "0x0", description: "no gas" }), reason: /missing a gas limit/i },
      { tx: makeTx({ maxFeePerGas: "0x0", description: "no max fee" }), reason: /missing a max fee per gas/i },
      { tx: makeTx({ maxPriorityFeePerGas: "" as `0x${string}`, description: "no priority fee" }), reason: /missing a max priority fee per gas/i },
      { tx: makeTx({ navShieldChecked: false, description: "no nav shield" }), reason: /NAV-shield verification/i },
    ];

    for (const { tx, reason } of cases) {
      await expect(
        runTransactionFlow(
          makeEnv(kv),
          OPERATOR,
          VAULT,
          [tx],
          "Ready",
          { requestConfirmation: async () => {} },
        ),
      ).rejects.toThrow(reason);
    }
  });

  it("executes non-operatorOnly transactions in autonomous mode", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "autonomous");
    const txs = [makeTx(), makeTx({ operatorOnly: true })];
    const outcome: TxExecOutcome = { tx: txs[0], result: { confirmed: true, txHash: "0xabc" } as any };
    mockExecuteTxList.mockResolvedValue([outcome]);

    const result = await runTransactionFlow(
      makeEnv(kv),
      OPERATOR,
      VAULT,
      txs,
      "Executing",
      { requestConfirmation: async () => {} },
    );

    expect(result.kind).toBe("executed");
    expect(mockExecuteTxList).toHaveBeenCalledWith(
      expect.objectContaining({ KV: kv }),
      [txs[0]],
      VAULT,
      expect.any(Function),
      undefined,
    );
    expect(result.outcomes).toEqual([outcome]);
  });

  it("falls back to pending_confirmation when all transactions are operatorOnly", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "autonomous");
    const txs = [makeTx({ operatorOnly: true })];

    const result = await runTransactionFlow(
      makeEnv(kv),
      OPERATOR,
      VAULT,
      txs,
      "Needs owner signature",
      {
        requestConfirmation: async () => {},
      },
    );

    expect(result.kind).toBe("pending_confirmation");
    expect(mockExecuteTxList).not.toHaveBeenCalled();
  });

  it("respects the modeOverride regardless of stored preference", async () => {
    const kv = createMockKV();
    await setExecutionModePreference(kv, OPERATOR, "autonomous");
    const txs = [makeTx()];
    const requested: UnsignedTransaction[] = [];

    const result = await runTransactionFlow(
      makeEnv(kv),
      OPERATOR,
      VAULT,
      txs,
      "Overridden",
      {
        requestConfirmation: async (pending) => {
          requested.push(...pending);
        },
      },
      "confirm",
    );

    expect(result.kind).toBe("pending_confirmation");
    expect(mockExecuteTxList).not.toHaveBeenCalled();
  });

  it("returns pending_confirmation for an empty transaction list", async () => {
    const kv = createMockKV();
    const result = await runTransactionFlow(
      makeEnv(kv),
      OPERATOR,
      VAULT,
      [],
      "Nothing to do",
      {
        requestConfirmation: async () => {
          throw new Error("should not be called");
        },
      },
      "autonomous",
    );

    expect(result.kind).toBe("pending_confirmation");
    expect(result.transactions).toEqual([]);
    expect(mockExecuteTxList).not.toHaveBeenCalled();
  });
});
