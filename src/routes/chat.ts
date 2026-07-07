/**
 * Chat route — POST /api/chat
 *
 * Receives conversation messages + vault context from the frontend,
 * processes through LLM with tool calling, and returns the agent's
 * response.
 *
 * Execution modes:
 *   - "manual" (default): Returns unsigned transaction for operator to sign
 *   - "delegated": Agent wallet executes directly on the vault after
 *     operator confirms the trade details (vault checks delegation mapping)
 */

import { Hono } from "hono";
import type { Env, AppVariables, ChatRequest, ChatResponse, RequestContext, ExecutionMode, StreamEvent, ChatMessage } from "../types.js";
import { processChat } from "../llm/client.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";

import { sanitizeError } from "../config.js";
import { formatOutcomesMarkdown, ExecutionError } from "../services/execution.js";
import { runTransactionFlow, type ExecutionHooks, type ExecutionModePreference } from "../services/transactionFlow.js";
import type { Address } from "viem";

/**
 * Estimate inference cost for x402 upto-scheme settlement.
 *
 * Uses a simple token estimate: input chars / 4 ≈ input tokens,
 * output chars / 4 ≈ output tokens. Pricing is $1.50/M input +
 * $5.00/M output (covers Kimi K2.7 Code cost with ~25% margin).
 * Clamped to [$0.003, $0.10] — the min covers overhead and the
 * max must be <= the upto scheme's maxAmountRequired.
 *
 * Returns a dollar string like "$0.0047" for use in Settlement-Overrides header.
 */
