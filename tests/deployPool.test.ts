/**
 * Smart pool deployment tests — HyperEVM USDC-only base token enforcement.
 *
 * The AHyperliquid adapter settles margin in USDC: a HyperEVM pool with any
 * other base token could never trade there. The deploy handler must therefore
 * default to USDC on chain 999 and reject every other base token.
 */
import { describe, it, expect, vi } from "vitest";
import type { Address } from "viem";
import { handle_deploy_smart_pool } from "../src/llm/handlers/vault-mgmt.js";
import type { RequestContext, Env } from "../src/types.js";

// The execution module is mocked so runTransactionFlow never performs real
// agent-side effects in the flow-contract test below.
const { mockExecuteTxList } = vi.hoisted(() => ({ mockExecuteTxList: vi.fn() }));
vi.mock("../src/services/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/execution.js")>();
  return { ...actual, executeTxList: mockExecuteTxList };
});

const HYPER_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const ZERO = "0x0000000000000000000000000000000000000000";

function makeCtx(chainId: number): RequestContext {
  return {
    vaultAddress: ZERO as Address,
    chainId,
    operatorAddress: "0xA0F9C380ad1E1be09046319fd907335B2B452B37" as Address,
    isBrowserRequest: true,
  };
}

const env = {} as Env;

async function deploy(chainId: number, args: Record<string, unknown>) {
  return handle_deploy_smart_pool(env, makeCtx(chainId), args, "deploy_smart_pool");
}

describe("deploy_smart_pool on HyperEVM (999)", () => {
  it("defaults to USDC when no base token is given — only name and symbol needed", async () => {
    const result = await deploy(999, { name: "Hyper Pool", symbol: "HYP" });
    expect(result.transaction?.chainId).toBe(999);
    // createPool(name, symbol, baseToken) — calldata must encode the HYPER_USDC address
    expect(result.transaction?.data.toLowerCase()).toContain(HYPER_USDC.slice(2).toLowerCase());
    expect(result.message).toContain("Base token: USDC");
    expect(result.message).toContain("Chain: HyperEVM");
  });

  it("accepts an explicit USDC request", async () => {
    const result = await deploy(999, { name: "Hyper Pool", symbol: "HYP", baseToken: "USDC" });
    expect(result.transaction?.data.toLowerCase()).toContain(HYPER_USDC.slice(2).toLowerCase());
  });

  it("accepts the raw HYPER_USDC address", async () => {
    const result = await deploy(999, { name: "Hyper Pool", symbol: "HYP", baseToken: HYPER_USDC });
    expect(result.transaction?.data.toLowerCase()).toContain(HYPER_USDC.slice(2).toLowerCase());
  });

  it("rejects ETH/HYPE as base token", async () => {
    await expect(deploy(999, { name: "Hyper Pool", symbol: "HYP", baseToken: "ETH" }))
      .rejects.toThrow(/must use USDC/);
  });

  it("rejects any other token symbol", async () => {
    await expect(deploy(999, { name: "Hyper Pool", symbol: "HYP", baseToken: "WHYPE" }))
      .rejects.toThrow(/must use USDC/);
  });

  it("rejects a custom (non-USDC) token address", async () => {
    await expect(
      deploy(999, { name: "Hyper Pool", symbol: "HYP", baseToken: "0x5555555555555555555555555555555555555555" }),
    ).rejects.toThrow(/must use USDC/);
  });
});

describe("deploy_smart_pool on other chains", () => {
  it("keeps the ETH default on Arbitrum", async () => {
    const result = await deploy(42161, { name: "Arb Pool", symbol: "ARB" });
    // baseToken = address(0) — createPool calldata ends with 32 zero bytes for the address
    expect(result.transaction?.chainId).toBe(42161);
    expect(result.transaction?.data).toMatch(/0{40}$/);
  });

  it("still resolves custom base tokens off HyperEVM", async () => {
    const result = await deploy(42161, { name: "Arb Pool", symbol: "ARB", baseToken: "USDC" });
    // Arbitrum USDC — resolution must not throw
    expect(result.transaction?.data).toContain("af88d065");
  });
});


