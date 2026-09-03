/**
 * Cross-chain config tests — the operator config must mirror the on-chain
 * CrosschainTokens.sol / CrosschainLib.sol validation exactly.
 */
import { describe, it, expect } from "vitest";
import {
  CROSSCHAIN_TOKENS,
  ACROSS_SPOKE_POOL,
  getAcrossHandler,
  getOutputToken,
  getSupportedDestinations,
  HYPER_EVM_MULTICALL_HANDLER,
  DEFAULT_MULTICALL_HANDLER,
} from "../src/services/crosschainConfig.js";

const HYPER_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";

describe("HyperEVM (999) cross-chain support", () => {
  it("is enabled with USDC as the ONLY bridgeable token", () => {
    const tokens = CROSSCHAIN_TOKENS[999];
    expect(tokens).toHaveLength(1);
    expect(tokens![0].type).toBe("USDC");
    expect(tokens![0].address).toBe(HYPER_USDC);
    expect(tokens![0].decimals).toBe(6);
  });

  it("has an Across SpokePool matching the Across API", () => {
    expect(ACROSS_SPOKE_POOL[999]).toBe("0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04");
  });

  it("uses the dedicated HyperEVM MulticallHandler (mirrors CrosschainLib.getAcrossHandler)", () => {
    expect(getAcrossHandler(999)).toBe(HYPER_EVM_MULTICALL_HANDLER);
    expect(getAcrossHandler(42161)).toBe(DEFAULT_MULTICALL_HANDLER);
  });

  it("resolves USDC output pairs to and from every other chain", () => {
    const arbUsdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    // Arbitrum USDC → HyperEVM USDC
    expect(getOutputToken(42161, 999, arbUsdc)?.address).toBe(HYPER_USDC);
    // HyperEVM USDC → Arbitrum USDC
    expect(getOutputToken(999, 42161, HYPER_USDC)?.address.toLowerCase()).toBe(arbUsdc.toLowerCase());
  });

  it("exposes HyperEVM as a USDC destination/source", () => {
    expect(getSupportedDestinations(42161)).toContain(999);
    expect(getSupportedDestinations(999)).toContain(42161);
    // No WETH on HyperEVM: a WETH bridge to 999 must not resolve an output token
    const arbWeth = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    expect(getOutputToken(42161, 999, arbWeth)).toBeUndefined();
  });
});
