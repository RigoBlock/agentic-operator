/**
 * POST /api/tools execution-mode contract tests.
 *
 * Regression coverage for the MetaMask-popup bug: the frontend menu cards
 * (chat-ui.js invokeDirectTool) must receive an agent-signed transaction in
 * delegated confirm mode. The route decides the mode here:
 *   - body.executionMode === "delegated" AND operatorVerified → delegated
 *   - delegated without confirmExecution → runTransactionFlow stores the
 *     operation and returns operationId (NOT "autonomous" auto-execution)
 *   - anything else → manual mode, no transaction flow
 *   - no auth at all → 401
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockVerifyOperatorAuth,
  mockExecuteToolCall,
  mockPrepareTransaction,
  mockRunTransactionFlow,
  mockExecuteStoredSimulation,
  mockFormatOutcomesMarkdown,
} = vi.hoisted(() => ({
  mockVerifyOperatorAuth: vi.fn(),
  mockExecuteToolCall: vi.fn(),
  mockPrepareTransaction: vi.fn(),
  mockRunTransactionFlow: vi.fn(),
  mockExecuteStoredSimulation: vi.fn(),
  mockFormatOutcomesMarkdown: vi.fn(),
}));

vi.mock("../src/services/auth.js", () => ({
  verifyOperatorAuth: mockVerifyOperatorAuth,
  AuthError: class AuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "AuthError";
      this.status = status;
    }
  },
}));

vi.mock("../src/llm/client.js", () => ({
  executeToolCall: mockExecuteToolCall,
  TOOL_NAME_ALIASES: {} as Record<string, string>,
  OPERATOR_VERIFIED_TOOLS: new Set<string>(),
}));

vi.mock("../src/services/transactionPrepare.js", () => ({
  prepareTransaction: mockPrepareTransaction,
}));

vi.mock("../src/services/transactionFlow.js", () => ({
  runTransactionFlow: mockRunTransactionFlow,
}));

vi.mock("../src/services/execution.js", () => ({
  executeStoredSimulation: mockExecuteStoredSimulation,
  formatOutcomesMarkdown: mockFormatOutcomesMarkdown,
}));

vi.mock("../src/skills/index.js", () => ({
  getSkillTools: () => [],
}));

import { tools } from "../src/routes/tools.js";

const VAULT = "0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c";
const OPERATOR = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";
const AGENT = "0x1234567890123456789012345678901234567890";

const DRAFT_TX = {
  to: VAULT,
  data: "0xac9650d8",
  value: "0x0",
  chainId: 8453,
  description: "vault swap",
};

function createApp() {
  const app = new Hono();
  app.route("/api/tools", tools);
  return app;
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    arguments: { sellToken: "ETH", buyToken: "USDC", amount: "1" },
    vaultAddress: VAULT,
    chainId: 8453,
    operatorAddress: OPERATOR,
    authSignature: "0xdeadbeef",
    authTimestamp: Date.now(),
    ...overrides,
  };
}

async function post(app: Hono, body: Record<string, unknown>) {
  return app.request("http://localhost/api/tools?toolName=build_vault_swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tools execution mode", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    mockVerifyOperatorAuth.mockResolvedValue(undefined);
    mockExecuteToolCall.mockResolvedValue({
      message: "Swap prepared",
      transaction: { ...DRAFT_TX },
    });
    mockPrepareTransaction.mockResolvedValue({
      tx: {
        ...DRAFT_TX,
        from: AGENT,
        gas: "0x5208",
        maxFeePerGas: "0x2",
        maxPriorityFeePerGas: "0x1",
        navShieldChecked: true,
      },
    });
    mockRunTransactionFlow.mockResolvedValue({
      kind: "pending_confirmation",
      operationId: "op1",
    });
  });

  it("delegated + operator auth → delegated ctx, flow stored with no autonomous override", async () => {
    const res = await post(app, makeBody({ executionMode: "delegated" }));
    expect(res.status).toBe(200);
    const data: { transaction: { from: string }; operationId?: string } = await res.json();

    // Tool ran in delegated mode and the frontend receives the agent-signed tx.
    expect(mockExecuteToolCall.mock.calls[0][1].executionMode).toBe("delegated");
    expect(data.transaction.from).toBe(AGENT);
    expect(data.operationId).toBe("op1");

    // confirm mode: stored for later confirmation, NOT auto-executed.
    expect(mockRunTransactionFlow).toHaveBeenCalledTimes(1);
    expect(mockRunTransactionFlow.mock.calls[0][6]).toBeUndefined();
  });

  it("delegated + confirmExecution → autonomous override passed to the flow", async () => {
    mockRunTransactionFlow.mockResolvedValue({
      kind: "executed",
      outcomes: [{ result: { txHash: "0xabc" } }],
    });
    mockFormatOutcomesMarkdown.mockReturnValue("Executed");

    const res = await post(
      app,
      makeBody({ executionMode: "delegated", confirmExecution: true }),
    );
    expect(res.status).toBe(200);
    expect(mockRunTransactionFlow.mock.calls[0][6]).toBe("autonomous");
  });

  it("no executionMode → manual ctx, transaction flow not invoked", async () => {
    const res = await post(app, makeBody());
    expect(res.status).toBe(200);
    const data: { operationId?: string } = await res.json();

    expect(mockExecuteToolCall.mock.calls[0][1].executionMode).toBe("manual");
    expect(mockRunTransactionFlow).not.toHaveBeenCalled();
    expect(data.operationId).toBeUndefined();
  });

  it("delegated without operator auth → downgraded to manual", async () => {
    const res = await post(
      app,
      makeBody({
        executionMode: "delegated",
        operatorAddress: undefined,
        authSignature: undefined,
        authTimestamp: undefined,
      }),
    );
    expect(res.status).toBe(401);
    expect(mockExecuteToolCall).not.toHaveBeenCalled();
    expect(mockRunTransactionFlow).not.toHaveBeenCalled();
  });
});
