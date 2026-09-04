/**
 * Tool menu end-to-end test — verifies that a get_tool_menu tool call returns
 * self-contained toolCards metadata in the ChatResponse, so the frontend can
 * render clickable cards. Regression: the selfContained early-return used to
 * drop metadata entirely.
 */
import { describe, it, expect, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

import { processChat } from "../src/llm/client.js";
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

describe("get_tool_menu via processChat", () => {
  it("returns toolCards metadata on the self-contained response", async () => {
    mockCreate.mockResolvedValueOnce(
      toolCallCompletion("get_tool_menu", { category: "hyperliquid" }),
    );

    const env = {} as Env;
    const ctx = {
      vaultAddress: "0x0000000000000000000000000000000000000000",
      chainId: 999,
      executionMode: "manual",
      aiApiKey: "test-key",
      aiModel: "test-model",
    } as unknown as RequestContext;

    const result = await processChat(env, [{ role: "user", content: "what are my hyperliquid tools?" }], ctx);

    expect(result.finalModel).toBe("tooling");
    expect(result.reply).toContain("hyperliquid tools");
    const cards = (result.metadata as { toolCards: { toolName: string; fields: unknown[] }[] }).toolCards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((c) => c.toolName)).toContain("hyperliquid_deposit");
    // Only one LLM round: the self-contained path must short-circuit the follow-up call
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
