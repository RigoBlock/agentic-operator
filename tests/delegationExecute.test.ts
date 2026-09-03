/**
 * POST /api/delegation/execute tests (F2 — execution-time validation).
 *
 * The route accepts a caller-supplied unsigned transaction, so it must run the
 * preparation safety stack before broadcasting:
 *   - target MUST be the caller's vault (no arbitrary contract calls)
 *   - prepareTransaction (NAV shield + gas estimation) must pass
 *   - only then may executeViaDelegation broadcast
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockVerifyOperatorAuth, mockIsDelegationActive, mockGetDelegationConfig, mockPrepareTransaction, mockExecuteViaDelegation } =
  vi.hoisted(() => ({
    mockVerifyOperatorAuth: vi.fn(),
    mockIsDelegationActive: vi.fn(),
    mockGetDelegationConfig: vi.fn(),
    mockPrepareTransaction: vi.fn(),
    mockExecuteViaDelegation: vi.fn(),
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

vi.mock("../src/services/delegation.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/delegation.js")>();
  return {
    ...mod,
    isDelegationActive: mockIsDelegationActive,
    getDelegationConfig: mockGetDelegationConfig,
  };
});

vi.mock("../src/services/transactionPrepare.js", () => ({
  prepareTransaction: mockPrepareTransaction,
}));

vi.mock("../src/services/execution.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/execution.js")>();
  return {
    ...mod,
    executeViaDelegation: mockExecuteViaDelegation,
  };
});

import { delegation } from "../src/routes/delegation.js";
import { ExecutionError } from "../src/services/executionError.js";

const VAULT = "0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c";
const OPERATOR = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";
const AGENT = "0x1234567890123456789012345678901234567890";
const OTHER_CONTRACT = "0x9999999999999999999999999999999999999999";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    operatorAddress: OPERATOR,
    vaultAddress: VAULT,
    chainId: 8453,
    authSignature: "0xdeadbeef",
    authTimestamp: Date.now(),
    transaction: {
      to: VAULT,
      data: "0xac9650d8",
      value: "0x0",
      chainId: 8453,
      description: "vault swap",
    },
    ...overrides,
  };
}

function createApp(kv: KVNamespace) {
  const app = new Hono();
  app.route("/api/delegation", delegation);
  return app;
}

describe("POST /api/delegation/execute (F2)", () => {
  let kv: KVNamespace;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    kv = createMockKV();
    app = createApp(kv);
    mockVerifyOperatorAuth.mockResolvedValue(undefined);
    mockIsDelegationActive.mockResolvedValue(true);
    mockGetDelegationConfig.mockResolvedValue({ enabled: true, agentAddress: AGENT });
    mockPrepareTransaction.mockResolvedValue({
      tx: {
        from: AGENT,
        to: VAULT,
        data: "0xac9650d8",
        value: "0x0",
        chainId: 8453,
        gas: "0x5208",
        maxFeePerGas: "0x2",
        maxPriorityFeePerGas: "0x1",
        description: "vault swap",
        navShieldChecked: true,
      },
    });
    mockExecuteViaDelegation.mockResolvedValue({
      txHash: "0xabc",
      chainId: 8453,
      confirmed: true,
      blockNumber: 1,
      gasCostEth: "0.0001",
      sponsored: false,
    });
  });

  it("rejects transactions whose target is not the vault (403 TARGET_NOT_ALLOWED)", async () => {
    const res = await app.request(
      "/api/delegation/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody({
          transaction: { to: OTHER_CONTRACT, data: "0xac9650d8", value: "0x0", chainId: 8453 },
        })),
      },
      { KV: kv } as any,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.code).toBe("TARGET_NOT_ALLOWED");
    // Neither preparation nor broadcast may run for a non-vault target.
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
    expect(mockExecuteViaDelegation).not.toHaveBeenCalled();
  });

  it("runs prepareTransaction and broadcasts the PREPARED tx on the happy path", async () => {
    const res = await app.request(
      "/api/delegation/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody()),
      },
      { KV: kv } as any,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.executionResult.confirmed).toBe(true);

    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
    const [prepEnv, prepCtx, draft] = mockPrepareTransaction.mock.calls[0];
    expect(prepCtx).toMatchObject({
      vaultAddress: VAULT,
      chainId: 8453,
      operatorAddress: OPERATOR,
      executionMode: "delegated",
    });
    expect(draft.to).toBe(VAULT);

    // The broadcast must use the PREPARED transaction (with executor + gas
    // from the safety stack), not the raw caller-supplied fields.
    expect(mockExecuteViaDelegation).toHaveBeenCalledTimes(1);
    const [execEnv, tx, vault] = mockExecuteViaDelegation.mock.calls[0];
    expect(tx.from).toBe(AGENT);
    expect(tx.gas).toBe("0x5208");
    expect(vault).toBe(VAULT);
  });

  it("surfaces NAV shield blocks from prepareTransaction (422) without broadcasting", async () => {
    mockPrepareTransaction.mockRejectedValue(
      new ExecutionError("Trade blocked by NAV protection", "NAV_SHIELD_BLOCKED"),
    );
    const res = await app.request(
      "/api/delegation/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody()),
      },
      { KV: kv } as any,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as any;
    expect(json.code).toBe("NAV_SHIELD_BLOCKED");
    expect(mockExecuteViaDelegation).not.toHaveBeenCalled();
  });

  it("surfaces gas-estimation / preparation failures as 502 without broadcasting", async () => {
    mockPrepareTransaction.mockRejectedValue(
      new ExecutionError("Transaction preparation failed: RPC down", "PREPARATION_FAILED"),
    );
    const res = await app.request(
      "/api/delegation/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody()),
      },
      { KV: kv } as any,
    );
    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.code).toBe("PREPARATION_FAILED");
    expect(mockExecuteViaDelegation).not.toHaveBeenCalled();
  });

  it("keeps the delegation-not-active fallback behavior (400)", async () => {
    mockIsDelegationActive.mockResolvedValue(false);
    const res = await app.request(
      "/api/delegation/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody()),
      },
      { KV: kv } as any,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.code).toBe("DELEGATION_NOT_ON_CHAIN");
    expect(json.fallbackToManual).toBe(true);
    expect(mockPrepareTransaction).not.toHaveBeenCalled();
    expect(mockExecuteViaDelegation).not.toHaveBeenCalled();
  });
});
