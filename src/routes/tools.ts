/**
 * HTTP Tool Endpoints — POST /api/tools/:toolName
 *
 * Direct tool invocation without LLM. Returns structured JSON responses.
 * Useful for agents that want to call specific tools programmatically
 * without paying for LLM processing.
 *
 * Auth: Same model as /api/chat — x402 or browser auth.
 * Vault-modifying tools (build_vault_swap, etc.) require operator auth
 * for delegated execution. Read-only tools work with just x402.
 */

import { Hono } from "hono";
import type { Env, AppVariables, RequestContext, ExecutionMode } from "../types.js";
import { executeToolCall, TOOL_NAME_ALIASES, OPERATOR_VERIFIED_TOOLS } from "../llm/client.js";
import { TOOL_DEFINITIONS as BASE_TOOL_DEFINITIONS } from "../llm/tools.js";
import { getSkillTools } from "../skills/index.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { sanitizeError } from "../config.js";
import type { Address } from "viem";

const tools = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** Tools that only read on-chain or off-chain data and do not produce transactions. */
const READONLY_TOOLS = new Set<string>([
  "get_swap_quote",
  "get_vault_info",
  "get_token_balance",
  "get_pool_info",
  "get_lp_positions",
  "gmx_get_positions",
  "gmx_get_markets",
  "check_delegation_status",
  "get_crosschain_quote",
  "get_aggregated_nav",
  "get_rebalance_plan",
  "verify_bridge_arrival",
  "list_twap_orders",
  "list_nav_syncs",
  "list_strategies",
  "switch_chain",
]);

function getToolCategory(name: string): string {
  if (name.startsWith("get_swap_quote") || name === "build_vault_swap") return "Spot Trading";
  if (name.startsWith("get_vault_info") || name === "get_token_balance" || name === "switch_chain") return "Vault Info";
  if (name.startsWith("gmx_")) return "GMX Perpetuals";
  if (name.startsWith("get_pool_info") || name.startsWith("add_liquidity") || name.startsWith("remove_liquidity") || name.startsWith("collect_lp_fees") || name.startsWith("burn_position") || name.startsWith("get_lp_positions")) return "Uniswap v4 LP";
  if (name.startsWith("crosschain_") || name.startsWith("get_aggregated_nav") || name.startsWith("get_rebalance_plan") || name.startsWith("verify_bridge_arrival")) return "Cross-Chain";
  if (name.startsWith("grg_")) return "GRG Staking";
  if (name === "deploy_smart_pool" || name === "fund_pool") return "Vault Management";
  if (name.startsWith("setup_delegation") || name.startsWith("revoke_delegation") || name.startsWith("check_delegation_status") || name.startsWith("revoke_selectors")) return "Delegation";
  if (name.startsWith("create_twap_") || name.startsWith("cancel_twap_") || name.startsWith("list_twap_")) return "TWAP Orders";
  if (name.startsWith("create_nav_sync") || name.startsWith("list_nav_syncs") || name.startsWith("cancel_nav_sync")) return "NAV Sync";
  if (name.startsWith("set_default_slippage") || name.startsWith("disable_swap_shield") || name.startsWith("enable_swap_shield")) return "Operator Settings";
  if (name.startsWith("refresh_oracle_feed")) return "Oracle";
  if (name.startsWith("list_strategies")) return "Strategy";
  return "Other";
}

// GET /api/tools — x402-gated tool discovery for autonomous agents.
// Returns the full catalog with schemas so agents know what each tool does
// and what arguments to pass. Requires x402 payment (exact scheme, $0.002 USDC).
tools.get("/", async (c) => {
  // Local auth guard: if x402 middleware failed to initialize or payment was
  // skipped, require browser verification. This prevents the paid catalog from
  // becoming publicly accessible during a facilitator outage.
  const isBrowserRequest = c.get("browserVerified") ?? false;
  if (!c.get("x402Paid") && !isBrowserRequest) {
    throw new AuthError("Authentication required", 401);
  }

  // Merge base tool definitions with skill tool definitions for a complete catalog.
  const allDefs = [...BASE_TOOL_DEFINITIONS, ...getSkillTools()];

  const toolCatalog = allDefs.map((def) => {
    const name = def.function.name;
    return {
      name,
      description: def.function.description,
      category: getToolCategory(name),
      parameters: def.function.parameters,
      requiresOperatorAuth: OPERATOR_VERIFIED_TOOLS.has(name),
      readOnly: READONLY_TOOLS.has(name),
    };
  });

  return c.json({
    description: "Rigoblock direct DeFi tool invocation. POST to /api/tools?toolName={name} with arguments object.",
    usage: "POST /api/tools?toolName={toolName}",
    price: "$0.002 USDC per call (x402 exact scheme, eip155:8453)",
    toolCount: toolCatalog.length,
    tools: toolCatalog,
  });
});

tools.post("/", async (c) => {
  try {
    const toolName = c.req.query("toolName");
    const body = await c.req.json<{
      arguments: Record<string, unknown>;
      vaultAddress?: string;
      chainId: number;
      operatorAddress?: string;
      authSignature?: string;
      authTimestamp?: number;
      executionMode?: ExecutionMode;
    }>();

    if (!toolName) {
      return c.json({ error: "toolName query parameter is required" }, 400);
    }

    if (!body.chainId) {
      return c.json({ error: "chainId is required" }, 400);
    }
    if (!body.arguments || typeof body.arguments !== "object") {
      return c.json({ error: "arguments object is required" }, 400);
    }

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
    const resolvedVaultAddress: Address = (body.vaultAddress || ZERO_ADDRESS) as Address;

    // Auth gate — same model as chat.ts
    const hasAuthCredentials = !!(body.operatorAddress && body.authSignature && body.authTimestamp);
    const isBrowserRequest = c.get("browserVerified") ?? false;
    let operatorVerified = false;

    if (hasAuthCredentials) {
      await verifyOperatorAuth({
        operatorAddress: body.operatorAddress || "",
        vaultAddress: body.vaultAddress || "",
        authSignature: body.authSignature || "",
        authTimestamp: body.authTimestamp || 0,
        preferredChainId: body.chainId,
        alchemyKey: c.env.ALCHEMY_API_KEY,
      });
      operatorVerified = true;
    } else if (!c.get("x402Paid") && !isBrowserRequest) {
      throw new AuthError("Authentication required", 401);
    }

    // x402 agents (non-browser, no operator auth) are allowed to call vault-tx tools in manual mode.
    // They receive unsigned calldata and sign it themselves. executeToolCall enforces the per-tool
    // auth checks (OPERATOR_VERIFIED_TOOLS, browser gate) — no early rejection needed here.

    const executionMode: ExecutionMode =
      body.executionMode === "delegated" && operatorVerified ? "delegated" : "manual";

    const ctx: RequestContext = {
      vaultAddress: resolvedVaultAddress,
      chainId: body.chainId,
      operatorAddress: body.operatorAddress as Address | undefined,
      operatorVerified,
      isBrowserRequest,
      executionMode,
    };

    const canonicalName = TOOL_NAME_ALIASES[toolName] ?? toolName;
    const result = await executeToolCall(c.env, ctx, toolName, body.arguments);

    return c.json({
      tool: canonicalName,
      message: result.message,
      transaction: result.transaction,
      chainSwitch: result.chainSwitch,
      suggestions: result.suggestions,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    console.error(`[tools] Error:`, err);
    const message = sanitizeError(err instanceof Error ? err.message : "Internal error");
    return c.json({ error: message }, 500);
  }
});

export { tools };
