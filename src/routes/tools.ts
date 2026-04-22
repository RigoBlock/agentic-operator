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
import { executeToolCall } from "../llm/client.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { sanitizeError } from "../config.js";
import type { Address } from "viem";

const tools = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** Read-only tools that don't modify vault state */
const READ_ONLY_TOOLS = new Set([
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
  "list_twap_orders",
  "list_strategies",
  "list_nav_syncs",
]);

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
    const isBrowserRequest = c.req.header("sec-fetch-site") === "same-origin";
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

    // Non-read-only tools require at least operator auth or browser origin
    if (!READ_ONLY_TOOLS.has(toolName) && !operatorVerified && !isBrowserRequest) {
      return c.json({ error: `Tool '${toolName}' requires operator authentication` }, 403);
    }

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

    const result = await executeToolCall(c.env, ctx, toolName, body.arguments);

    return c.json({
      tool: toolName,
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
