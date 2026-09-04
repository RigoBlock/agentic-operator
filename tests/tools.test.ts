/**
 * Tool definitions tests — verify all LLM tools are defined and dispatched,
 * capability boundaries, and system prompt integrity.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../src/llm/tools.js";
import { CORE_PROMPT, DOMAIN_PROMPTS, CORE_TOOLS } from "../src/llm/prompts.js";
import { TOOL_NAME_ALIASES } from "../src/llm/client.js";

// Tool names that MUST exist (security-relevant)
const REQUIRED_TOOLS = [
  // Core trading
  "get_swap_quote",
  "build_vault_swap",
  "verify_token",
  // Delegation management
  "setup_delegation",
  "revoke_delegation",
  "check_delegation_status",
  "check_pending_tx",
  "revoke_selectors",
  // GMX perpetuals
  "gmx_decrease_position",
  "gmx_get_positions",
  "gmx_cancel_order",
  "gmx_update_order",
  "gmx_claim_funding_fees",
  "gmx_get_markets",
  "gmx_increase_position",
  // Hyperliquid perpetuals (HyperEVM)
  "hyperliquid_get_positions",
  "hyperliquid_get_markets",
  "hyperliquid_deposit",
  "hyperliquid_limit_order",
  "hyperliquid_cancel_order",
  "hyperliquid_usd_class_transfer",
  "hyperliquid_spot_send",
  // Uniswap LP
  "get_pool_info",
  "initialize_pool",
  "add_liquidity",
  "remove_liquidity",
  "get_lp_positions",
  "collect_lp_fees",
  "burn_position",
  // Cross-chain
  "crosschain_transfer",
  "get_crosschain_quote",
  "get_aggregated_nav",
  "get_rebalance_plan",
  "crosschain_sync",
  // GRG Staking
  "grg_stake",
  "grg_undelegate_stake",
  "grg_unstake",
  "grg_end_epoch",
  "grg_claim_rewards",
  // Vault management
  "get_vault_info",
  "get_token_balance",
  "deploy_smart_pool",
  "fund_pool",
  // Utility
  "switch_chain",
  // Trading settings
  "set_default_slippage",
  "set_swap_shield_tolerance",
  "enable_swap_shield",
  "set_nav_shield_threshold",
  "enable_nav_shield",
  "refresh_oracle_feed",
  // Strategy listing compatibility alias (TWAP-only at runtime)
  "list_strategies",
  // Bridge verification
  "verify_bridge_arrival",
  // Tool menu (structured cards rendered by the chat UI)
  "get_tool_menu",
];

describe("TOOL_DEFINITIONS", () => {
  it("has all required tools", () => {
    const definedNames = TOOL_DEFINITIONS.map((t) => t.function.name);
    for (const name of REQUIRED_TOOLS) {
      expect(definedNames, `Missing tool: ${name}`).toContain(name);
    }
  });

  it("has no duplicate tool names", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("every tool has name, description, and parameters", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.function.name).toBeTypeOf("string");
      expect(tool.function.name.length).toBeGreaterThan(0);
      expect(tool.function.description).toBeTypeOf("string");
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it("has exactly the right count of tools (no orphans)", () => {
    // This number should be updated when tools are added/removed
    // Prevents accidental removal of tools
    expect(TOOL_DEFINITIONS).toHaveLength(REQUIRED_TOOLS.length);
  });

  it("maps cross-chain aliases to the correct canonical tools", () => {
    expect(TOOL_NAME_ALIASES.bridge_tokens).toBe("crosschain_transfer");
    expect(TOOL_NAME_ALIASES.sync_tokens).toBe("crosschain_sync");
    expect(TOOL_NAME_ALIASES.equalize_nav).toBe("crosschain_sync");
  });

  it("includes verify_token in CORE_TOOLS so it is always available for disambiguation", () => {
    expect(CORE_TOOLS).toContain("verify_token");
  });
});

describe("SYSTEM_PROMPT", () => {
  const systemPrompt = CORE_PROMPT + "\n" + Object.values(DOMAIN_PROMPTS).join("\n");

  it("exists and is non-empty", () => {
    expect(systemPrompt).toBeTypeOf("string");
    expect(systemPrompt.length).toBeGreaterThan(100);
  });

  it("mentions that grg_end_epoch targets the staking proxy (not vault)", () => {
    expect(systemPrompt).toContain("staking proxy");
  });

  it("mentions delegation for agent execution", () => {
    expect(systemPrompt.toLowerCase()).toContain("delegation");
  });

  it("instructs the LLM to call verify_token when the user answers a token disambiguation question", () => {
    expect(systemPrompt.toLowerCase()).toContain("verify_token");
    expect(systemPrompt.toLowerCase()).toContain("disambiguation");
  });

  it("instructs the LLM to use get_tool_menu for tool-menu requests instead of answering from its own assumptions", () => {
    expect(systemPrompt).toContain("get_tool_menu");
    expect(CORE_TOOLS).toContain("get_tool_menu");
  });
});

describe("get_tool_menu handler", () => {
  it("returns 11 hyperliquid cards with only required input fields", async () => {
    const { handle_get_tool_menu } = await import("../src/llm/handlers/menu.js");
    const result = await handle_get_tool_menu(
      {} as never, {} as never, { category: "hyperliquid" }, "get_tool_menu",
    );
    const cards = (result.metadata as { toolCards: { toolName: string; title: string; fields: { name: string; required: boolean }[] }[] }).toolCards;
    expect(cards).toHaveLength(11);
    expect(cards.map((c) => c.toolName)).toContain("hyperliquid_deposit");
    expect(cards.map((c) => c.toolName)).toContain("crosschain_transfer");
    for (const card of cards) {
      expect(card.title.length).toBeGreaterThan(0);
      for (const field of card.fields) {
        expect(field.name).toBeTypeOf("string");
      }
    }
    const deposit = cards.find((c) => c.toolName === "hyperliquid_deposit")!;
    expect(deposit.fields.map((f) => f.name)).toContain("amount");
    const transfer = cards.find((c) => c.toolName === "crosschain_transfer")!;
    expect(transfer.fields.filter((f) => f.required).map((f) => f.name)).toEqual(
      expect.arrayContaining(["destinationChain", "token", "amount"]),
    );
  });

  it("lists available categories for unknown or missing category", async () => {
    const { handle_get_tool_menu } = await import("../src/llm/handlers/menu.js");
    const result = await handle_get_tool_menu({} as never, {} as never, {}, "get_tool_menu");
    expect(result.metadata).toHaveProperty("toolCategories");
    expect((result.metadata as { toolCategories: string[] }).toolCategories).toContain("hyperliquid");
    expect(result.selfContained).toBe(true);
  });
});
