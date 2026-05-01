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
import { executeToolCall, TOOL_NAME_ALIASES } from "../llm/client.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { sanitizeError } from "../config.js";
import type { Address } from "viem";

const tools = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/tools — endpoint discovery (also used for Bazaar registration).
// Returns the list of available tools so crawlers and agents can discover them.
// Auth: x402 payment or browser session (same as POST /:toolName).
tools.get("/", async (c) => {
  if (!c.get("x402Paid") && !c.get("browserVerified")) {
    return c.json({ error: "Authentication required. Use x402 payment or a verified browser session." }, 401);
  }
  return c.json({
    description: "Rigoblock direct DeFi tool invocation. POST to /api/tools/{toolName} with arguments object.",
    usage: "POST /api/tools/{toolName}",
    price: "$0.002 USDC per call (x402 exact scheme, eip155:8453)",
    tools: [
      "get_swap_quote", "build_vault_swap", "get_vault_info", "get_token_balance",
      "get_pool_info", "add_liquidity", "remove_liquidity", "collect_lp_fees", "burn_position",
      "get_lp_positions", "gmx_open_position", "gmx_close_position", "gmx_increase_position",
      "gmx_get_positions", "gmx_cancel_order", "gmx_update_order", "gmx_claim_funding_fees",
      "gmx_get_markets", "setup_delegation", "revoke_delegation", "check_delegation_status",
      "deploy_smart_pool", "fund_pool", "crosschain_transfer", "crosschain_sync",
      "get_crosschain_quote", "get_aggregated_nav", "get_rebalance_plan",
      "list_strategies", "verify_bridge_arrival", "grg_stake", "grg_unstake",
      "grg_undelegate_stake", "grg_end_epoch", "grg_claim_rewards", "revoke_selectors",
      "set_default_slippage", "disable_swap_shield", "enable_swap_shield",
      "create_twap_order", "cancel_twap_order", "list_twap_orders",
      "create_nav_sync", "list_nav_syncs", "cancel_nav_sync", "refresh_oracle_feed",
    ],
  });
});

tools.post("/:toolName", async (c) => {
  try {
    const toolName = c.req.param("toolName");
    const body = await c.req.json<{
      arguments: Record<string, unknown>;
      vaultAddress?: string;
      chainId: number;
      operatorAddress?: string;
      authSignature?: string;
      authTimestamp?: number;
      executionMode?: ExecutionMode;
    }>();

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
