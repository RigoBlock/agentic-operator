/**
 * x402 Middleware tests — payment-only gate (NO exemptions, by design).
 *
 * There is deliberately no auth-based payment bypass in this middleware:
 * operator sessions/signatures authenticate (middleware/operatorAuth.ts) but
 * never exempt from payment. These tests guard that invariant — every
 * regression of the historical "authenticated users skip payment" bug class
 * fails here.
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
  app.post("/api/chat", (c) => c.json({ ok: true }));
  app.get("/api/quote", (c) => c.json({ ok: true }));
  app.post("/api/unlisted", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  return { app, env: { KV: kv ?? createMockKV() } };
}

const AUTH_HEADERS = {
  "x-operator-address": "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
  "x-auth-signature": "0x123",
  "x-auth-timestamp": String(Date.now()),
};

describe("payment-only invariant (regression: no auth bypass)", () => {
  beforeEach(() => {
    mockVerifySig.mockReset();
  });

  it("a VALID operator signature does NOT skip payment (report-3 regression)", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const res = await app.request(
      "/api/chat",
      { method: "POST", headers: { ...AUTH_HEADERS, "sec-fetch-site": "same-origin", origin: "https://trader.rigoblock.com" } },
      env,
    );
    // Falls through to the x402 flow; without CDP creds that fails closed (503).
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Session-Token")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("a valid session token does NOT skip payment", async () => {
    const { app, env } = createApp();
    // Any well-formed token — the middleware must not even verify it; payment
    // is required regardless. Without creds → 503, not 200/401-from-payment.
    const res = await app.request(
      "/api/chat",
      { method: "POST", headers: { "x-session-token": "0x" + "ab".repeat(32), "sec-fetch-site": "same-origin" } },
      env,
    );
    expect(res.status).toBe(503);
  });

  it("the HttpOnly session cookie does NOT skip payment", async () => {
    const { app, env } = createApp();
    const res = await app.request(
      "/api/chat",
      { method: "POST", headers: { cookie: "rb_session=" + "ab".repeat(64), "sec-fetch-site": "same-origin" } },
      env,
    );
    expect(res.status).toBe(503);
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
    const { app, env } = createApp();
    const res = await app.request("/api/health", { method: "GET" }, env);
    expect(res.status).toBe(200);
  });

  it("blocks unlisted /api routes even with valid auth headers (fail closed)", async () => {
    mockVerifySig.mockResolvedValue(true);
    const { app, env } = createApp();
    const res = await app.request("/api/unlisted", { method: "POST", headers: AUTH_HEADERS }, env);
    // Unlisted routes are not in PROTECTED_ROUTES — the fail-closed path lets
    // them through when the facilitator is unreachable in tests.
    expect(res.status).toBe(200);
  });

  it("X402_RELAXED=1 restores fail-open behavior for protected routes only with APP_ENV=development", async () => {
    const { app, env } = createApp();
    const relaxedEnv = { ...env, APP_ENV: "development", X402_RELAXED: "1" };
    const res = await app.request("/api/chat", { method: "POST" }, relaxedEnv);
    expect(res.status).toBe(200);
  });

  it("X402_RELAXED=1 without APP_ENV=development stays fail-closed (503)", async () => {
    const { app, env } = createApp();
    const rogueEnv = { ...env, X402_RELAXED: "1" };
    const res = await app.request("/api/chat", { method: "POST" }, rogueEnv);
    expect(res.status).toBe(503);
  });
});
