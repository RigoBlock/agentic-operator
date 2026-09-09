/**
 * sanitizeSwapArgs chain-extraction tests.
 *
 * Regression guard: the hardcoded chain list predated HyperEVM, so
 * "swap 1 ETH to USDC on hyperliquid" never set the chain deterministically
 * and the swap had to rely on LLM judgment. The list is now derived from
 * SUPPORTED_CHAINS, with "hyperliquid" accepted as spoken alias for the
 * HyperEVM chain (short name "hyperevm", which resolveChainId understands).
 */
import { describe, it, expect, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

import { sanitizeSwapArgs } from "../src/llm/client.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "../src/config.js";

describe("sanitizeSwapArgs chain extraction", () => {
  it("maps 'on hyperliquid' to the HyperEVM chain", () => {
    const corrected = sanitizeSwapArgs(
      { tokenIn: "ETH", tokenOut: "USDC" },
      "swap 1 ETH to USDC on hyperliquid",
    );
    expect(corrected.chain).toBe("hyperevm");
  });

  it("maps 'to hyperliquid' to the HyperEVM chain", () => {
    const corrected = sanitizeSwapArgs(
      { tokenIn: "USDC", tokenOut: "USDC" },
      "bridge 500 USDC to hyperliquid",
    );
    expect(corrected.chain).toBe("hyperevm");
  });

  it("extracts every supported chain by name or short name", () => {
    for (const c of [...SUPPORTED_CHAINS, ...TESTNET_CHAINS]) {
      const byName = sanitizeSwapArgs({ tokenIn: "ETH", tokenOut: "USDC" }, `swap 1 ETH on ${c.name}`);
      expect(byName.chain).toBe(c.shortName);
      const byShort = sanitizeSwapArgs({ tokenIn: "ETH", tokenOut: "USDC" }, `swap 1 ETH on ${c.shortName}`);
      expect(byShort.chain).toBe(c.shortName);
    }
  });

  it("keeps an LLM-provided chain when the message names no chain", () => {
    const corrected = sanitizeSwapArgs(
      { tokenIn: "ETH", tokenOut: "USDC", chain: "polygon" },
      "swap 1 ETH to USDC",
    );
    expect(corrected.chain).toBe("polygon");
  });

  it("does not force a chain for multi-swap messages", () => {
    const corrected = sanitizeSwapArgs(
      { tokenIn: "ETH", tokenOut: "USDC" },
      "swap 1 ETH to USDC on base and swap 2 ETH to DAI on arbitrum",
    );
    expect(corrected.chain).toBeUndefined();
  });
});
