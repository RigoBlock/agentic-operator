import { describe, it, expect } from "vitest";
import { pendingTxKey, deleteAllPendingTxKeys } from "../src/routes/telegram.js";
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

  it("deleteAllPendingTxKeys only removes keys for the specified user", async () => {
    const kv = makeKV();
    await kv.put(pendingTxKey(111, 1), JSON.stringify({ txs: [], createdAt: 1, messageId: 1 }));
    await kv.put(pendingTxKey(222, 2), JSON.stringify({ txs: [], createdAt: 2, messageId: 2 }));

    await deleteAllPendingTxKeys(kv, 111);
    expect(await kv.get(pendingTxKey(111, 1))).toBeNull();
    expect(await kv.get(pendingTxKey(222, 2))).not.toBeNull();
  });
});
