/**
 * x402 Middleware tests — operator signature bypass, rate limiting, fail-closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockVerifySig } = vi.hoisted(() => ({ mockVerifySig: vi.fn() }));
vi.mock("../src/services/auth.js", () => ({
  verifyOperatorSignatureOnly: mockVerifySig,
}));

import { createX402Middleware } from "../src/middleware/x402.js";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (!val) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
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

function createApp(kv?: KVNamespace) {
  const app = new Hono<{ Bindings: { KV: KVNamespace }; Variables: Record<string, unknown> }>();
  app.use("*", createX402Middleware());
  app.post("/api/chat", (c) => c.json({ auth: c.get("operatorAuthVerified") ?? false }));
  app.get("/api/quote", (c) => c.json({ auth: c.get("operatorAuthVerified") ?? false }));
  app.post("/api/unlisted", (c) => c.json({ ok: true }));
  return { app, env: { KV: kv ?? createMockKV() } };
}

describe("operator signature bypass", () => {
  beforeEach(() => {
    mockVerifySig.mockReset();
  });

  it("sets operatorAuthVerified for protected POST route with valid headers", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.auth).toBe(true);
  });

  it("sets operatorAuthVerified for protected GET route with valid headers", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const res = await app.request(
      "/api/quote",
      {
        method: "GET",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.auth).toBe(true);
  });

  it("returns 401 for invalid signature instead of 402", async () => {
    mockVerifySig.mockResolvedValue(false);
    const { app, env } = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );
    // Auth headers were sent but signature is invalid — should return 401
    // so the frontend knows to re-authenticate instead of confusing the user
    // with a 402 "Payment Required".
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain("Authentication expired");
  });

  it("does NOT bypass when headers are missing", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const res = await app.request("/api/chat", { method: "POST" }, env);
    const json = await res.json();
    expect(json.auth).toBe(false);
  });

  it("does NOT bypass for unlisted /api routes even with valid signature", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const res = await app.request(
      "/api/unlisted",
      {
        method: "POST",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );
    // Unlisted routes fall through to x402 server (which fails in tests → next()).
    // This is a pre-existing behavior when the facilitator is unreachable.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

describe("rate limiting", () => {
  beforeEach(() => {
    mockVerifySig.mockReset();
  });

  it("allows requests under the limit and sets rate limit headers", async () => {
    mockVerifySig.mockResolvedValue(true);
    const kv = createMockKV();
    const { app, env } = createApp(kv);

    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(Number(res.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(Date.now() / 1000);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockVerifySig.mockResolvedValue(true);
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const addr = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

    // Seed KV with 100 requests in current window
    const now = Date.now();
    await kv.put(
      `rate-limit:${addr.toLowerCase()}`,
      JSON.stringify({ count: 100, windowStart: now }),
    );

    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": addr,
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(now),
        },
      },
      env,
    );

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("Rate limit exceeded");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("adds warning header when approaching rate limit", async () => {
    mockVerifySig.mockResolvedValue(true);
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const addr = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

    // Seed KV with 95 requests (5 remaining — below threshold of 10)
    const now = Date.now();
    await kv.put(
      `rate-limit:${addr.toLowerCase()}`,
      JSON.stringify({ count: 95, windowStart: now }),
    );

    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": addr,
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(now),
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    const warning = res.headers.get("X-RateLimit-Warning");
    expect(warning).toContain("4 requests remaining");
    expect(warning).toContain("Resets at");
  });

  it("resets window after expiry", async () => {
    mockVerifySig.mockResolvedValue(true);
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const addr = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

    // Seed KV with expired window
    const expired = Date.now() - 5 * 60 * 60 * 1000; // 5 hours ago
    await kv.put(
      `rate-limit:${addr.toLowerCase()}`,
      JSON.stringify({ count: 100, windowStart: expired }),
    );

    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": addr,
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
  });
});
