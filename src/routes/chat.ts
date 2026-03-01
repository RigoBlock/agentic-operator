/**
 * Chat route — POST /api/chat
 *
 * Receives conversation messages + vault context from the frontend,
 * processes through LLM with tool calling, and returns the agent's
 * response. If a swap is built, includes the unsigned transaction
 * for the operator to sign in their wallet.
 */

import { Hono } from "hono";
import type { Env, ChatRequest, ChatResponse, RequestContext } from "../types.js";
import { processChat } from "../llm/client.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { sanitizeError } from "../config.js";
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

    // Filter to valid messages
    const allMessages = body.messages.filter(
      (m) => m.role && m.content && typeof m.content === "string",
    );

    if (allMessages.length === 0) {
      return c.json({ error: "No valid messages provided" }, 400);
    }

    // Keep only the last 10 messages to prevent context pollution.
    // Error-heavy history causes the LLM to stop calling tools.
    const messages = allMessages.slice(-10);

    const ctx: RequestContext = {
      vaultAddress: body.vaultAddress as Address,
      chainId: body.chainId,
      operatorAddress: body.operatorAddress as Address | undefined,
    };

    const response: ChatResponse = await processChat(c.env, messages, ctx);
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
