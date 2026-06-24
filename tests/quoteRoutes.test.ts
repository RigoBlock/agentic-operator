/**
 * Quote Routes tests — oracle-protected Uniswap and 0x quote endpoints.
 *
 * Tests:
 * 1. Auth gate (401 without x402 payment or browser session)
 * 2. x402-paid access works
 * 3. Browser-exempt access works
 * 4. Body/query params forwarded verbatim to upstream
 * 5. Oracle enrichment appended to upstream response
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockEnrich } = vi.hoisted(() => ({
  mockEnrich: vi.fn(),
}));

vi.mock("../src/services/quoteEnrichment.js", () => ({
  enrichQuoteWithOracle: mockEnrich,
}));

import { quoteUniswap } from "../src/routes/quoteUniswap.js";
import { quote0x } from "../src/routes/quote0x.js";

function createApp() {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>();

  // Test helper middleware: sets x402Paid / operatorAuthVerified from headers
  app.use("/api/quote/*", async (c, next) => {
    if (c.req.header("x-test-x402-paid") === "true") {
      c.set("x402Paid", true);
    }
    if (c.req.header("x-test-operator-auth-verified") === "true") {
      c.set("operatorAuthVerified", true);
    }
    await next();
  });

  app.route("/api/quote/uniswap", quoteUniswap);
  app.route("/api/quote/0x", quote0x);

  return app;
}

function mockEnv(): Record<string, string> {
  return {
    UNISWAP_API_KEY: "test-uniswap-key",
    ZEROX_API_KEY: "test-0x-key",
    ALCHEMY_API_KEY: "test-alchemy-key",
  };
}

describe("POST /api/quote/uniswap", () => {
  beforeEach(() => {
    mockEnrich.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns 401 when neither x402-paid nor browser-verified", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/quote/uniswap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "EXACT_INPUT", amount: "1000" }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Authentication required");
  });

  it("forwards body verbatim to Uniswap Trading API when x402-paid", async () => {
    const app = createApp();
    const upstreamResponse = {
      routing: "CLASSIC",
      quote: { input: { token: "ETH", amount: "1000" }, output: { token: "USDC", amount: "2000" } },
    };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );

    mockEnrich.mockResolvedValueOnce({ priceFeedExists: true, deltaBps: 5, oracleAmount: "2100" });

    const body = {
      type: "EXACT_INPUT",
      amount: "1000000000000000000",
      tokenIn: "0x0000000000000000000000000000000000000000",
      tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenInChainId: 8453,
      tokenOutChainId: 8453,
      swapper: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      slippageTolerance: 0.5,
    };

    const res = await app.request(
      "/api/quote/uniswap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-x402-paid": "true",
        },
        body: JSON.stringify(body),
      },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.routing).toBe("CLASSIC");
    expect(json.priceFeedExists).toBe(true);
    expect(json.deltaBps).toBe(5);
    expect(json.oracleAmount).toBe("2100");

    // Verify the body was forwarded verbatim — no stripping
    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const forwardedBody = JSON.parse(fetchCalls[0][1].body);
    expect(forwardedBody).toEqual(body);
    expect(forwardedBody.swapper).toBe(body.swapper);
    expect(forwardedBody.slippageTolerance).toBe(body.slippageTolerance);
    expect(forwardedBody).not.toHaveProperty("requirePriceFeed");
  });

  it("returns upstream error verbatim when Uniswap returns 4xx/5xx", async () => {
    const app = createApp();
    const upstreamError = { errorCode: "INVALID_TOKEN", detail: "Token not found" };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamError), { status: 400, headers: { "content-type": "application/json" } }),
    );

    const res = await app.request(
      "/api/quote/uniswap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-x402-paid": "true",
        },
        body: JSON.stringify({ type: "EXACT_INPUT", amount: "1000" }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorCode).toBe("INVALID_TOKEN");
  });

  it("gracefully handles missing oracle enrichment (returns upstream + zeros)", async () => {
    const app = createApp();
    const upstreamResponse = {
      routing: "CLASSIC",
      quote: { input: { token: "ETH", amount: "1000" }, output: { token: "USDC", amount: "2000" } },
    };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );

    mockEnrich.mockRejectedValueOnce(new Error("RPC down"));

    const res = await app.request(
      "/api/quote/uniswap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-x402-paid": "true",
        },
        body: JSON.stringify({ type: "EXACT_INPUT", amount: "1000", tokenIn: "ETH", tokenOut: "USDC", tokenInChainId: 1, tokenOutChainId: 1 }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.routing).toBe("CLASSIC");
    expect(json.priceFeedExists).toBe(false);
    expect(json.deltaBps).toBe(0);
    expect(json.oracleAmount).toBe("0");
  });

  it("skips oracle enrichment for EXACT_OUTPUT quotes (avoids meaningless deltaBps)", async () => {
    const app = createApp();
    const upstreamResponse = {
      routing: "CLASSIC",
      quote: { input: { token: "ETH", amount: "1000" }, output: { token: "USDC", amount: "2000" } },
    };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await app.request(
      "/api/quote/uniswap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-x402-paid": "true",
        },
        body: JSON.stringify({
          type: "EXACT_OUTPUT",
          amount: "2000",
          tokenIn: "ETH",
          tokenOut: "USDC",
          tokenInChainId: 8453,
          tokenOutChainId: 8453,
        }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.priceFeedExists).toBe(false);
    expect(json.deltaBps).toBe(0);
    expect(json.oracleAmount).toBe("0");
    // enrichQuoteWithOracle should NOT have been called for EXACT_OUTPUT
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("skips oracle enrichment when chainId is missing (avoids defaulting to chain 1)", async () => {
    const app = createApp();
    const upstreamResponse = {
      routing: "CLASSIC",
      quote: { input: { token: "ETH", amount: "1000" }, output: { token: "USDC", amount: "2000" } },
    };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await app.request(
      "/api/quote/uniswap",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-x402-paid": "true",
        },
        body: JSON.stringify({
          type: "EXACT_INPUT",
          amount: "1000",
          tokenIn: "ETH",
          tokenOut: "USDC",
          // intentionally omitting tokenInChainId and chainId
        }),
      },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.priceFeedExists).toBe(false);
    expect(json.deltaBps).toBe(0);
    expect(json.oracleAmount).toBe("0");
    // enrichQuoteWithOracle should NOT have been called when chainId is missing
    expect(mockEnrich).not.toHaveBeenCalled();
  });
});

describe("GET /api/quote/0x", () => {
  beforeEach(() => {
    mockEnrich.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns 401 when neither x402-paid nor browser-verified", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/quote/0x?chainId=8453&sellToken=ETH&buyToken=USDC&sellAmount=1000",
      {},
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Authentication required");
  });

  it("forwards query params verbatim to 0x API when x402-paid", async () => {
    const app = createApp();
    const upstreamResponse = {
      buyAmount: "2000000000",
      sellAmount: "1000000000000000000",
      price: "0.0005",
    };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );

    mockEnrich.mockResolvedValueOnce({ priceFeedExists: true, deltaBps: -3, oracleAmount: "2050000000" });

    const query = "chainId=8453&sellToken=0x0000000000000000000000000000000000000000&buyToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&sellAmount=1000000000000000000&taker=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&slippageBps=100";

    const res = await app.request(
      `/api/quote/0x?${query}`,
      { headers: { "x-test-x402-paid": "true" } },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.buyAmount).toBe("2000000000");
    expect(json.priceFeedExists).toBe(true);
    expect(json.deltaBps).toBe(-3);

    // Verify query params forwarded verbatim
    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const upstreamUrl = fetchCalls[0][0];
    expect(upstreamUrl).toContain("chainId=8453");
    expect(upstreamUrl).toContain("sellToken=0x0000000000000000000000000000000000000000");
    expect(upstreamUrl).toContain("taker=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(upstreamUrl).toContain("slippageBps=100");
    expect(upstreamUrl).not.toContain("requirePriceFeed");
  });

  it("returns upstream error verbatim when 0x returns 4xx/5xx", async () => {
    const app = createApp();
    const upstreamError = { reason: "Validation Failed", validationErrors: [{ field: "sellAmount", code: "1004" }] };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamError), { status: 400, headers: { "content-type": "application/json" } }),
    );

    const res = await app.request(
      "/api/quote/0x?chainId=8453&sellToken=ETH&buyToken=USDC&sellAmount=1000",
      { headers: { "x-test-x402-paid": "true" } },
      mockEnv(),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("Validation Failed");
  });

  it("forwards buyAmount for exact-output quotes and runs oracle enrichment", async () => {
    const app = createApp();
    const upstreamResponse = {
      buyAmount: "2000000000",
      estimatedNetSellAmount: "1000000000000000000",
      maxSellAmount: "1010000000000000000",
      mode: "exact-out",
    };

    (global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), { status: 200, headers: { "content-type": "application/json" } }),
    );

    mockEnrich.mockResolvedValueOnce({ priceFeedExists: true, deltaBps: 2, oracleAmount: "1995000000" });

    const query = "chainId=8453&sellToken=0x0000000000000000000000000000000000000000&buyToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&buyAmount=2000000000&taker=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&slippageBps=100";

    const res = await app.request(
      `/api/quote/0x?${query}`,
      { headers: { "x-test-x402-paid": "true" } },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.buyAmount).toBe("2000000000");
    expect(json.priceFeedExists).toBe(true);
    expect(json.deltaBps).toBe(2);

    // Verify query params forwarded verbatim
    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls.length).toBe(1);
    const upstreamUrl = fetchCalls[0][0];
    expect(upstreamUrl).toContain("buyAmount=2000000000");
    expect(upstreamUrl).not.toContain("sellAmount=");

    // Oracle enrichment should use the response sellAmount as input
    expect(mockEnrich).toHaveBeenCalledWith(
      8453,
      "0x0000000000000000000000000000000000000000",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "1000000000000000000",
      "2000000000",
      "test-alchemy-key",
    );
  });
});
