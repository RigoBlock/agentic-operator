/**
 * Tool definitions tests — verify all LLM tools are defined and dispatched,
 * capability boundaries, and system prompt integrity.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS, SYSTEM_PROMPT } from "../src/llm/tools.js";

// Tool names that MUST exist (security-relevant)
const REQUIRED_TOOLS = [
  // Core trading
  "get_swap_quote",
  "build_vault_swap",
  // Delegation management
  "setup_delegation",
  "revoke_delegation",
  "check_delegation_status",
  "revoke_selectors",
  // GMX perpetuals
  "gmx_open_position",
  "gmx_close_position",
  "gmx_get_positions",
  "gmx_cancel_order",
  "gmx_update_order",
  "gmx_claim_funding_fees",
  "gmx_get_markets",
  "gmx_increase_position",
  // Uniswap LP
  "get_pool_info",
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
  // Strategy listing compatibility alias (TWAP-only at runtime)
  "list_strategies",
  // Bridge verification
  "verify_bridge_arrival",
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
});

describe("SYSTEM_PROMPT", () => {
  it("exists and is non-empty", () => {
    expect(SYSTEM_PROMPT).toBeTypeOf("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("mentions that grg_end_epoch targets the staking proxy (not vault)", () => {
    expect(SYSTEM_PROMPT).toContain("staking proxy");
  });

  it("mentions delegation for agent execution", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("delegat");
  });
});
