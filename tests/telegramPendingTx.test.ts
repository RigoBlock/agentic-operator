import { describe, it, expect } from "vitest";
import { pendingTxKey, deleteAllPendingTxKeys } from "../src/routes/telegram.js";
import { parseStoredUnsignedTransactions } from "../src/services/execution.js";
import type { KVNamespace } from "@cloudflare/workers-types";

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter(k => k.startsWith(prefix))
        .map(k => ({ name: k }));
      return { keys, list_complete: true, cursor: undefined };
    },
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

describe("Telegram pending transaction key binding", () => {
  it("pendingTxKey includes user id and message id", () => {
    expect(pendingTxKey(123456, 42)).toBe("tg-pending-tx:123456:42");
    expect(pendingTxKey("user-abc", 99)).toBe("tg-pending-tx:user-abc:99");
  });

  it("deleteAllPendingTxKeys removes message-bound keys and returns their message ids", async () => {
    const kv = makeKV();
    await kv.put(pendingTxKey(123456, 10), JSON.stringify({ txs: [], createdAt: 1, messageId: 10 }));
    await kv.put(pendingTxKey(123456, 20), JSON.stringify({ txs: [], createdAt: 2, messageId: 20 }));

    const entries = await deleteAllPendingTxKeys(kv, 123456);
    expect(entries.map(e => e.messageId).sort()).toEqual([10, 20]);
    expect(await kv.get(pendingTxKey(123456, 10))).toBeNull();
    expect(await kv.get(pendingTxKey(123456, 20))).toBeNull();
  });

  it("deleteAllPendingTxKeys removes the legacy shared key for backward compatibility", async () => {
    const kv = makeKV();
    await kv.put("tg-pending-tx:123456", JSON.stringify({ txs: [], createdAt: 1, messageId: 5 }));

    const entries = await deleteAllPendingTxKeys(kv, 123456);
    expect(entries.map(e => e.messageId)).toContain(5);
    expect(await kv.get("tg-pending-tx:123456")).toBeNull();
  });
});

describe("parseStoredUnsignedTransactions", () => {
  const baseTx = {
    to: "0x1111111111111111111111111111111111111111",
    data: "0x1234abcd",
    value: "0x0",
    chainId: 8453,
    gas: "0x1f400",
    maxFeePerGas: "0x9502f9000",
    maxPriorityFeePerGas: "0x59682f00",
    description: "Swap 30 GRG for ETH",
    swapMeta: {
      sellAmount: "30",
      sellToken: "GRG",
      buyAmount: "0.004641",
      buyToken: "ETH",
      price: "1 GRG = 0.0001547 ETH",
      dex: "0x Aggregator",
    },
    navShieldChecked: true,
  };

  it("round-trips a finalized transaction including gas, fees, and nav shield flag", () => {
    const raw = JSON.stringify({ txs: [baseTx], createdAt: Date.now(), messageId: 42 });
    const txs = parseStoredUnsignedTransactions(raw);

    expect(txs).toHaveLength(1);
    const tx = txs[0];
    expect(tx.gas).toBe(baseTx.gas);
    expect(tx.maxFeePerGas).toBe(baseTx.maxFeePerGas);
    expect(tx.maxPriorityFeePerGas).toBe(baseTx.maxPriorityFeePerGas);
    expect(tx.navShieldChecked).toBe(true);
    expect(tx.swapMeta).toEqual(baseTx.swapMeta);
  });

  it("parses a plain array of transactions", () => {
    const raw = JSON.stringify([baseTx]);
    const txs = parseStoredUnsignedTransactions(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].maxFeePerGas).toBe(baseTx.maxFeePerGas);
  });

  it("parses a single transaction object", () => {
    const raw = JSON.stringify(baseTx);
    const txs = parseStoredUnsignedTransactions(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].maxPriorityFeePerGas).toBe(baseTx.maxPriorityFeePerGas);
  });

  it("fills in zeroed fee defaults for legacy stored transactions missing fees", () => {
    const legacy = { ...baseTx, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined };
    const raw = JSON.stringify({ txs: [legacy] });
    const txs = parseStoredUnsignedTransactions(raw);
    expect(txs[0].maxFeePerGas).toBe("0x0");
    expect(txs[0].maxPriorityFeePerGas).toBe("0x0");
  });

  it("fills zeroed defaults for a draft transaction missing gas and fees", () => {
    const draft = {
      to: "0x1111111111111111111111111111111111111111",
      data: "0x1234abcd",
      value: "0x0",
      chainId: 8453,
      description: "Swap 30 GRG for ETH",
    };
    const raw = JSON.stringify({ txs: [draft] });
    const txs = parseStoredUnsignedTransactions(raw);
    expect(txs).toHaveLength(1);
    expect(txs[0].gas).toBe("0x0");
    expect(txs[0].maxFeePerGas).toBe("0x0");
    expect(txs[0].maxPriorityFeePerGas).toBe("0x0");
  });
});