describe("deploy_smart_pool registry name/symbol rules (PoolRegistry._assertValidNameAndSymbol)", () => {
  async function decodedArgs(chainId: number, args: Record<string, unknown>) {
    const { decodeFunctionData } = await import("viem");
    const { POOL_FACTORY_ABI } = await import("../src/abi/poolFactory.js");
    const result = await deploy(chainId, args);
    const decoded = decodeFunctionData({ abi: POOL_FACTORY_ABI, data: result.transaction!.data as `0x${string}` });
    expect(decoded.functionName).toBe("createPool");
    return decoded.args as [string, string, `0x${string}`];
  }

  it("preserves the pool name EXACTLY as typed — case-sensitive registry", async () => {
    const [name, symbol] = await decodedArgs(999, { name: "alcyoneus", symbol: "ALC" });
    expect(name).toBe("alcyoneus");
    expect(symbol).toBe("ALC");
  });

  it("preserves mixed-case names", async () => {
    const [name] = await decodedArgs(999, { name: "my Pool v2", symbol: "MPV" });
    expect(name).toBe("my Pool v2");
  });

  it("uppercases a lowercase symbol before it reaches the chain", async () => {
    const [, symbol] = await decodedArgs(999, { name: "Alcy Pool", symbol: "alc" });
    expect(symbol).toBe("ALC");
  });

  it("uppercases a mixed-case symbol", async () => {
    const [, symbol] = await decodedArgs(42161, { name: "Arb Pool", symbol: "aLc" });
    expect(symbol).toBe("ALC");
  });

  it("rejects names shorter than 4 or longer than 31 characters", async () => {
    await expect(deploy(999, { name: "abc", symbol: "ABC" })).rejects.toThrow(/4-31/);
    await expect(deploy(999, { name: "a".repeat(32), symbol: "ABC" })).rejects.toThrow(/4-31/);
  });

  it("rejects symbols shorter than 3 or longer than 5 characters", async () => {
    await expect(deploy(999, { name: "Valid Name", symbol: "AB" })).rejects.toThrow(/3-5/);
    await expect(deploy(999, { name: "Valid Name", symbol: "ABCDEF" })).rejects.toThrow(/3-5/);
  });

  it("rejects invalid characters (LibSanitize charset)", async () => {
    await expect(deploy(999, { name: "Bad!Name", symbol: "ABC" })).rejects.toThrow(/invalid characters/);
    await expect(deploy(999, { name: "Bad\tName", symbol: "ABC" })).rejects.toThrow(/invalid characters/);
    await expect(deploy(999, { name: "Valid Name", symbol: "AB!" })).rejects.toThrow(/invalid characters/);
    await expect(deploy(999, { name: "Valid Name", symbol: "AB-" })).rejects.toThrow(/invalid characters/);
    // digits are registry-legal in symbols
    const ok = await deploy(999, { name: "Valid Name", symbol: "AB1" });
    expect(ok.transaction).toBeDefined();
  });
});

describe("deploy_smart_pool execution-flow contract (regression guard)", () => {
  // Deployment must always be operatorOnly: msg.sender becomes the pool owner,
  // so the agent wallet must NEVER sign it. If a refactor drops this flag, the
  // transaction could flow into agent delegation — these tests pin the link
  // between the deploy handler and the unified TransactionFlow engine.

  it("flags the deploy transaction operatorOnly and survives confirm-mode flow", async () => {
    const { runTransactionFlow } = await import("../src/services/transactionFlow.js");
    const result = await deploy(999, { name: "alcyoneus", symbol: "ALC" });

    expect(result.transaction?.operatorOnly).toBe(true);
    expect(result.transaction?.description).toContain("alcyoneus (ALC)");

    const kvStore = new Map<string, string>();
    const kv = {
      get: async (k: string) => kvStore.get(k) ?? null,
      put: async (k: string, v: string) => { kvStore.set(k, v); },
      delete: async (k: string) => { kvStore.delete(k); },
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;

    // Fill the executable-only fields (the deploy draft is unsigned at this
    // stage; confirm mode never reads them for operatorOnly transactions).
    const deployTx = {
      ...result.transaction!,
      from: "0xA0F9C380ad1E1be09046319fd907335B2B452B37" as Address,
      gas: "0x5208" as `0x${string}`,
      maxFeePerGas: "0x1" as `0x${string}`,
      maxPriorityFeePerGas: "0x1" as `0x${string}`,
    };

    const flow = await runTransactionFlow(
      { KV: kv } as unknown as Env,
      "0xA0F9C380ad1E1be09046319fd907335B2B452B37",
      "0x0000000000000000000000000000000000000000",
      [deployTx],
      result.message,
      { requestConfirmation: async () => {} },
      "confirm",
    );

    // The deploy tx must come back for direct wallet signing — never stored
    // for agent execution, never thrown, never executed.
    expect(flow.kind).toBe("pending_confirmation");
    expect(flow.operationId).toBeUndefined();
    expect(flow.transactions).toHaveLength(1);
    expect(flow.transactions![0].description).toContain("alcyoneus (ALC)");
    expect(mockExecuteTxList).not.toHaveBeenCalled();
    expect((await kv.list({ prefix: "pending-sim:" })).keys).toHaveLength(0);
  });
});
