import { describe, expect, it } from "vitest";
import { DEFAULT_SLIPPAGE_BPS } from "../src/services/swapShield.js";
import { resolveSlippage, tryFastPathSwap, isVerifiedOperatorContext, VAULT_TX_TOOLS, OPERATOR_VERIFIED_TOOLS } from "../src/llm/client.js";
import type { RequestContext } from "../src/types.js";

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    vaultAddress: "0x0000000000000000000000000000000000000000",
    chainId: 8453,
    ...overrides,
  } as RequestContext;
}

function makeKV(value: string | null): KVNamespace {
  return {
    get: async () => value,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

describe("client security helpers", () => {
  it("isVerifiedOperatorContext only returns true for verified + address", () => {
    expect(isVerifiedOperatorContext(makeCtx())).toBe(false);
    expect(isVerifiedOperatorContext(makeCtx({ operatorAddress: "0x1234567890123456789012345678901234567890" as `0x${string}` }))).toBe(false);
    expect(isVerifiedOperatorContext(makeCtx({ operatorVerified: true }))).toBe(false);
    expect(
      isVerifiedOperatorContext(
        makeCtx({
          operatorVerified: true,
          operatorAddress: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        }),
      ),
    ).toBe(true);
  });

  it("resolveSlippage ignores unverified per-request override", async () => {
    const env = { KV: makeKV("300") } as any;
    const ctx = makeCtx({
      slippageBps: 500,
      operatorAddress: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      operatorVerified: false,
    });

    const resolved = await resolveSlippage(env, ctx);
    expect(resolved).toBe(DEFAULT_SLIPPAGE_BPS);
  });

  it("resolveSlippage uses verified per-request override with clamping", async () => {
    const env = { KV: makeKV("300") } as any;
    const ctx = makeCtx({
      slippageBps: 999,
      operatorAddress: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      operatorVerified: true,
    });

    const resolved = await resolveSlippage(env, ctx);
    expect(resolved).toBe(500);
  });

  it("resolveSlippage uses verified operator KV value", async () => {
    const env = { KV: makeKV("250") } as any;
    const ctx = makeCtx({
      operatorAddress: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      operatorVerified: true,
    });

    const resolved = await resolveSlippage(env, ctx);
    expect(resolved).toBe(250);
  });

  it("fast-path swap parses multi-word chain aliases", () => {
    const parsed = tryFastPathSwap("sell 1 ETH for USDC on bnb chain");
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("build_vault_swap");
    expect(parsed?.args.chain).toBe("bnb chain");
  });

  it("fast-path swap parses chain suffix followed by DEX modifier", () => {
    const parsed = tryFastPathSwap("sell 1 ETH for USDC on base using 0x");
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("build_vault_swap");
    expect(parsed?.args.chain).toBe("base");
    expect(parsed?.args.dex).toBe("0x");
  });

  it("fast-path swap parses chain + DEX with 'with' keyword", () => {
    const parsed = tryFastPathSwap("sell 1 ETH for USDC on base with 0x");
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("build_vault_swap");
    expect(parsed?.args.chain).toBe("base");
    expect(parsed?.args.dex).toBe("0x");
  });

  it("fast-path swap parses DEX modifier followed by chain suffix", () => {
    const parsed = tryFastPathSwap("sell 1 ETH for USDC using 0x on base");
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("build_vault_swap");
    expect(parsed?.args.chain).toBe("base");
    expect(parsed?.args.dex).toBe("0x");
  });
});

describe("tool auth category membership", () => {
  // deploy_smart_pool calls the factory (permissionless, no existing vault needed).
  // It must NOT be gated by vault ownership auth — the caller becomes the vault owner.
  it("deploy_smart_pool is not in VAULT_TX_TOOLS", () => {
    expect(VAULT_TX_TOOLS.has("deploy_smart_pool")).toBe(false);
  });

  it("deploy_smart_pool is not in OPERATOR_VERIFIED_TOOLS", () => {
    expect(OPERATOR_VERIFIED_TOOLS.has("deploy_smart_pool")).toBe(false);
  });

  // Read-only / informational tools must never require operator auth
  it("get_swap_quote is not in VAULT_TX_TOOLS", () => {
    expect(VAULT_TX_TOOLS.has("get_swap_quote")).toBe(false);
  });

  it("get_vault_info is not in VAULT_TX_TOOLS", () => {
    expect(VAULT_TX_TOOLS.has("get_vault_info")).toBe(false);
  });

  // Operator-only KV mutations must require operator verification
  it("set_default_slippage is in OPERATOR_VERIFIED_TOOLS", () => {
    expect(OPERATOR_VERIFIED_TOOLS.has("set_default_slippage")).toBe(true);
  });

  it("disable_swap_shield is in OPERATOR_VERIFIED_TOOLS", () => {
    expect(OPERATOR_VERIFIED_TOOLS.has("disable_swap_shield")).toBe(true);
  });

  // Vault tx tools must require auth for browser callers
  it("build_vault_swap is in VAULT_TX_TOOLS", () => {
    expect(VAULT_TX_TOOLS.has("build_vault_swap")).toBe(true);
  });
});
