/**
 * Chat route auth regression tests.
 *
 * Verifies that x402 operator-auth headers are NOT treated as blanket proof of
 * vault ownership. A valid EIP-191 signature in headers only proves that the
 * header address signed the wallet-wide auth message; the route must still call
 * verifyOperatorAuth for the request-specific vaultAddress before granting
 * operatorVerified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Address } from "viem";
import { AuthError } from "../src/services/auth.js";
import type { ChatResponse, AppVariables, Env } from "../src/types.js";

const {
  mockVerifyOperatorAuth,
  mockProcessChat,
  mockExecuteStoredSimulation,
  mockFormatOutcomesMarkdown,
} = vi.hoisted(() => ({
  mockVerifyOperatorAuth: vi.fn(),
  mockProcessChat: vi.fn(),
  mockExecuteStoredSimulation: vi.fn(),
  mockFormatOutcomesMarkdown: vi.fn(),
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

vi.mock("../src/llm/client.js", () => ({
  processChat: mockProcessChat,
}));

vi.mock("../src/services/execution.js", () => ({
  executeStoredSimulation: mockExecuteStoredSimulation,
  formatOutcomesMarkdown: mockFormatOutcomesMarkdown,
  executeTxList: vi.fn(),
  storePendingSimulation: vi.fn(),
}));

vi.mock("../src/services/transactionFlow.js", () => ({
  runTransactionFlow: vi.fn(),
  getExecutionModePreference: vi.fn(),
  setExecutionModePreference: vi.fn(),
}));

import { chat } from "../src/routes/chat.js";

const ATTACKER_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const VICTIM_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const VICTIM_VAULT = "0x3333333333333333333333333333333333333333" as Address;
const CHAIN_ID = 8453;

function createMockKV(): KVNamespace {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("/api/chat/*", async (c, next) => {
    const headerAddr = c.req.header("x-operator-address");
    const headerSig = c.req.header("x-auth-signature");
    const headerTs = c.req.header("x-auth-timestamp");
    if (headerAddr && headerSig && headerTs) {
      c.set("operatorAuthVerified", true);
      c.set("operatorAuth", {
        address: headerAddr,
        signature: headerSig,
        timestamp: Number(headerTs),
      });
    }
    if (c.req.header("x-simulate-x402-paid")) {
      c.set("x402Paid", true);
    }
    await next();
  });
  app.route("/api/chat", chat);
  return app;
}

describe("POST /api/chat auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessChat.mockResolvedValue({ reply: "ok" } as ChatResponse);
  });

  it("grants operatorVerified when header auth address owns the vault", async () => {
    mockVerifyOperatorAuth.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": ATTACKER_ADDRESS,
          "x-auth-signature": "0x1234",
          "x-auth-timestamp": String(Date.now()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(200);
    expect(mockVerifyOperatorAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorAddress: ATTACKER_ADDRESS,
        vaultAddress: VICTIM_VAULT,
      }),
    );
    const ctx = mockProcessChat.mock.calls[0][2];
    expect(ctx.operatorVerified).toBe(true);
    expect(ctx.operatorAddress?.toLowerCase()).toBe(ATTACKER_ADDRESS.toLowerCase());
  });

  it("rejects delegated execution when header auth address does NOT own the vault", async () => {
    mockVerifyOperatorAuth.mockRejectedValue(new AuthError("Access denied: not owner", 403));

    const app = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "x-operator-address": ATTACKER_ADDRESS,
          "x-auth-signature": "0x1234",
          "x-auth-timestamp": String(Date.now()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "swap all to USDC" }],
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
          executionMode: "delegated",
          confirmExecution: true,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(403);
    expect(mockProcessChat).not.toHaveBeenCalled();
  });

  it("allows x402-paid external agents in manual mode without ownership proof", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-simulate-x402-paid": "true",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "quote a swap" }],
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(200);
    expect(mockVerifyOperatorAuth).not.toHaveBeenCalled();
    const ctx = mockProcessChat.mock.calls[0][2];
    expect(ctx.operatorVerified).toBe(false);
    expect(ctx.executionMode).toBe("manual");
  });

  it("rejects requests with no auth and no x402 payment", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(401);
    expect(mockProcessChat).not.toHaveBeenCalled();
  });

  it("grants operatorVerified when full body auth proves ownership", async () => {
    mockVerifyOperatorAuth.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
          operatorAddress: VICTIM_ADDRESS,
          authSignature: "0x5678",
          authTimestamp: Date.now(),
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(200);
    expect(mockVerifyOperatorAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorAddress: VICTIM_ADDRESS,
        vaultAddress: VICTIM_VAULT,
        authSignature: "0x5678",
      }),
    );
    const ctx = mockProcessChat.mock.calls[0][2];
    expect(ctx.operatorVerified).toBe(true);
    expect(ctx.operatorAddress?.toLowerCase()).toBe(VICTIM_ADDRESS.toLowerCase());
  });
});