function estimateInferenceCost(
  inputMessages: ChatMessage[],
  response: ChatResponse,
): string {
  const inputChars = inputMessages.reduce(
    (s, m) => s + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
  const outputChars =
    (response.reply?.length || 0) +
    (response.toolCalls?.reduce((s, tc) => s + JSON.stringify(tc).length, 0) || 0);

  const inputKTokens = inputChars / 4000;
  const outputKTokens = outputChars / 4000;
  const cost = Math.max(0.003, Math.min(0.10, inputKTokens * 0.0015 + outputKTokens * 0.005));
  return `$${cost.toFixed(4)}`;
}

const chat = new Hono<{ Bindings: Env; Variables: AppVariables }>();

chat.post("/", async (c) => {
  try {
    const body = await c.req.json<ChatRequest>();

    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json({ error: "messages array is required" }, 400);
    }
    if (!body.chainId) {
      return c.json({ error: "chainId is required" }, 400);
    }
    // vaultAddress is optional — zero address signals "no vault yet" (pool deployment flow)
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
    const resolvedVaultAddress: Address = (body.vaultAddress || ZERO_ADDRESS) as Address;

    // ── Auth gate ──
    // x402 payment = API access fee (external agents). Operator auth = vault authorization.
    // operatorAuthVerified = operator signature verified by x402 middleware (skips payment).
    //
    //   x402 + no auth                  → manual mode (unsigned tx data)
    //   x402 + auth (owner)             → manual or delegated
    //   operatorAuthVerified + no auth  → manual mode (unsigned tx data)
    //   operatorAuthVerified + auth     → manual or delegated
    //   auth only, non-owner            → 403
    //   no x402, no operatorAuth        → 401
    //
    // Delegated execution and vault-tx tool execution ALWAYS require proven vault
    // ownership (operatorVerified).
    const hasAuthCredentials = !!(body.operatorAddress && body.authSignature && body.authTimestamp);
    const isBrowserRequest = c.get("operatorAuthVerified") ?? false;
    let operatorVerified = isBrowserRequest;

    if (hasAuthCredentials) {
      await verifyOperatorAuth({
        operatorAddress: body.operatorAddress || "",
        vaultAddress: body.vaultAddress,
        authSignature: body.authSignature || "",
        authTimestamp: body.authTimestamp || 0,
        preferredChainId: body.chainId,
        alchemyKey: c.env.ALCHEMY_API_KEY,
      });
      operatorVerified = true;
    } else if (!c.get("x402Paid") && !isBrowserRequest) {
      throw new AuthError("Wallet not connected. Connect your wallet and sign to authenticate.", 401);
    }

    // ── Resolve execution mode ──
    // Delegated execution REQUIRES proven vault ownership. No exceptions.
    // Per-chain delegation is checked at execution time (/api/delegation/execute),
    // NOT here. This allows multi-chain swaps where the current chain may not have
    // delegation but the target swap chains do.
    const requestedMode: ExecutionMode = body.executionMode || "manual";
    let executionMode: ExecutionMode = "manual";
    if (requestedMode === "delegated") {
      if (!operatorVerified) {
        // No auth = no delegation. This is a hard security boundary.
        // Intentionally no console.warn in prod; the response makes the state clear.
      } else {
        // Operator verified — accept delegated mode.
        // Per-chain delegation check happens at execution time in /api/delegation/execute.
        executionMode = "delegated";
      }
    }

    // Filter to valid messages and enforce per-message length limit (8 KB).
    // Prevents context flooding and excessively expensive LLM calls.
    const MAX_MSG_CHARS = 8_000;
    const allMessages = body.messages.filter(
      (m) => m.role && m.content && typeof m.content === "string",
    );

    const oversized = allMessages.find((m) => (m.content as string).length > MAX_MSG_CHARS);
    if (oversized) {
      return c.json({ error: `Message too long (max ${MAX_MSG_CHARS} characters per message).` }, 400);
    }

    if (allMessages.length === 0) {
      return c.json({ error: "No valid messages provided" }, 400);
    }

    // Keep only the last 10 messages to prevent context pollution.
    const messages = allMessages.slice(-10);

    const ctx: RequestContext = {
      vaultAddress: resolvedVaultAddress,
      chainId: body.chainId,
      operatorAddress: body.operatorAddress as Address | undefined,
      operatorVerified,
      isBrowserRequest,
      executionMode,
      aiApiKey: body.aiApiKey,
      aiModel: body.aiModel,
      aiBaseUrl: body.aiBaseUrl,
      contextDocs: body.contextDocs,
      slippageBps: body.slippageBps,
    };

    // Request-scoped cache so the NAV shield can reuse the pre-swap NAV read
    // across the calldata-build pre-check and the broadcast check.
    const requestEnv: Env = { ...c.env, requestCache: new Map() };

    // ── SSE streaming mode ──
    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: StreamEvent) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch { /* stream closed */ }
          };

          try {
            send({ type: "status", message: "Processing..." });

            const response = await processChat(
              requestEnv, messages, ctx,
              undefined, // onToolResult
              send,      // onStreamEvent
            );

            // Delegated execution: use the unified TransactionFlow engine.
            if (executionMode === "delegated") {
              const txList = response.transactions?.length
                ? response.transactions
                : response.transaction ? [response.transaction] : [];
              if (txList.length > 0) {
                const flowResult = await runTransactionFlow(
                  requestEnv,
                  body.operatorAddress || "",
                  body.vaultAddress || "",
                  txList,
                  response.reply,
                  {
                    requestConfirmation: async (txs, ctx) => {
                      send({ type: "confirmation_required", transactions: txs, reply: ctx.reply });
                    },
                    onProgress: async (event) => {
                      if (event.type === "start") {
                        send({ type: "status", message: "Executing transactions..." });
                      }
                    },
                  },
                  body.confirmExecution ? "autonomous" : undefined,
                  requestEnv.requestCache,
                );

                if (flowResult.kind === "executed") {
                  const outcomes = flowResult.outcomes!;
                  const results = outcomes.filter(o => o.result).map(o => o.result!);
                  const hasFallback = outcomes.some(o => o.fallbackToManual);
                  if (results.length === 1) {
                    response.executionResult = results[0];
                    if (!hasFallback && !results[0].reverted) {
                      response.transaction = undefined;
                      response.transactions = undefined;
                    }
                  } else if (results.length > 1) {
                    response.executionResults = results;
                    const allSuccess = results.every(r => r.confirmed && !r.reverted);
                    if (!hasFallback && allSuccess) {
                      response.transaction = undefined;
                      response.transactions = undefined;
                    }
                  }
                  response.reply = formatOutcomesMarkdown(outcomes);
                }
                // kind === "pending_confirmation": transactions remain in response.reply/transactions
              }
            }

            // Don't send reply as 'text' — that would overwrite the streaming plan block.
            // The reply is included in the 'done' event and rendered by handleChatResponse.
            send({ type: "done", response });
          } catch (err) {
            const message = sanitizeError(err instanceof Error ? err.message : "Internal error");
            send({ type: "done", response: { reply: `Error: ${message}` } });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── Standard JSON response ──
    const response: ChatResponse = await processChat(requestEnv, messages, ctx);

    // ── Delegated execution: use the unified TransactionFlow engine ──
    // Handles both single (response.transaction) and multi (response.transactions).
    // The operator's autonomous/confirm preference is read from a unified KV key
    // shared with Telegram; `confirmExecution` in the body acts only as an explicit
    // override for external API callers.
    if (executionMode === "delegated") {
      const txList = response.transactions && response.transactions.length > 0
        ? response.transactions
        : response.transaction
          ? [response.transaction]
          : [];

      if (txList.length > 0) {
        const flowResult = await runTransactionFlow(
          requestEnv,
          body.operatorAddress || "",
          body.vaultAddress || "",
          txList,
          response.reply,
          {
            // Confirm mode for web JSON: nothing to render here; the pending
            // transactions stay in the response and the frontend shows the UI.
            requestConfirmation: async () => { /* no-op */ },
          },
          body.confirmExecution ? "autonomous" : undefined,
          requestEnv.requestCache,
        );

        if (flowResult.kind === "executed") {
          const outcomes = flowResult.outcomes!;
          const results = outcomes.filter(o => o.result).map(o => o.result!);
          const hasFallback = outcomes.some(o => o.fallbackToManual);

          if (results.length === 1) {
            response.executionResult = results[0];
            if (!hasFallback && !results[0].reverted) {
              response.transaction = undefined;
              response.transactions = undefined;
            }
          } else if (results.length > 1) {
            response.executionResults = results;
            const allSuccess = results.every(r => r.confirmed && !r.reverted);
            if (!hasFallback && allSuccess) {
              response.transaction = undefined;
              response.transactions = undefined;
            }
          }

          response.reply = formatOutcomesMarkdown(outcomes);
        }
        // kind === "pending_confirmation": transactions remain in response for the frontend
      }
    }

    // Set Settlement-Overrides header so the x402 upto-scheme middleware
    // settles for the actual inference cost rather than the full $0.10 max.
    // Only set for x402-paid requests (external agents). Browser sessions are
    // exempt from x402 and don't go through upto settlement.
    if (c.get("x402Paid")) {
      c.header(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: estimateInferenceCost(messages, response) }));
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
