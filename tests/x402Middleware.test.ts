/**
 * x402 Middleware tests — operator signature bypass, rate limiting, fail-closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockVerifySig } = vi.hoisted(() => ({ mockVerifySig: vi.fn() }));
vi.mock("../src/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/auth.js")>();
  return {
    ...actual,
    verifyOperatorSignatureOnly: mockVerifySig,
  };
});

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
  app.post("/api/chat", (c) =>
    c.json({
      auth: c.get("operatorAuthVerified") ?? false,
      opAuth: c.get("operatorAuth"),
    }));
  app.get("/api/quote", (c) =>
    c.json({
      auth: c.get("operatorAuthVerified") ?? false,
      opAuth: c.get("operatorAuth"),
    }));
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
    const ts = Date.now();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
    expect(json.opAuth).toEqual({
      address: "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
      signature: "0x123",
      timestamp: ts,
    });
  });

  it("sets operatorAuthVerified for protected GET route with valid headers", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const ts = Date.now();
    const res = await app.request(
      "/api/quote",
      {
        method: "GET",
        headers: {
          "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
          "x-auth-signature": "0x123",
          "x-auth-timestamp": String(ts),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
    expect(json.opAuth).toEqual({
      address: "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
      signature: "0x123",
      timestamp: ts,
    });
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
    const json = (await res.json()) as any;
    expect(json.error).toContain("Authentication expired");
  });

  it("fails closed (503) on protected routes when headers are missing and payment cannot be verified", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    // No auth headers + no CDP creds → payment cannot be verified for a
    // PROTECTED route → must fail closed with 503, not serve the endpoint free.
    const res = await app.request("/api/chat", { method: "POST" }, env);
    expect(res.status).toBe(503);
    const json = (await res.json()) as any;
    expect(json.error).toBe("Payment verification unavailable");
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
    // Unlisted routes are NOT in PROTECTED_ROUTES — payment is not required
    // for them, so the fail-closed path lets them through when the facilitator
    // is unreachable in tests.
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
  });
});

describe("fail-closed payment verification (F4)", () => {
  beforeEach(() => {
    mockVerifySig.mockReset();
  });

  it("returns 503 for protected routes when CDP credentials are missing", async () => {
    const { app, env } = createApp();
    const res = await app.request("/api/chat", { method: "POST" }, env);
    expect(res.status).toBe(503);
    const json = (await res.json()) as any;
    expect(json.error).toBe("Payment verification unavailable");
  });

  it("returns 503 for protected GET routes when CDP credentials are missing", async () => {
    const { app, env } = createApp();
    const res = await app.request("/api/quote", { method: "GET" }, env);
    expect(res.status).toBe(503);
  });

  it("still serves public routes without credentials", async () => {
    const app = new Hono<{ Bindings: { KV: KVNamespace }; Variables: Record<string, unknown> }>();
    app.use("*", createX402Middleware());
    app.get("/api/health", (c) => c.json({ ok: true }));
    const env = { KV: createMockKV() };
    const res = await app.request("/api/health", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
  });

  it("X402_RELAXED=1 restores fail-open behavior for protected routes only with APP_ENV=development", async () => {
    const { app, env } = createApp();
    const relaxedEnv = { ...env, APP_ENV: "development", X402_RELAXED: "1" };
    const res = await app.request("/api/chat", { method: "POST" }, relaxedEnv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.auth).toBe(false); // no operator auth — just allowed through
  });

  it("X402_RELAXED=1 without APP_ENV=development stays fail-closed (503)", async () => {
    const { app, env } = createApp();
    const rogueEnv = { ...env, X402_RELAXED: "1" };
    const res = await app.request("/api/chat", { method: "POST" }, rogueEnv);
    expect(res.status).toBe(503);
  });

  it("operator header-auth bypass still works when CDP credentials are missing", async () => {
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
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
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
    const json = (await res.json()) as any;
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

describe("session tokens (single-use signature redemption)", () => {
  const ADDR = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

  beforeEach(() => {
    mockVerifySig.mockReset();
    mockVerifySig.mockResolvedValue(true);
  });

  async function redeem(app: ReturnType<typeof createApp>["app"], env: { KV: KVNamespace }, ua = "test-agent/1.0") {
    return app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": ADDR,
          "x-auth-signature": "0xdeadbeef",
          "x-auth-timestamp": String(Date.now()),
          "user-agent": ua,
        },
      },
      env,
    );
  }

  it("redeems a valid signature for an X-Session-Token and skips payment", async () => {
    const { app, env } = createApp();
    const res = await redeem(app, env);
    expect(res.status).toBe(200);
    const token = res.headers.get("X-Session-Token");
    expect(token).toMatch(/^0x[0-9a-f]{64}$/);
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
  });

  it("session token alone skips payment and marks viaSession", async () => {
    const { app, env } = createApp();
    const first = await redeem(app, env);
    const token = first.headers.get("X-Session-Token")!;

    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "test-agent/1.0" },
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
    expect(json.opAuth.viaSession).toBe(true);
    expect(json.opAuth.address).toBe(ADDR.toLowerCase());
  });

  it("same signature re-presented from the same network re-issues the same session (concurrent page loads)", async () => {
    const { app, env } = createApp();
    const t1 = (await redeem(app, env)).headers.get("X-Session-Token");
    const t2 = (await redeem(app, env)).headers.get("X-Session-Token");
    expect(t2).toBe(t1);
  });

  it("redeemed signature from a DIFFERENT network is rejected with 401", async () => {
    const { app, env } = createApp();
    await redeem(app, env, "test-agent/1.0");
    const res = await redeem(app, env, "evil-agent/2.0");
    expect(res.status).toBe(401);
  });

  it("session token from a different network is rejected with 401", async () => {
    const { app, env } = createApp();
    const token = (await redeem(app, env, "test-agent/1.0")).headers.get("X-Session-Token")!;
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "evil-agent/2.0" },
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("session survives an egress IP rotation — binding is device ID + UA, NOT cf-connecting-ip (IPv6 privacy-extensions regression)", async () => {
    const { app, env } = createApp();
    const device = "0x" + "11".repeat(16);
    const first = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": ADDR,
          "x-auth-signature": "0xdeadbeef",
          "x-auth-timestamp": String(Date.now()),
          "user-agent": "test-agent/1.0",
          "x-device-id": device,
          "cf-connecting-ip": "2001:db8::1",
        },
      },
      env,
    );
    const token = first.headers.get("X-Session-Token")!;
    expect(token).toBeTruthy();

    // Same device ID + UA from a rotated IPv6 address must still authenticate
    // (under the old IP-bound implementation this returned 401 and looped
    // the user through continuous re-signs).
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-session-token": token,
          "user-agent": "test-agent/1.0",
          "x-device-id": device,
          "cf-connecting-ip": "2001:db8::2",
        },
      },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("session token presented from a DIFFERENT device ID is rejected with 401", async () => {
    const { app, env } = createApp();
    const token = (
      await app.request(
        "/api/chat",
        {
          method: "POST",
          headers: {
            "x-operator-address": ADDR,
            "x-auth-signature": "0xdeadbeef",
            "x-auth-timestamp": String(Date.now()),
            "user-agent": "test-agent/1.0",
            "x-device-id": "0x" + "11".repeat(16),
          },
        },
        env,
      )
    ).headers.get("X-Session-Token")!;
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-session-token": token,
          "user-agent": "test-agent/1.0",
          "x-device-id": "0x" + "22".repeat(16),
        },
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("unknown session token is rejected with 401 on protected routes", async () => {
    const { app, env } = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "x-session-token": "0x" + "ab".repeat(32) },
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("without KV no session is minted and the legacy behavior remains", async () => {
    const app = new Hono<{ Bindings: { KV?: KVNamespace }; Variables: Record<string, unknown> }>();
    app.use("*", createX402Middleware());
    app.post("/api/chat", (c) => c.json({ auth: c.get("operatorAuthVerified") ?? false }));
    const env = {}; // no KV binding
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": ADDR,
          "x-auth-signature": "0xdeadbeef",
          "x-auth-timestamp": String(Date.now()),
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Session-Token")).toBeNull();
  });
});
