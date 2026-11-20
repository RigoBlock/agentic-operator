/**
 * CDP facilitator /supported pin tests — the pinned document is served to
 * every caller until TTL, so all isolates share one facilitatorAddress.
 */
import { describe, it, expect, vi } from "vitest";
import { pinSupportedInKv, SUPPORTED_CACHE_KEY } from "../src/services/cdpFacilitator.js";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (!val) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

const SUPPORTED = {
  kinds: [{ x402Version: 2, scheme: "upto", network: "eip155:8453", extra: { facilitatorAddress: "0x1111111111111111111111111111111111111111" } }],
  extensions: [],
  signers: {},
};

describe("pinSupportedInKv", () => {
  it("fetches once, then serves the cached document to every caller", async () => {
    const kv = createMockKV();
    const fetchSupported = vi.fn().mockResolvedValue(SUPPORTED);
    const inner = { getSupported: fetchSupported };
    const pinned = pinSupportedInKv(kv, inner);

    const first = await pinned.getSupported();
    const second = await pinned.getSupported();
    const third = await pinned.getSupported();

    expect(fetchSupported).toHaveBeenCalledTimes(1); // fetched once, pinned after
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // Stored in KV so OTHER isolates get the same document.
    const cached = await kv.get(SUPPORTED_CACHE_KEY, "json");
    expect(cached).toEqual(SUPPORTED);
  });

  it("reuses a pre-existing KV cache without fetching", async () => {
    const kv = createMockKV();
    await kv.put(SUPPORTED_CACHE_KEY, JSON.stringify(SUPPORTED));
    const fetchSupported = vi.fn();
    const inner = { getSupported: fetchSupported };
    const pinned = pinSupportedInKv(kv, inner);
    const result = await pinned.getSupported();
    expect(result).toEqual(SUPPORTED);
    expect(fetchSupported).not.toHaveBeenCalled();
  });

  it("pass through untouched without KV (unit tests)", async () => {
    const fetchSupported = vi.fn().mockResolvedValue(SUPPORTED);
    const inner = { getSupported: fetchSupported };
    const pinned = pinSupportedInKv(undefined, inner);
    expect(await pinned.getSupported()).toEqual(SUPPORTED);
    expect(fetchSupported).toHaveBeenCalledTimes(1);
  });
});
