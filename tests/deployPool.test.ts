/**
 * Smart pool deployment tests — HyperEVM USDC-only base token enforcement.
 *
 * The AHyperliquid adapter settles margin in USDC: a HyperEVM pool with any
 * other base token could never trade there. The deploy handler must therefore
 * default to USDC on chain 999 and reject every other base token.
 */
import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { handle_deploy_smart_pool } from "../src/llm/handlers/vault-mgmt.js";
import type { RequestContext, Env } from "../src/types.js";

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
