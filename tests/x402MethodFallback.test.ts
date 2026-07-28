/**
 * x402 Method Fallback Tests
 *
 * Discovery validators (e.g., agentic.market) sometimes probe POST x402 endpoints
 * with GET requests. The middleware must still return HTTP 402 in that case,
 * rather than its fail-closed 503 "Route not configured" response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { HTTPRequestContext } from "@x402/core/server";

const mockProcessHTTPRequest = vi.hoisted(() => vi.fn());
const mockProcessSettlement = vi.hoisted(() => vi.fn());

vi.mock("@x402/core/server", async () => {
  const actual = await vi.importActual("@x402/core/server");
  return {
    ...actual,
    x402ResourceServer: vi.fn(function (this: Record<string, unknown>) {
      this.register = vi.fn().mockReturnThis();
      this.registerExtension = vi.fn().mockReturnThis();
    }),
    x402HTTPResourceServer: vi.fn(function (this: Record<string, unknown>) {
      this.initialize = vi.fn().mockResolvedValue(undefined);
      this.processHTTPRequest = mockProcessHTTPRequest;
      this.processSettlement = mockProcessSettlement;
    }),
    HTTPFacilitatorClient: vi.fn(function (this: Record<string, unknown>) {}),
  };
});

vi.mock("@x402/evm/exact/server", () => ({
  ExactEvmScheme: vi.fn(function (this: Record<string, unknown>) {}),
}));

vi.mock("@x402/evm/upto/server", () => ({
  UptoEvmScheme: vi.fn(function (this: Record<string, unknown>) {}),
}));

vi.mock("@x402/extensions", () => ({
  bazaarResourceServerExtension: { key: "bazaar" },
}));

vi.mock("@x402/extensions/bazaar", () => ({
  declareDiscoveryExtension: vi.fn((cfg) => ({ bazaar: cfg })),
}));

vi.mock("@coinbase/x402", () => ({
  createFacilitatorConfig: vi.fn(),
}));

vi.mock("../src/services/auth.js", () => ({
  verifyOperatorSignatureOnly: vi.fn().mockResolvedValue(false),
}));

import { createX402Middleware } from "../src/middleware/x402.js";

function create402Response(resource: string) {
  return {
    type: "payment-error" as const,
    response: {
      status: 402,
      headers: { "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0=" },
      body: {
        x402Version: 2,
        error: "Payment required",
        resource: { url: resource, mimeType: "application/json" },
      },
      isHtml: false,
    },
  };
}

function createApp() {
  const app = new Hono<{ Bindings: { CDP_API_KEY_ID: string; CDP_API_KEY_SECRET: string }; Variables: Record<string, unknown> }>();
  app.use("*", createX402Middleware());
  app.post("/api/chat", (c) => c.json({ ok: true }));
  app.get("/api/quote", (c) => c.json({ ok: true }));
  app.post("/api/unlisted", (c) => c.json({ ok: true }));
  return { app, env: { CDP_API_KEY_ID: "test", CDP_API_KEY_SECRET: "test" } };
}

function buildContextDescription(ctx: HTTPRequestContext) {
  return `${ctx.method} ${ctx.path}`;
}

describe("x402 method fallback for GET probes against POST endpoints", () => {
  beforeEach(() => {
    mockProcessHTTPRequest.mockReset();
    mockProcessSettlement.mockReset();
  });

  it("returns 402 when a GET probe hits a POST-only protected route", async () => {
    const { app, env } = createApp();

    mockProcessHTTPRequest.mockImplementation(async (ctx: HTTPRequestContext) => {
      const desc = buildContextDescription(ctx);
      if (desc === "GET /api/chat") {
        return { type: "no-payment-required" as const };
      }
      if (desc === "POST /api/chat") {
        return create402Response("https://trader.rigoblock.com/api/chat");
      }
      return { type: "no-payment-required" as const };
    });

    const res = await app.request("/api/chat", { method: "GET" }, env);
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Payment required");
    expect(body.resource).toMatchObject({ url: "https://trader.rigoblock.com/api/chat" });
    expect(res.headers.get("payment-required")).toBe("eyJ4NDAyVmVyc2lvbiI6Mn0=");

    // The middleware should have re-processed the request as POST.
    expect(mockProcessHTTPRequest).toHaveBeenCalledTimes(2);
    const calls = mockProcessHTTPRequest.mock.calls.map((c) => buildContextDescription(c[0] as HTTPRequestContext));
    expect(calls).toEqual(["GET /api/chat", "POST /api/chat"]);
  });

  it("returns 402 for a normal GET request to a GET protected route", async () => {
    const { app, env } = createApp();

    mockProcessHTTPRequest.mockImplementation(async (ctx: HTTPRequestContext) => {
      if (buildContextDescription(ctx) === "GET /api/quote") {
        return create402Response("https://trader.rigoblock.com/api/quote");
      }
      return { type: "no-payment-required" as const };
    });

    const res = await app.request("/api/quote", { method: "GET" }, env);
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toMatchObject({ url: "https://trader.rigoblock.com/api/quote" });
    expect(mockProcessHTTPRequest).toHaveBeenCalledTimes(1);
  });

  it("returns 402 for a normal POST request to a POST protected route", async () => {
    const { app, env } = createApp();

    mockProcessHTTPRequest.mockImplementation(async (ctx: HTTPRequestContext) => {
      if (buildContextDescription(ctx) === "POST /api/chat") {
        return create402Response("https://trader.rigoblock.com/api/chat");
      }
      return { type: "no-payment-required" as const };
    });

    const res = await app.request("/api/chat", { method: "POST" }, env);
    expect(res.status).toBe(402);
    expect(mockProcessHTTPRequest).toHaveBeenCalledTimes(1);
  });

  it("still returns 503 for /api routes that are not protected at all", async () => {
    const { app, env } = createApp();

    mockProcessHTTPRequest.mockImplementation(async () => ({ type: "no-payment-required" as const }));

    const res = await app.request("/api/unlisted", { method: "GET" }, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Route not configured for access");
  });
});
