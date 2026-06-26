/**
 * Settings route tests — POST /api/settings/*
 *
 * Verifies that operator-scoped safety settings can be mutated through dedicated
 * endpoints (not through the chat LLM) and that auth is enforced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockVerifyOperatorAuth } = vi.hoisted(() => ({
  mockVerifyOperatorAuth: vi.fn(),
}));

vi.mock("../src/services/auth.js", () => ({
  verifyOperatorAuth: mockVerifyOperatorAuth,
  AuthError: class AuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { settings } from "../src/routes/settings.js";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createApp() {
  const app = new Hono<{ Bindings: { KV: KVNamespace; ALCHEMY_API_KEY: string } }>();
  app.route("/api/settings", settings);
  return app;
}

const baseBody = {
  vaultAddress: "0x1111111111111111111111111111111111111111",
  chainId: 8453,
  operatorAddress: "0x2222222222222222222222222222222222222222",
  authSignature: "0xabcd",
  authTimestamp: Date.now(),
};

describe("Settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOperatorAuth.mockResolvedValue(undefined);
  });

  it("returns 401 when auth fields are missing", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/settings/slippage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slippage: "0.5%" }),
      },
      { KV: createMockKV(), ALCHEMY_API_KEY: "test" },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toContain("Missing operator authentication");
  });

  it("sets slippage via /api/settings/slippage", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/settings/slippage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...baseBody, slippage: "0.5%" }),
      },
      { KV: createMockKV(), ALCHEMY_API_KEY: "test" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toContain("0.5%");
  });

  it("sets swap-shield tolerance via /api/settings/swap-shield", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/settings/swap-shield",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...baseBody, tolerance: "30%" }),
      },
      { KV: createMockKV(), ALCHEMY_API_KEY: "test" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toContain("30%");
  });

  it("resets swap-shield via /api/settings/swap-shield", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/settings/swap-shield",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...baseBody, reset: true }),
      },
      { KV: createMockKV(), ALCHEMY_API_KEY: "test" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toContain("5%");
  });

  it("sets NAV-shield threshold via /api/settings/nav-shield", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/settings/nav-shield",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...baseBody, threshold: "15%" }),
      },
      { KV: createMockKV(), ALCHEMY_API_KEY: "test" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toContain("15%");
  });

  it("resets NAV-shield via /api/settings/nav-shield", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/settings/nav-shield",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...baseBody, reset: true }),
      },
      { KV: createMockKV(), ALCHEMY_API_KEY: "test" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.message).toContain("10%");
  });
});
