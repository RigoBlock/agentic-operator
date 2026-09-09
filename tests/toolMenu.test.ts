/**
 * Tool menu tests.
 *
 * 1. Regression (self-contained metadata): a get_tool_menu tool call returns
 *    toolCards metadata on the ChatResponse so the frontend can render cards.
 * 2. Deterministic fast path: "what are my hyperliquid tools?" is answered by
 *    tryFastPathToolMenu directly — no LLM round at all, so the LLM can never
 *    hallucinate a tool list from conversation history.
 */
import { describe, it, expect, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

import { processChat, tryFastPathToolMenu } from "../src/llm/client.js";
import type { Env, RequestContext } from "../src/types.js";

function toolCallCompletion(name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };
}

const ctx = {
  vaultAddress: "0x0000000000000000000000000000000000000000",
  chainId: 999,
  executionMode: "manual",
  aiApiKey: "test-key",
  aiModel: "test-model",
} as unknown as RequestContext;

describe("get_tool_menu via processChat", () => {
  it("returns toolCards metadata on the self-contained response", async () => {
    mockCreate.mockResolvedValueOnce(
      toolCallCompletion("get_tool_menu", { category: "hyperliquid" }),
    );

    const result = await processChat({} as Env, [{ role: "user", content: "open the hyperliquid menu for me" }], ctx);

    expect(result.finalModel).toBe("tooling");
    expect(result.reply).toContain("hyperliquid tools");
    const cards = (result.metadata as { toolCards: { toolName: string; fields: unknown[] }[] }).toolCards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((c) => c.toolName)).toContain("hyperliquid_deposit");
    // Only one LLM round: the self-contained path must short-circuit the follow-up call
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("tryFastPathToolMenu end-to-end", () => {
  it("serves the menu deterministically without any LLM round", async () => {
    mockCreate.mockReset();

    const result = await processChat({} as Env, [{ role: "user", content: "what are my hyperliquid tools?" }], ctx);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.finalModel).toBe("tooling");
    expect(result.toolCalls?.[0]?.name).toBe("get_tool_menu");
    const cards = (result.metadata as { toolCards: { toolName: string; fields: unknown[] }[] }).toolCards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((c) => c.toolName)).toContain("hyperliquid_deposit");
  });

  it.each([
    ["gmx", "gmx_increase_position"],
    ["swap", "build_vault_swap"],
    ["lp", "add_liquidity"],
    ["crosschain", "crosschain_transfer"],
  ])("serves the %s menu deterministically without any LLM round", async (category, expectedTool) => {
    mockCreate.mockReset();

    const result = await processChat({} as Env, [{ role: "user", content: `what are my ${category} tools?` }], ctx);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.finalModel).toBe("tooling");
    expect(result.toolCalls?.[0]?.name).toBe("get_tool_menu");
    const cards = (result.metadata as { toolCards: { toolName: string }[] }).toolCards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((c) => c.toolName)).toContain(expectedTool);
  });

  it("offers separate 0x and Uniswap swap boxes with the dex pre-filled", async () => {
    mockCreate.mockReset();

    const result = await processChat({} as Env, [{ role: "user", content: "what are my swap tools?" }], ctx);

    const cards = (result.metadata as {
      toolCards: { toolName: string; title: string; presetArgs?: Record<string, string> }[];
    }).toolCards;
    const swaps = cards.filter((c) => c.toolName === "build_vault_swap");
    expect(swaps).toHaveLength(2);
    expect(swaps.map((s) => s.presetArgs?.dex).sort()).toEqual(["0x", "uniswap"]);
  });

  it("offers direction as a dropdown and collateral disambiguation on GMX position cards", async () => {
    mockCreate.mockReset();

    const result = await processChat({} as Env, [{ role: "user", content: "what are my gmx tools?" }], ctx);

    const cards = (result.metadata as {
      toolCards: { toolName: string; fields: { name: string; options?: { label: string; value: string }[] }[] }[];
    }).toolCards;
    const decrease = cards.find((c) => c.toolName === "gmx_decrease_position")!;
    const direction = decrease.fields.find((f) => f.name === "isLong")!;
    expect(direction.options?.map((o) => o.value)).toEqual(["true", "false"]);
    // collateral token disambiguates multiple positions on the same market+side
    expect(decrease.fields.map((f) => f.name)).toContain("collateral");
    const increase = cards.find((c) => c.toolName === "gmx_increase_position")!;
    expect(increase.fields.map((f) => f.name)).toContain("collateral");
  });

  it("lists bridgeable tokens in the crosschain menu message", async () => {
    mockCreate.mockReset();

    const result = await processChat({} as Env, [{ role: "user", content: "what are my crosschain tools?" }], ctx);

    const cards = (result.metadata as { toolCards: { toolName: string }[] }).toolCards;
    expect(cards.map((c) => c.toolName)).toContain("get_aggregated_nav");
    expect(cards.map((c) => c.toolName)).toContain("crosschain_sync");
    expect(result.reply).toContain("USDC");
    expect(result.reply).toContain("WETH");
    // HyperEVM is USDC-only — the per-chain summary must say so
    expect(result.reply).toMatch(/HyperEVM: USDC\b/);
  });

  it("serves LP tools for the 'uniswap' and 'liquidity' aliases", async () => {
    for (const alias of ["uniswap", "liquidity"]) {
      mockCreate.mockReset();
      const result = await processChat({} as Env, [{ role: "user", content: `what are my ${alias} tools?` }], ctx);
      expect(mockCreate).not.toHaveBeenCalled();
      const cards = (result.metadata as { toolCards: { toolName: string }[] }).toolCards;
      expect(cards.map((c) => c.toolName)).toContain("add_liquidity");
    }
  });
});

describe("tryFastPathToolMenu", () => {
  it("routes 'what are my hyperliquid tools?' to get_tool_menu with the category", () => {
    expect(tryFastPathToolMenu("what are my hyperliquid tools?")).toEqual({
      name: "get_tool_menu",
      args: { category: "hyperliquid" },
    });
  });

  it("routes 'list my gmx tools' to the gmx category", () => {
    expect(tryFastPathToolMenu("list my gmx tools")).toEqual({
      name: "get_tool_menu",
      args: { category: "gmx" },
    });
  });

  it("routes category-less requests to get_tool_menu without a category", () => {
    expect(tryFastPathToolMenu("what tools do I have")).toEqual({
      name: "get_tool_menu",
      args: {},
    });
    expect(tryFastPathToolMenu("list all my tools")).toEqual({
      name: "get_tool_menu",
      args: {},
    });
  });

  it("returns null for unrelated messages", () => {
    expect(tryFastPathToolMenu("deposit 5 USDC to hyperliquid")).toBeNull();
    expect(tryFastPathToolMenu("what are my open positions?")).toBeNull();
  });
});
