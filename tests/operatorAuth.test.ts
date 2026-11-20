/**
 * Operator Auth Middleware tests — sessions, signature redemption, rate limits.
 *
 * Auth is payment-independent: these tests only assert operator identity
 * (operatorAuth), session minting, and abuse limits. Payment behavior lives in
 * x402Middleware.test.ts.
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

import { createOperatorAuthMiddleware } from "../src/middleware/operatorAuth.js";

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
  app.use("*", createOperatorAuthMiddleware());
  app.post("/api/chat", (c) =>
    c.json({
      auth: c.get("operatorAuthVerified") ?? false,
      opAuth: c.get("operatorAuth"),
    }));
  app.get("/api/delegation/status", (c) =>
    c.json({
      auth: c.get("operatorAuthVerified") ?? false,
      opAuth: c.get("operatorAuth"),
    }));
  return { app, env: { KV: kv ?? createMockKV() } };
}

const ADDR = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

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

describe("signature redemption", () => {
  beforeEach(() => {
    mockVerifySig.mockReset();
    mockVerifySig.mockResolvedValue(true);
  });

  it("valid signature authenticates and mints a session (token header + HttpOnly cookie)", async () => {
    const { app, env } = createApp();
    const res = await redeem(app, env);
    expect(res.status).toBe(200);
    const token = res.headers.get("X-Session-Token");
    expect(token).toMatch(/^0x[0-9a-f]{64}$/);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("rb_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
    expect(json.opAuth.address).toBe(ADDR);
  });

  it("same signature re-presented from the same context re-issues the same session", async () => {
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

  it("returns 401 for an invalid signature", async () => {
    mockVerifySig.mockResolvedValue(false);
    const { app, env } = createApp();
    const res = await redeem(app, env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toContain("Authentication expired");
  });

  it("session token authenticates subsequent requests (viaSession) on protected AND public routes", async () => {
    const { app, env } = createApp();
    const token = (await redeem(app, env)).headers.get("X-Session-Token")!;

    for (const path of ["/api/chat", "/api/delegation/status"]) {
      const res = await app.request(
        path,
        { method: path === "/api/chat" ? "POST" : "GET", headers: { "x-session-token": token, "user-agent": "test-agent/1.0" } },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.auth).toBe(true);
      expect(json.opAuth.viaSession).toBe(true);
      expect(json.opAuth.address).toBe(ADDR.toLowerCase());
    }
  });

  it("session survives an egress IP rotation — binding is device ID + UA, NOT the IP", async () => {
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

  it("session token from a DIFFERENT device ID is rejected with 401", async () => {
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

  it("unknown session token header is rejected with 401", async () => {
    const { app, env } = createApp();
    const res = await app.request(
      "/api/chat",
      { method: "POST", headers: { "x-session-token": "0x" + "ab".repeat(32) } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("stale session COOKIE degrades to anonymous on public routes (no 401 loop)", async () => {
    const { app, env } = createApp();
    const res = await app.request(
      "/api/delegation/status",
      { method: "GET", headers: { cookie: "rb_session=" + "ff".repeat(64) } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.auth).toBe(false);
  });

  it("without KV no session is minted and signature auth remains (legacy dev)", async () => {
    const app = new Hono<{ Bindings: { KV?: KVNamespace }; Variables: Record<string, unknown> }>();
    app.use("*", createOperatorAuthMiddleware());
    app.post("/api/chat", (c) => c.json({ auth: c.get("operatorAuthVerified") ?? false }));
    const env = {};
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
    const json = (await res.json()) as any;
    expect(json.auth).toBe(true);
  });
});

describe("redemption rate limiting", () => {
  beforeEach(() => {
    mockVerifySig.mockReset();
    mockVerifySig.mockResolvedValue(true);
  });

  it("allows requests under the limit and sets rate limit headers", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const res = await redeem(app, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("returns 429 when the redemption limit is exceeded", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const now = Date.now();
    await kv.put(`rate-limit:${ADDR.toLowerCase()}`, JSON.stringify({ count: 100, windowStart: now }));
    const res = await redeem(app, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
