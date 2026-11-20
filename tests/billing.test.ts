/**
 * Billing tests — deposit status, payment-header signing, withdrawals.
 *
 * CDP and RPC are mocked (the signer is deterministic in tests); the KV is a
 * real in-memory mock so session auth flows through the real auth service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { getAddress } from "viem";

const { mockVerifySig } = vi.hoisted(() => ({ mockVerifySig: vi.fn() }));
const cdpMocks = vi.hoisted(() => ({
  getOrCreateAccount: vi.fn(),
  getAccount: vi.fn(),
  signTypedData: vi.fn(),
}));
const rpcMocks = vi.hoisted(() => ({
  readContract: vi.fn(),
}));
const facilitatorMocks = vi.hoisted(() => ({
  getSupported: vi.fn(),
}));

vi.mock("../src/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/auth.js")>();
  return { ...actual, verifyOperatorSignatureOnly: mockVerifySig };
});

const x402ServerMocks = vi.hoisted(() => {
  // Simulates the resource server's OWN requirement pipeline: the enriched
  // accepts a 402 would carry (note the facilitator address — signing must
  // use exactly this, not a separately-discovered one).
  const FACILITATOR = "0x5E77b1B87D3F9f4B2f7d8C1234567890123456f1";
  const accepts = [
    {
      scheme: "upto",
      network: "eip155:8453",
      amount: "200000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
      maxTimeoutSeconds: 300,
      extra: {
        name: "USD Coin",
        version: "2",
        assetTransferMethod: "permit2",
        facilitatorAddress: FACILITATOR,
      },
    },
  ];
  return {
    accepts,
    routeExists: vi.fn(() => true),
  };
});

vi.mock("@x402/core/server", async () => {
  const actual = await vi.importActual("@x402/core/server");
  return {
    ...actual,
    HTTPFacilitatorClient: class {
      getSupported = facilitatorMocks.getSupported;
    },
    x402ResourceServer: class {
      register = vi.fn().mockReturnThis();
      registerExtension = vi.fn().mockReturnThis();
    },
    x402HTTPResourceServer: class {
      initialize = vi.fn().mockResolvedValue(undefined);
      getRouteConfig = (_path: string, _method: string) =>
        x402ServerMocks.routeExists() ? { config: { resource: "https://trader.rigoblock.com/api/chat", accepts: [] } } : null;
      normalizePaymentOptions = (config: unknown) => (config as { accepts: unknown[] }).accepts;
      ResourceServer = {
        buildPaymentRequirementsFromOptions: vi.fn().mockResolvedValue([]),
        createPaymentRequiredResponse: vi.fn().mockResolvedValue({
          accepts: x402ServerMocks.accepts,
          resource: { url: "https://trader.rigoblock.com/api/chat" },
          extensions: {
            bazaar: { info: { test: true } },
            eip2612GasSponsoring: {
              info: { description: "Facilitator accepts EIP-2612 gasless Permit.", version: "1" },
              schema: { type: "object" },
            },
          },
        }),
        enrichExtensions: (extensions: unknown) => extensions,
      };
    },
  };
});

vi.mock("@coinbase/x402", async () => {
  const actual = await vi.importActual("@coinbase/x402");
  return { ...actual, createFacilitatorConfig: vi.fn(() => ({})) };
});

vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = {
      getOrCreateAccount: cdpMocks.getOrCreateAccount,
      getAccount: cdpMocks.getAccount,
    };
  },
}));

vi.mock("../src/services/rpcClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/rpcClient.js")>();
  return {
    ...actual,
    getRpcProvider: () => ({ readContract: rpcMocks.readContract }),
  };
});

import { createOperatorAuthMiddleware } from "../src/middleware/operatorAuth.js";
import { billing } from "../src/routes/billing.js";
import {
  priceToAmount,
  getRouteRequirements,
  BillingError,
  USDC_BASE,
} from "../src/services/billing.js";
import { PAY_TO } from "../src/middleware/x402.js";

const OPERATOR = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";
const BILLING_ADDR = "0x1111111111111111111111111111111111111111";

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

function createApp(kv: KVNamespace) {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>();
  app.use("*", createOperatorAuthMiddleware());
  app.route("/api/billing", billing);
  return { app, env: { KV: kv } as any };
}

async function authenticate(app: any, env: any): Promise<string> {
  mockVerifySig.mockResolvedValue(true);
  const res = await app.request(
    "/api/billing/status-does-not-exist-but-auth-runs", // any path triggers redemption
    { method: "GET" },
    env,
  ).catch(() => null);
  // Redeem via the auth middleware using a real protected-shaped request:
  const redeemRes = await app.request(
    "/api/billing/nonce",
    {
      method: "GET",
      headers: {
        "x-operator-address": OPERATOR,
        "x-auth-signature": "0xdeadbeef",
        "x-auth-timestamp": String(Date.now()),
        "user-agent": "billing-test/1.0",
      },
    },
    env,
  );
  return redeemRes.headers.get("X-Session-Token")!;
}

beforeEach(() => {
  mockVerifySig.mockReset();
  cdpMocks.getOrCreateAccount.mockReset().mockResolvedValue({ address: BILLING_ADDR });
  cdpMocks.getAccount.mockReset().mockResolvedValue({});
  cdpMocks.signTypedData.mockReset().mockResolvedValue("0x" + "ab".repeat(65));
  rpcMocks.readContract.mockReset().mockResolvedValue(50n * 1_000_000n); // 50 USDC
  facilitatorMocks.getSupported.mockReset().mockResolvedValue({
    kinds: [{ x402Version: 2, scheme: "upto", network: "eip155:8453", extra: { facilitatorAddress: "0x2222222222222222222222222222222222222222" } }],
    extensions: [],
    signers: {},
  });
});

describe("price parsing and route requirements", () => {
  const env = {} as any;

  it("parses dollar prices to micro-USDC", () => {
    expect(priceToAmount("$0.0020")).toBe(2000n);
    expect(priceToAmount("$0.10")).toBe(100000n);
    expect(priceToAmount("$0.0021")).toBe(2100n);
  });

  it("resolves POST /api/chat from the server requirements (upto, Permit2)", async () => {
    const r = await getRouteRequirements(env, "POST", "/api/chat");
    expect(r.scheme).toBe("upto");
    expect(r.amount).toBe(200000n);
    expect(r.extra.assetTransferMethod).toBe("permit2");
    expect(r.extra.facilitatorAddress).toBe("0x5E77b1B87D3F9f4B2f7d8C1234567890123456f1");
    expect(r.payTo.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(r.asset.toLowerCase()).toBe(USDC_BASE.toLowerCase());
  });

  it("rejects unknown routes", async () => {
    x402ServerMocks.routeExists.mockReturnValueOnce(false);
    await expect(getRouteRequirements(env, "POST", "/api/nope")).rejects.toThrow(BillingError);
  });

  it("rejects tampered requirements (unexpected payTo/asset/amount)", async () => {
    const tampered = { ...x402ServerMocks.accepts[0], payTo: "0x00000000000000000000000000000000000DeAd" };
    const orig = x402ServerMocks.accepts[0];
    x402ServerMocks.accepts[0] = tampered;
    await expect(getRouteRequirements({} as any, "POST", "/api/chat")).rejects.toThrow(BillingError);
    x402ServerMocks.accepts[0] = orig;
  });
});

describe("billing routes", () => {
  it("status requires authentication", async () => {
    const { app, env } = createApp(createMockKV());
    const res = await app.request("/api/billing/status", { method: "GET" }, env);
    expect(res.status).toBe(401);
  });

  it("status returns deposit address, balance and a top-up payload", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const token = await authenticate(app, env);
    const res = await app.request(
      "/api/billing/status",
      { method: "GET", headers: { "x-session-token": token, "user-agent": "billing-test/1.0" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.depositAddress).toBe(BILLING_ADDR);
    expect(json.balanceUSDC).toBe("50.000000");
  });

  it("payment-header signs a payload for a covered route (mocked CDP signer)", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const token = await authenticate(app, env);
    // CDP account signing is exercised through loadBillingAccount → toAccount;
    // toAccount requires a signTypedData on the cdp account object shape.
    cdpMocks.getAccount.mockResolvedValue({
      address: BILLING_ADDR,
      signTypedData: cdpMocks.signTypedData,
    });

    const res = await app.request(
      "/api/billing/payment-header",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "billing-test/1.0" },
        body: JSON.stringify({ method: "POST", path: "/api/chat" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const payload = JSON.parse(Buffer.from(json.paymentSignature, "base64").toString("utf8"));
    expect(payload.x402Version).toBe(2);
    expect(payload.payload.signature).toBe("0x" + "ab".repeat(65));
    expect(payload.payload.permit2Authorization.from).toBe(BILLING_ADDR);
    // REGRESSION: the witness facilitator must come from the server's own
    // requirements — a mismatched address yields "No matching payment requirements".
    // With the local facilitator this address is static across isolates.
    expect(payload.payload.permit2Authorization.witness.facilitator).toBe(
      getAddress("0x5E77b1B87D3F9f4B2f7d8C1234567890123456f1"),
    );
    // REGRESSION: x402 v2 matching requires the requirement object echoed
    // back as `accepted` (core fields deep-equal + extra subset).
    expect(payload.accepted).toEqual(x402ServerMocks.accepts[0]);
    // Exercise the SDK's REAL matcher (not our mock) on the signed payload.
    const actualSdk = await vi.importActual<typeof import("@x402/core/server")>("@x402/core/server");
    const matcher = new actualSdk.x402ResourceServer([]);
    expect(matcher.findMatchingRequirements([payload.accepted], payload)).toEqual(payload.accepted);
  });

  it("payment-header includes an EIP-2612 sponsored approval when Permit2 allowance is missing", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const token = await authenticate(app, env);
    cdpMocks.getAccount.mockResolvedValue({ address: BILLING_ADDR, signTypedData: cdpMocks.signTypedData });
    rpcMocks.readContract.mockImplementation(async (args: any) => {
      if (args.functionName === "allowance") return 0n;
      if (args.functionName === "nonces") return 7n;
      return 50n * 1_000_000n; // USDC balanceOf
    });

    const res = await app.request(
      "/api/billing/payment-header",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "billing-test/1.0" },
        body: JSON.stringify({ method: "POST", path: "/api/chat" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const payload = JSON.parse(Buffer.from(json.paymentSignature, "base64").toString("utf8"));
    const info = payload.extensions.eip2612GasSponsoring.info;
    expect(info.from).toBe(BILLING_ADDR);
    expect(info.spender).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(info.amount).toBe("200000"); // SDK signs the current route's required allowance
    expect(info.nonce).toBe("7");
    expect(info.version).toBe("1");
    expect(info.signature).toBe("0x" + "ab".repeat(65));
    expect(payload.accepted).toEqual(x402ServerMocks.accepts[0]);
    // Extension echo: server-declared extensions must be preserved and merged
    // with the client permit, otherwise the facilitator rejects with
    // extension_echo_mismatch.
    expect(payload.resource).toEqual({ url: "https://trader.rigoblock.com/api/chat" });
    expect(payload.extensions.bazaar).toEqual({ info: { test: true } });
    // Nested merge must preserve the server's static extension metadata while
    // adding the client's permit fields (extension_echo_mismatch regression).
    expect(payload.extensions.eip2612GasSponsoring.info.description).toBe(
      "Facilitator accepts EIP-2612 gasless Permit.",
    );
    expect(payload.extensions.eip2612GasSponsoring.schema).toEqual({ type: "object" });
    expect(payload.extensions.eip2612GasSponsoring.info.from).toBe(BILLING_ADDR);
  });

  it("payment-header refuses when the deposit is below the required amount", async () => {
    rpcMocks.readContract.mockResolvedValue(100n); // 0.0001 USDC
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const token = await authenticate(app, env);
    cdpMocks.getAccount.mockResolvedValue({ address: BILLING_ADDR, signTypedData: cdpMocks.signTypedData });

    const res = await app.request(
      "/api/billing/payment-header",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "billing-test/1.0" },
        body: JSON.stringify({ method: "POST", path: "/api/chat" }),
      },
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error).toBe("insufficient_deposit");
  });

  it("payment-header requires authentication and a valid /api path", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const unauth = await app.request(
      "/api/billing/payment-header",
      { method: "POST", body: JSON.stringify({ method: "POST", path: "/api/chat" }) },
      env,
    );
    expect(unauth.status).toBe(401);

    const token = await authenticate(app, env);
    cdpMocks.getAccount.mockResolvedValue({ address: BILLING_ADDR, signTypedData: cdpMocks.signTypedData });
    const badPath = await app.request(
      "/api/billing/payment-header",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "billing-test/1.0" },
        body: JSON.stringify({ method: "POST", path: "https://evil.example/steal" }),
      },
      env,
    );
    expect(badPath.status).toBe(400);
  });

  it("topup encodes a USDC transfer for an arbitrary amount", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const token = await authenticate(app, env);
    const res = await app.request(
      "/api/billing/topup?amount=2.5",
      { method: "GET", headers: { "x-session-token": token, "user-agent": "billing-test/1.0" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.to.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(json.amountUSDC).toBe("2.5");
    expect(json.data.startsWith("0xa9059cbb")).toBe(true); // ERC-20 transfer
    // transfer argument encodes 2.5 USDC = 2500000 micro
    expect(json.data).toContain("002625a0"); // 2500000 padded hex
  });

  it("withdraw builds a transferWithAuthorization back to the operator only", async () => {
    const kv = createMockKV();
    const { app, env } = createApp(kv);
    const token = await authenticate(app, env);
    cdpMocks.getAccount.mockResolvedValue({ address: BILLING_ADDR, signTypedData: cdpMocks.signTypedData });

    const res = await app.request(
      "/api/billing/withdraw",
      {
        method: "POST",
        headers: { "x-session-token": token, "user-agent": "billing-test/1.0" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.to.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(json.data.startsWith("0x")).toBe(true);
    expect(json.data.length).toBeGreaterThan(500); // transferWithAuthorization calldata
    expect(cdpMocks.signTypedData).toHaveBeenCalled();
    // The authorization must target the authenticated operator.
    const typedData = cdpMocks.signTypedData.mock.calls[0][0];
    expect(typedData.message.to.toLowerCase()).toBe(OPERATOR.toLowerCase());
    expect(typedData.message.from.toLowerCase()).toBe(BILLING_ADDR.toLowerCase());
  });
});
