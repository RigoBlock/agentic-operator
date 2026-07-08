import { describe, it, expect, vi, beforeEach } from "vitest";
import { initTokenResolver, resolveTokenBySymbol, verifyAndRegisterToken, clearTokenResolverCache } from "../src/services/tokenResolver.js";

function makeMockKv() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  };
}

function makeMockFetch(scenarios: Record<string, () => { ok: boolean; status: number; json: unknown } | Response>) {
  return vi.fn(async (url: string) => {
    for (const [prefix, handler] of Object.entries(scenarios)) {
      if (url.includes(prefix)) {
        const res = handler();
        return res instanceof Response ? res : new Response(JSON.stringify(res.json), {
          status: res.status,
          statusText: res.ok ? "OK" : "Error",
        });
      }
    }
    return new Response("{}", { status: 200, statusText: "OK" });
  });
}

describe("resolveTokenBySymbol", () => {
  beforeEach(() => {
    clearTokenResolverCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns a single CoinGecko match and caches it in KV", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    vi.stubGlobal("fetch", makeMockFetch({
      "/search?": () => ({
        ok: true,
        status: 200,
        json: {
          coins: [{ id: "lighter", symbol: "LIT", name: "Lighter", market_cap_rank: 93 }],
        },
      }),
      "/coins/lighter": () => ({
        ok: true,
        status: 200,
        json: { platforms: { ethereum: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" } },
      }),
    }));

    const addr = await resolveTokenBySymbol(1, "LIT");
    expect(addr.toLowerCase()).toBe("0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2");
    expect(kv.put).toHaveBeenCalled();
  });

  it("returns the single KV-cached candidate without calling CoinGecko", async () => {
    const kv = makeMockKv();
    kv._store.set("tokens:1:LIT", JSON.stringify([{
      address: "0x2222222222222222222222222222222222222222",
      name: "Cached LIT",
      symbol: "LIT",
      chainId: 1,
      source: "verified",
    }]));
    initTokenResolver(kv as unknown as KVNamespace);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const addr = await resolveTokenBySymbol(1, "LIT");
    expect(addr.toLowerCase()).toBe("0x2222222222222222222222222222222222222222");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws a disambiguation error when multiple tokens match", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    vi.stubGlobal("fetch", makeMockFetch({
      "/search?": () => ({
        ok: true,
        status: 200,
        json: {
          coins: [
            { id: "lighter", symbol: "LIT", name: "Lighter", market_cap_rank: 93 },
            { id: "litentry", symbol: "LIT", name: "Litentry", market_cap_rank: 1560 },
          ],
        },
      }),
      "/coins/lighter": () => ({
        ok: true,
        status: 200,
        json: { platforms: { ethereum: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" } },
      }),
      "/coins/litentry": () => ({
        ok: true,
        status: 200,
        json: { platforms: { ethereum: "0xb59490aB09A0f526Cc7305822aC65f2Ab12f9723" } },
      }),
    }));

    await expect(resolveTokenBySymbol(1, "LIT")).rejects.toThrow(/Multiple tokens match/);
  });

  it("falls back to asking for an address when CoinGecko is slow", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    vi.stubGlobal("fetch", vi.fn(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Timeout")), 50);
    })));

    await expect(resolveTokenBySymbol(1, "SLOW")).rejects.toThrow(/temporarily unavailable/);
  });
});

describe("verifyAndRegisterToken", () => {
  beforeEach(() => {
    clearTokenResolverCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("verifies an address with CoinGecko and stores the mapping", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);
    const address = "0x3333333333333333333333333333333333333333";

    vi.stubGlobal("fetch", makeMockFetch({
      "/coins/ethereum/contract/": () => ({
        ok: true,
        status: 200,
        json: { id: "lighter", symbol: "lit", name: "Lighter", platforms: { ethereum: address } },
      }),
    }));

    const stored = await verifyAndRegisterToken(1, "LIT", address);
    expect(stored.toLowerCase()).toBe(address);

    // Subsequent lookups should not hit CoinGecko.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const resolved = await resolveTokenBySymbol(1, "LIT");
    expect(resolved.toLowerCase()).toBe(address);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("verifies a name with CoinGecko and stores the mapping", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    vi.stubGlobal("fetch", makeMockFetch({
      "/search?": () => ({
        ok: true,
        status: 200,
        json: {
          coins: [
            { id: "lighter", symbol: "LIT", name: "Lighter", market_cap_rank: 93 },
            { id: "litentry", symbol: "LIT", name: "Litentry", market_cap_rank: 1560 },
          ],
        },
      }),
      "/coins/lighter": () => ({
        ok: true,
        status: 200,
        json: { platforms: { ethereum: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" } },
      }),
    }));

    const stored = await verifyAndRegisterToken(1, "LIT", "Lighter");
    expect(stored.toLowerCase()).toBe("0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2");
  });

  it("rejects an address that CoinGecko does not recognize for the symbol", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    vi.stubGlobal("fetch", makeMockFetch({
      "/coins/ethereum/contract/": () => ({
        ok: true,
        status: 200,
        json: { id: "other", symbol: "OTHER", name: "Other Token", platforms: { ethereum: "0x3333333333333333333333333333333333333333" } },
      }),
    }));

    await expect(verifyAndRegisterToken(1, "LIT", "0x3333333333333333333333333333333333333333")).rejects.toThrow(
      /does not recognize/,
    );
  });

  it("rejects a malformed address", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    await expect(verifyAndRegisterToken(1, "LIT", "0x999999")).rejects.toThrow(/Invalid contract address/);
  });
});


describe("CoinGecko API resilience", () => {
  beforeEach(() => {
    clearTokenResolverCache();
  });

  it("does not retry on CoinGecko 429 and asks for address/name", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    const fetchMock = vi.fn(async () => new Response("rate limit", { status: 429, statusText: "Too Many Requests" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveTokenBySymbol(1, "LIT")).rejects.toThrow(/rate-limited/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends no auth headers when no API key is configured", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const url = _url as string;
      expect(init?.headers).toBeUndefined();
      if (url.includes("/search?")) {
        return new Response(JSON.stringify({
          coins: [{ id: "lighter", symbol: "LIT", name: "Lighter", market_cap_rank: 93 }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ platforms: { ethereum: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const addr = await resolveTokenBySymbol(1, "LIT");
    expect(addr.toLowerCase()).toBe("0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the x-cg-demo-api-key header when COINGECKO_API_KEY is configured", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace, "demo-key-123");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const url = _url as string;
      if (url.includes("/search?")) {
        expect(init?.headers).toMatchObject({ "x-cg-demo-api-key": "demo-key-123" });
        return new Response(JSON.stringify({
          coins: [{ id: "lighter", symbol: "LIT", name: "Lighter", market_cap_rank: 93 }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ platforms: { ethereum: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const addr = await resolveTokenBySymbol(1, "LIT");
    expect(addr.toLowerCase()).toBe("0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent lookups for the same chain+symbol", async () => {
    const kv = makeMockKv();
    initTokenResolver(kv as unknown as KVNamespace);

    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (url.includes("/search?")) {
        return new Response(JSON.stringify({
          coins: [{ id: "lighter", symbol: "LIT", name: "Lighter", market_cap_rank: 93 }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        platforms: { ethereum: "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2" },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [addr1, addr2] = await Promise.all([
      resolveTokenBySymbol(1, "LIT"),
      resolveTokenBySymbol(1, "LIT"),
    ]);

    expect(addr1).toBe(addr2);
    expect(callCount).toBe(2); // one shared search + one shared detail
  });
});
