/**
 * Oracle Route tests — POST /api/oracle/refresh
 *
 * Tests input validation, auth gate, and direction handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockBuildTx, mockGetNativeSymbol } = vi.hoisted(() => ({
  mockBuildTx: vi.fn(),
  mockGetNativeSymbol: vi.fn(),
}));

vi.mock("../src/services/oraclePool.js", () => ({
  buildOraclePoolSwapTx: mockBuildTx,
  getNativeTokenSymbol: mockGetNativeSymbol,
}));

import { oracle } from "../src/routes/oracle.js";

function createApp() {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>();
  app.use("/api/oracle/*", async (c, next) => {
    if (c.req.header("x-test-x402-paid") === "true") {
      c.set("x402Paid", true);
    }
    if (c.req.header("x-test-browser-verified") === "true") {
      c.set("browserVerified", true);
    }
    await next();
  });
  app.route("/api/oracle", oracle);
  return app;
}

function mockEnv(): Record<string, string> {
  return { ALCHEMY_API_KEY: "test-alchemy-key" };
}

describe("POST /api/oracle/refresh", () => {
  beforeEach(() => {
    mockBuildTx.mockReset();
    mockGetNativeSymbol.mockReset();
    mockGetNativeSymbol.mockReturnValue("ETH");
  });

  it("returns 401 when neither x402-paid nor browser-verified", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "GRG", chainId: 8453 }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when token is missing", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ chainId: 8453 }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("token");
  });

  it("returns 400 when chainId is missing", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ token: "GRG" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("chainId");
  });

  it("returns 400 for invalid direction", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ token: "GRG", chainId: 8453, direction: "swap" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("direction must be 'buy' or 'sell'");
  });

  it("returns 400 for non-positive amount", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ token: "GRG", chainId: 8453, amount: "-1" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("positive decimal number");
  });

  it("returns 400 for scientific notation amount", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ token: "GRG", chainId: 8453, amount: "1e-7" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Scientific notation is not supported");
  });

  it("returns 400 for invalid vaultAddress", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ token: "GRG", chainId: 8453, vaultAddress: "0x123" }),
      },
      mockEnv(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("vaultAddress must be a valid non-zero EVM address");
  });

  it("forwards valid request to buildOraclePoolSwapTx", async () => {
    const app = createApp();
    mockBuildTx.mockResolvedValueOnce({
      transaction: { to: "0xRouter", data: "0xabc", value: "0x0" },
      poolInfo: { tokenSymbol: "GRG" },
    });

    const res = await app.request(
      "/api/oracle/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-x402-paid": "true" },
        body: JSON.stringify({ token: "GRG", chainId: 8453, direction: "sell", amount: "1.5" }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    expect(mockBuildTx).toHaveBeenCalledWith(
      "GRG",
      "1.5",
      8453,
      "test-alchemy-key",
      undefined,
      "sell",
    );
  });
});
