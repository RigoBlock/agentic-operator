/**
 * Chat route — POST /api/chat
 *
 * Receives conversation messages + vault context from the frontend,
 * processes through LLM with tool calling, and returns the agent's
 * response.
 *
 * Execution modes:
 *   - "manual" (default): Returns unsigned transaction for operator to sign
 *   - "delegated": Agent wallet executes via EIP-7702 delegation after
 *     operator confirms the trade details (not the transaction itself)
 */

import { Hono } from "hono";
import type { Env, ChatRequest, ChatResponse, RequestContext, ExecutionMode } from "../types.js";
import { processChat } from "../llm/client.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { sanitizeError } from "../config.js";
import { executeViaDelegation, ExecutionError } from "../services/execution.js";
import { isDelegationActive } from "../services/delegation.js";
import type { Address } from "viem";

const chat = new Hono<{ Bindings: Env }>();

chat.post("/", async (c) => {
  try {
    const body = await c.req.json<ChatRequest>();

    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json({ error: "messages array is required" }, 400);
    }
    if (!body.vaultAddress) {
      return c.json({ error: "vaultAddress is required" }, 400);
    }
    if (!body.chainId) {
      return c.json({ error: "chainId is required" }, 400);
    }

    // ── Auth gate: verify the caller is the vault owner ──
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress || "",
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature || "",
      authTimestamp: body.authTimestamp || 0,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    // ── Resolve execution mode ──
    const requestedMode: ExecutionMode = body.executionMode || "manual";
    let executionMode: ExecutionMode = "manual";
    if (requestedMode === "delegated") {
      // Verify delegation is actually active on this chain
      const active = await isDelegationActive(c.env.KV, body.vaultAddress, body.chainId);
      if (active) {
        executionMode = "delegated";
      } else {
        console.warn(`[chat] Delegated mode requested but not active on chain ${body.chainId} for vault ${body.vaultAddress}`);
        // Fall back to manual — don't error, just degrade gracefully
      }
    }

    // Filter to valid messages
    const allMessages = body.messages.filter(
      (m) => m.role && m.content && typeof m.content === "string",
    );

    if (allMessages.length === 0) {
      return c.json({ error: "No valid messages provided" }, 400);
    }

    // Keep only the last 10 messages to prevent context pollution.
    const messages = allMessages.slice(-10);

    const ctx: RequestContext = {
      vaultAddress: body.vaultAddress as Address,
      chainId: body.chainId,
      operatorAddress: body.operatorAddress as Address | undefined,
      executionMode,
    };

    const response: ChatResponse = await processChat(c.env, messages, ctx);

    // ── Delegated execution: auto-execute if confirmExecution is set ──
    if (
      executionMode === "delegated" &&
      body.confirmExecution &&
      response.transaction
    ) {
      try {
        const result = await executeViaDelegation(
          c.env,
          response.transaction,
          body.vaultAddress,
        );
        response.executionResult = result;
        // Clear the unsigned transaction since we executed it
        response.transaction = undefined;
        response.reply = result.confirmed
          ? `Transaction executed successfully! [View on explorer](${result.explorerUrl || result.txHash})`
          : `Transaction submitted: ${result.txHash}. Waiting for confirmation...`;
      } catch (execErr) {
        if (execErr instanceof ExecutionError) {
          response.reply = `Delegation execution failed: ${execErr.message}. Falling back to manual mode — please sign the transaction in your wallet.`;
          // Keep the unsigned transaction for manual fallback
        } else {
          throw execErr;
        }
      }
    }

    return c.json(response);
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    console.error("[chat] Error:", err);
    const message = sanitizeError(err instanceof Error ? err.message : "Internal error");
    return c.json({ error: message }, 500);
  }
});

export { chat };
