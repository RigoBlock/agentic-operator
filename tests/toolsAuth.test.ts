/**
 * Tools route auth regression tests.
 *
 * Mirrors chatAuth.test.ts: valid x402 operator-auth headers must still be
 * followed by a vault-ownership check before operatorVerified is granted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Address } from "viem";
import { AuthError } from "../src/services/auth.js";
import type { AppVariables, Env } from "../src/types.js";
import type { ToolResult } from "../src/llm/client.js";

const {
  mockVerifyOperatorAuth,
  mockExecuteToolCall,
  mockPrepareTransaction,
  mockRunTransactionFlow,
} = vi.hoisted(() => ({
  mockVerifyOperatorAuth: vi.fn(),
  mockExecuteToolCall: vi.fn(),
  mockPrepareTransaction: vi.fn(),
  mockRunTransactionFlow: vi.fn(),
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
  executeToolCall: mockExecuteToolCall,
  TOOL_NAME_ALIASES: {},
  OPERATOR_VERIFIED_TOOLS: new Set(["set_default_slippage"]),
  VAULT_TX_TOOLS: new Set(["build_vault_swap"]),
}));

vi.mock("../src/services/transactionPrepare.js", () => ({
  prepareTransaction: mockPrepareTransaction,
}));

vi.mock("../src/services/transactionFlow.js", () => ({
  runTransactionFlow: mockRunTransactionFlow,
}));

vi.mock("../src/llm/tools.js", () => ({
  TOOL_DEFINITIONS: [],
}));

vi.mock("../src/skills/index.js", () => ({
  getSkillTools: vi.fn().mockReturnValue([]),
}));

import { tools } from "../src/routes/tools.js";

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
  app.use("/api/tools/*", async (c, next) => {
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
  app.route("/api/tools", tools);
  return app;
}

describe("POST /api/tools auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteToolCall.mockResolvedValue({
      message: "ok",
    } as ToolResult);
    mockPrepareTransaction.mockImplementation((_env, _ctx, tx) => ({ tx, warning: undefined }));
  });

  it("grants operatorVerified when header auth address owns the vault", async () => {
    mockVerifyOperatorAuth.mockResolvedValue(undefined);

    const app = createApp();
    const res = await app.request(
      "/api/tools?toolName=get_vault_info",
      {
        method: "POST",
        headers: {
          "x-operator-address": ATTACKER_ADDRESS,
          "x-auth-signature": "0x1234",
          "x-auth-timestamp": String(Date.now()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          arguments: {},
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
    const ctx = mockExecuteToolCall.mock.calls[0][1];
    expect(ctx.operatorVerified).toBe(true);
    expect(ctx.operatorAddress?.toLowerCase()).toBe(ATTACKER_ADDRESS.toLowerCase());
  });

  it("rejects operator-only tools when header auth address does NOT own the vault", async () => {
    mockVerifyOperatorAuth.mockRejectedValue(new AuthError("Access denied: not owner", 403));

    const app = createApp();
    const res = await app.request(
      "/api/tools?toolName=set_default_slippage",
      {
        method: "POST",
        headers: {
          "x-operator-address": ATTACKER_ADDRESS,
          "x-auth-signature": "0x1234",
          "x-auth-timestamp": String(Date.now()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          arguments: { slippage: "5%" },
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(403);
    expect(mockExecuteToolCall).not.toHaveBeenCalled();
  });

  it("allows x402-paid agents to use read-only tools without ownership", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/tools?toolName=get_vault_info",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-simulate-x402-paid": "true",
        },
        body: JSON.stringify({
          arguments: {},
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(200);
    expect(mockVerifyOperatorAuth).not.toHaveBeenCalled();
    const ctx = mockExecuteToolCall.mock.calls[0][1];
    expect(ctx.operatorVerified).toBe(false);
  });

  it("rejects requests with no auth and no x402 payment", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/tools?toolName=get_vault_info",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          arguments: {},
          chainId: CHAIN_ID,
          vaultAddress: VICTIM_VAULT,
        }),
      },
      { KV: createMockKV() } as Env,
    );

    expect(res.status).toBe(401);
    expect(mockExecuteToolCall).not.toHaveBeenCalled();
  });
});
