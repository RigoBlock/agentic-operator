/**
 * LLM Client — OpenAI-compatible chat completion with tool calling.
 *
 * Supports two execution modes:
 *   - Manual: Agent builds unsigned transactions, operator signs from their wallet.
 *   - Delegated: Agent wallet executes via EIP-7702 delegation after operator
 *     confirms trade details (no manual signing required).
 */

import OpenAI from "openai";
import type { Env, ChatMessage, ChatResponse, ToolCallResult, SwapIntent, UnsignedTransaction, RequestContext, StreamEvent } from "../types.js";
import { TOOL_DEFINITIONS as BASE_TOOL_DEFINITIONS, RUNTIME_CONTEXT_PACK } from "./tools.js";
import { detectDomains, buildSystemPrompt, filterToolsForDomains } from "./prompts.js";
import { getSkillTools, getSkillSystemPrompt } from "../skills/index.js";

// Merge skill tools into the base definitions (skill tools are always available for dispatch)
const ALL_TOOL_DEFINITIONS = [...BASE_TOOL_DEFINITIONS, ...getSkillTools()];
import { resolveTokenAddress, SUPPORTED_CHAINS, TESTNET_CHAINS, sanitizeError } from "../config.js";
import { AuthError } from "../services/auth.js";
import { formatUnits, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { getClient } from "../services/vault.js";
import { checkNavImpact } from "../services/navGuard.js";
import {
  getSwapShieldTolerance,
  getStoredSlippage,
  DEFAULT_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  DEFAULT_MAX_DIVERGENCE_PCT,
  checkSwapPrice,
} from "../services/swapShield.js";
import { TOOL_HANDLER_REGISTRY } from "./handlers/index.js";

// Known on-chain error selectors for Rigoblock pool / Across bridge contracts.
// These appear as 4-byte hex prefixes in "execution reverted" messages.
const POOL_ERROR_SELECTORS: Record<string, string> = {
  "0xd99e07af": "OutputAmountTooLow — bridge relay fee is too high for this amount/route. Try a larger amount (e.g. ≥$5 USDC) or wait for a less congested window.",
  "0x7eb8a32f": "OutputAmountTooHigh — the bridge output exceeds what the solver can cover.",
  "0xf722177f": "InvalidQuoteTimestamp — the bridge quote expired before submission. Retry to get a fresh quote.",
  "0x0f6e887f": "EffectiveSupplyTooLow — a prior bridge left the source pool below minimum operating supply. The pool cannot send more assets until supply is replenished on that chain.",
  "0x162e92dd": "SameChainTransfer — the source and destination chain resolved to the same chain. This usually means the NAV equalization auto-corrected the direction incorrectly.",
  "0xec8f2f9a": "TransferFromRecipientNotSettler — the 0x Settler contract rejected this swap because the vault is not recognized as a valid recipient. This token pair may not be supported via 0x for vault swaps. Try using Uniswap instead (omit 'using 0x').",
};

/**
 * Map hallucinated LLM tool names to the correct canonical tool name.
 * Models (especially smaller/quantized ones) sometimes call "swap" instead of
 * "build_vault_swap", "quote" instead of "get_swap_quote", etc.
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  swap: "build_vault_swap",
  quote: "get_swap_quote",
  get_quote: "get_swap_quote",
  swap_tokens: "build_vault_swap",
  execute_swap: "build_vault_swap",
  trade: "build_vault_swap",
  build_lp_add: "add_liquidity",
  build_lp_remove: "remove_liquidity",
  init_pool: "initialize_pool",
  bridge_tokens: "crosschain_transfer",
  stake_grg: "grg_stake",
  equalize_nav: "crosschain_sync",
};

/**
 * True when request context includes a verified operator identity.
 * Use this for ALL operator-scoped KV reads/writes to avoid trusting
 * caller-supplied operatorAddress without auth.
 */
export function isVerifiedOperatorContext(
  ctx: RequestContext,
): ctx is RequestContext & { operatorAddress: Address; operatorVerified: true } {
  return !!ctx.operatorVerified && !!ctx.operatorAddress;
}

/**
 * Tools that require verified operator authentication.
 *
 * Keep this as the single source of truth instead of scattering checks in
 * individual tool handlers.
 */
export const OPERATOR_VERIFIED_TOOLS = new Set<string>([
  // Operator-scoped KV mutations
  "set_default_slippage",
  "set_swap_shield_tolerance",
  "enable_swap_shield",
  // Strategy visibility is operator-private
  "list_strategies",
  // NAV Sync: reads/writes operator-private KV configs
  "create_nav_sync",
  "list_nav_syncs",
  "cancel_nav_sync",
  // Delegation management: these trigger server-side mutations (CDP wallet creation,
  // KV writes) before the user signs — require ownership proof to prevent abuse.
  "setup_delegation",
  "revoke_delegation",
  "revoke_selectors",
]);

/**
 * Tools that produce vault transaction calldata.
 * For browser requests these require operatorVerified — a non-owner browser user
 * should sign in rather than wasting LLM inference generating calldata that will
 * always revert on-chain when signed by the wrong wallet.
 * For x402 agents (non-browser), these are allowed in manual (unsigned) mode —
 * that is the intended Tier 1 use case described in AGENTS.md.
 */
export const VAULT_TX_TOOLS = new Set<string>([
  "build_vault_swap",
  "add_liquidity",
  "remove_liquidity",
  "collect_lp_fees",
  "burn_position",
  "fund_pool",
  "crosschain_transfer",
  "crosschain_sync",
  "gmx_open_position",
  "gmx_close_position",
  "gmx_increase_position",
  "gmx_cancel_order",
  "gmx_update_order",
  "gmx_claim_funding_fees",
  "grg_stake",
  "grg_undelegate_stake",
  "grg_unstake",
  "grg_end_epoch",
  "grg_claim_rewards",
  "create_twap_order",
  "cancel_twap_order",
]);

/**
 * Translate raw error messages into user-friendly language.
 * Preserves on-chain revert details (decoded from selectors) while hiding
 * RPC internals, stack traces, and API keys.
 */
export function friendlyError(raw: string): string {
  // Pass through already-formatted rich error messages (multiline with context).
  // These come from tool handlers (crosschain_sync, Swap Shield, etc.) that include proposed
  // action details, NAV data, options, and decoded revert reasons. Don't strip them.
  if (raw.includes('\n') && (raw.startsWith('❌') || raw.startsWith('⚠️') || raw.includes('Proposed action:'))) {
    return raw;
  }
  // Uniswap Trading API capacity error — usually triggered when GMX handler
  // tries to swap stablecoins to ETH to cover the GMX keeper execution fee.
  if (/3040|capacity.*exceeded/i.test(raw) && /uniswap/i.test(raw)) {
    return "Uniswap Trading API is temporarily at capacity (error 3040). " +
      "If this happened during a GMX trade, it means the vault doesn't have enough native ETH for the GMX keeper fee and the fallback ETH swap also failed. " +
      "Fix: send a small amount of ETH (≥0.005) directly to the vault, then retry.";
  }
  if (/3040|capacity.*exceeded/i.test(raw)) {
    return "A pricing API is temporarily at capacity (error 3040). Please retry in a few seconds.";
  }
  // Gas-sponsored execution failures
  if (/Invalid parameters.*RPC method/i.test(raw)) {
    return "Gas-sponsored execution failed due to an RPC configuration issue. Try again or contact support.";
  }
  // Effective supply too low — named error in message
  if (/EffectiveSupplyTooLow/i.test(raw)) {
    return POOL_ERROR_SELECTORS["0x0f6e887f"];
  }
  // Unknown tool — after aliasing, this means the tool genuinely doesn't exist
  const unknownTool = raw.match(/Unknown tool:\s*(\S+)/);
  if (unknownTool) {
    return `Tool "${unknownTool[1]}" is not available. Please try rephrasing your request.`;
  }
  // Pool not initialized
  if (/pool not initialized/i.test(raw) || /pool not found/i.test(raw) || /exact pool key/i.test(raw)) {
    return "Uniswap v4 pool not found with the given fee and tickSpacing on this chain. " +
      "Uniswap v4 supports infinite fee tiers — the fee and tickSpacing must match the pool exactly. " +
      "Call get_pool_info with the pool ID to discover the correct fee, tickSpacing, and hooks address.";
  }
  // Simulation failed
  if (/simulation failed/i.test(raw) || /would revert on-chain/i.test(raw)) {
    const onChainErr = raw.match(/On-chain error:\s*([^.]+)/i);
    if (onChainErr) return `Transaction would fail on-chain: ${onChainErr[1].trim()}.`;
    // Preserve the actual reason if present after "on-chain" or the first colon
    const detailMatch = raw.match(/(?:on-chain|revert[a-z-]*)[\s:,]+([A-Za-z].{20,})/i);
    if (detailMatch) return `Transaction simulation failed: ${detailMatch[1].trim().slice(0, 300)}`;
    return "Transaction simulation failed — it would revert on-chain. Check parameters and try again.";
  }
  // Decode known 4-byte pool/bridge error selectors from "execution reverted" messages.
  // These appear as 0x<8 hex chars> in the revert data — map them to human-readable errors.
  // NOTE: No word boundary (\b) after the 8 hex chars — revert data always has more hex following.
  if (/execution reverted/i.test(raw)) {
    const selMatch = raw.match(/0x([0-9a-fA-F]{8})/);
    if (selMatch) {
      const sel = `0x${selMatch[1].toLowerCase()}`;
      if (POOL_ERROR_SELECTORS[sel]) return `On-chain revert: ${POOL_ERROR_SELECTORS[sel]}`;
    }
    // No decoded selector — show the full raw message (truncated at 300 chars).
    // Truncating at 150 was hiding critical revert context.
    return raw.length <= 300 ? raw : raw.slice(0, 300) + "…";
  }
  // Keep it if already short
  if (raw.length < 200) return raw;
  // Truncate long errors (increased from 150 to preserve more context)
  return raw.slice(0, 200).replace(/\s+\S*$/, "") + "…";
}

/**
 * Detect text that is just a tool-call recommendation (e.g. "Your function call
 * should be: {JSON}") rather than actual analysis or plan text. These should NOT
 * be shown as "Agent plan" — they're noise from the LLM failing to use structured
 * tool calls.
 */
function looksLikeToolCallText(text: string): boolean {
  // Text that's mostly a JSON tool call with optional prefix/suffix
  const stripped = text.replace(/```(?:json)?\s*\n?/g, '').trim();
  // XML-style tool call tags used by some models (legacy tool_call format)
  if (/<tool_call>/i.test(stripped)) return true;
  // OpenAI-style: {"type": "function", "name": "...", ...} anywhere in text
  if (/\{\s*"type"\s*:\s*"function"/i.test(stripped)) return true;
  // Classic prefix patterns: "function call:", "here is {", "call the tool: {", etc.
  if (/(?:function.?call|should\s+(?:be|call)|here\s+is|call\s+the\s+tool)\s*:?\s*\{/i.test(stripped)) return true;
  // Scan entire text for a balanced JSON object that looks like a tool call
  // (has both "name" and "parameters"/"arguments" keys) — catches any position, not just start
  const braceIdx = stripped.indexOf('{');
  if (braceIdx >= 0) {
    const jsonPart = extractBalancedBraces(stripped.slice(braceIdx));
    if (jsonPart) {
      // Contains both a name key and a parameters/arguments key → tool call JSON
      if (/"name"\s*:/.test(jsonPart) && /"(?:parameters|arguments)"\s*:/.test(jsonPart)) return true;
      // Starts within 80 chars and dominates the text (>50%) → predominantly JSON
      if (braceIdx < 80 && jsonPart.length > stripped.length * 0.5) return true;
    }
  }
  return false;
}

/**
 * Extract the first balanced `{…}` block from a string.
 * Returns the content (including outer braces) or null if not found.
 */
function extractBalancedBraces(s: string): string | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * Adapter: calls Workers AI via the binding and wraps the response in
 * OpenAI-compatible format so the rest of processChat() works unchanged.
 *
 * Extracts <think>...</think> reasoning blocks and stores them in a custom
 * `_reasoning` field on the response for the caller.
 */
async function callWorkersAI(
  ai: Ai,
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionTool[],
  onReasoningToken?: (accumulated: string) => void,
): Promise<OpenAI.ChatCompletion> {
  // Workers AI rejects null content (which the OpenAI spec allows for assistant
  // messages that contain tool_calls). Normalise to "" before sending so the
  // model receives a valid message structure in multi-turn tool loops.
  const sanitizedMessages = messages.map((m) => ({
    ...m,
    content: m.content === null ? "" : m.content,
  }));

  // For Kimi K2.6: use higher max_tokens to allow full reasoning.
  const isKimi = model.includes('kimi') || model.includes('moonshotai');

  // ── Streaming mode (all models when callback provided) ──
  // Streams tokens in real-time so the user sees progress immediately.
  // Kimi K2.6: emits native delta tool_calls; plain-text replies stream as text tokens.
  if (onReasoningToken) {
    const stream = await (ai as any).run(model, {
      messages: sanitizedMessages as any,
      ...(tools ? { tools: tools as any } : {}),
      max_tokens: 16384,
      stream: true,
    });

    // Parse the SSE stream and emit reasoning tokens in real-time
    const reader = (stream as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let lineBuffer = '';
    let reasoning = '';
    // Throttle reasoning events: emit at most every 150ms to avoid flooding the SSE pipe
    let lastEmitTime = 0;
    // Collect native tool_call deltas (OpenAI streaming format)
    // index → {id, name, arguments}
    const deltaToolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));

          // Collect native tool_call deltas (Kimi K2.6 uses OpenAI structured format)
          const deltaToolCalls = json.choices?.[0]?.delta?.tool_calls;
          if (Array.isArray(deltaToolCalls)) {
            for (const tc of deltaToolCalls) {
              const idx: number = tc.index ?? 0;
              if (!deltaToolCallMap.has(idx)) {
                deltaToolCallMap.set(idx, { id: tc.id || '', name: '', arguments: '' });
              }
              const entry = deltaToolCallMap.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }

          // Workers AI uses json.response (legacy) or json.choices[0].delta.content (OpenAI-compat)
          const token: string = json.response || json.choices?.[0]?.delta?.content || '';
          if (!token) continue;
          fullText += token;

          // Kimi K2.6: emit text tokens until tool-call JSON starts.
          // Kimi typically uses native delta tool_calls (handled above), but falls
          // through here for plain-text responses.
          const jsonStarted = fullText.trimStart().startsWith('{') ||
            /\{[^}]*"(?:name|type|function|parameters|arguments)"\s*:/.test(fullText);
          if (token && !jsonStarted) {
            const now = Date.now();
            if (now - lastEmitTime > 150) {
              onReasoningToken(fullText.trim());
              lastEmitTime = now;
            }
          }
        } catch {
          // Malformed JSON chunk — skip
        }
      }
    }

    // Final reasoning emit (un-throttled)
    if (reasoning.trim()) {
      onReasoningToken(reasoning.trim());
    }

    // Now process the accumulated fullText exactly like the non-streaming path
    let hasToolCalls = false;
    let toolCalls: any[] | undefined;
    let textContent: string | null = fullText || null;

    // Extract reasoning from the accumulated text
    let extractedReasoning: string | null = null;
    if (textContent) {
      const thinkMatch = textContent.match(/<think>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        extractedReasoning = thinkMatch[1].trim();
        textContent = textContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim() || null;
      }
    }

    // Prefer native delta tool_calls over text-embedded extraction.
    // Kimi K2.6 returns structured tool_calls in the streaming delta —
    // these are more reliable than the regex text-extraction fallback.
    if (deltaToolCallMap.size > 0) {
      const assembled = Array.from(deltaToolCallMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id || `call_stream_${Date.now()}`,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }))
        .filter(tc => tc.function.name.length > 0);
      if (assembled.length > 0) {
        console.log(`[Workers AI streaming] Using ${assembled.length} native delta tool_call(s): ${assembled.map(t => t.function.name).join(', ')}`);
        hasToolCalls = true;
        toolCalls = assembled;
        textContent = null; // discard text — native tool_calls take precedence
      }
    }

    // Extract text-embedded tool calls (same logic as non-streaming path)
    if (!hasToolCalls && textContent) {
      const cleaned = textContent.replace(/```(?:json)?\s*\n?/g, '');
      const validTools = tools?.map(t => t.function?.name).filter(Boolean) || [];
      const isValidTool = (n: string) => validTools.includes(n) || validTools.includes(TOOL_NAME_ALIASES[n] || '');
      const resolveTool = (n: string) => validTools.includes(n) ? n : (TOOL_NAME_ALIASES[n] || n);

      let extractedFnName: string | undefined;
      let extractedFnArgs: string | undefined;

      // Pattern 1: name/function key before parameters/arguments
      const fwdPattern = /\{\s*(?:"type"\s*:\s*"function"\s*,\s*)?"(?:function_name|function|name)"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*/;
      const fwdMatch = cleaned.match(fwdPattern);
      if (fwdMatch) {
        const fnName = fwdMatch[1];
        const afterKey = cleaned.slice(fwdMatch.index! + fwdMatch[0].length);
        const args = extractBalancedBraces(afterKey);
        if (args !== null && isValidTool(fnName)) {
          extractedFnName = resolveTool(fnName);
          extractedFnArgs = args;
        }
      }

      // Pattern 2: parameters/arguments before name (reversed key order)
      if (!extractedFnName) {
        const revPattern = /\{\s*(?:"type"\s*:\s*"function"\s*,\s*)?"(?:parameters|arguments)"\s*:\s*/;
        const revMatch = cleaned.match(revPattern);
        if (revMatch) {
          const afterParams = cleaned.slice(revMatch.index! + revMatch[0].length);
          const args = extractBalancedBraces(afterParams);
          if (args !== null) {
            const rest = afterParams.slice(args.length).replace(/^\s*}\s*/, '');
            const nameAfter = rest.match(/,\s*"(?:function_name|function|name)"\s*:\s*"([^"]+)"/);
            if (nameAfter && isValidTool(nameAfter[1])) {
              extractedFnName = resolveTool(nameAfter[1]);
              extractedFnArgs = args;
            }
          }
        }
      }

      if (extractedFnName && extractedFnArgs) {
        console.log(`[Workers AI streaming] Extracted text-embedded tool call: ${extractedFnName}`);
        hasToolCalls = true;
        toolCalls = [{ function: { name: extractedFnName, arguments: extractedFnArgs } }];
        textContent = null;
      }
    }

    return {
      id: `chatcmpl-wai-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant" as const,
          content: hasToolCalls ? null : textContent,
          ...(hasToolCalls ? {
            tool_calls: toolCalls!.map((tc: any, i: number) => ({
              id: tc.id || `call_${Date.now()}_${i}`,
              type: "function" as const,
              function: {
                name: tc.function?.name || tc.name || "",
                arguments: typeof tc.function?.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
              },
            })),
          } : {}),
        },
        finish_reason: (hasToolCalls ? "tool_calls" : "stop") as any,
      }],
      _reasoning: extractedReasoning,
    } as any;
  }

  // ── Non-streaming path (all models when no streaming callback provided) ──
  const result = await (ai as any).run(model, {
    messages: sanitizedMessages as any,
    ...(tools ? { tools: tools as any } : {}),
    max_tokens: isKimi ? 16384 : 4096,
  });

  // Workers AI returns text in different fields depending on model:
  // - Legacy format: result.response (string)
  // - OpenAI-compat format (Kimi K2.6, newer models): result.choices[0].message.content
  const rawToolCalls = result.tool_calls ?? result.choices?.[0]?.message?.tool_calls;
  let hasToolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0;
  let toolCalls = hasToolCalls ? rawToolCalls : undefined;
  const rawText = (typeof result.response === 'string' && result.response)
    ? result.response
    : (typeof result.choices?.[0]?.message?.content === 'string' ? result.choices[0].message.content : null);
  let textContent: string | null = rawText;

  // Resolve tool name aliases in structured tool_calls (e.g. "swap" → "build_vault_swap").
  // If ALL tool_calls have unknown names even after aliasing, discard them and try
  // text-embedded extraction instead — the text often contains the correct tool name.
  if (hasToolCalls && toolCalls) {
    const validTools = new Set(tools?.map(t => t.function?.name).filter(Boolean) || []);
    let allUnknown = true;
    for (const tc of toolCalls) {
      const rawName = tc.function?.name || tc.name || "";
      const aliased = TOOL_NAME_ALIASES[rawName];
      if (aliased) {
        console.log(`[Workers AI] Tool alias in structured call: "${rawName}" → "${aliased}"`);
        if (tc.function) tc.function.name = aliased;
        else tc.name = aliased;
      }
      const finalName = tc.function?.name || tc.name || "";
      if (validTools.has(finalName) || TOOL_NAME_ALIASES[finalName]) {
        allUnknown = false;
      }
    }
    // If all structured tool_calls are for unknown tools, discard them so
    // text-embedded extraction has a chance to find the correct tool.
    if (allUnknown && textContent) {
      console.warn(`[Workers AI] All structured tool_calls have unknown names — discarding, will try text extraction`);
      hasToolCalls = false;
      toolCalls = undefined;
    }
  }

  // ── Extract reasoning from <think>...</think> blocks ──
  // The reasoning trace is stored on the response object for the caller to surface.
  let reasoning: string | null = null;
  if (textContent) {
    const thinkMatch = textContent.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      reasoning = thinkMatch[1].trim();
      textContent = textContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim() || null;
      console.log(`[Workers AI] Extracted reasoning (${reasoning.length} chars)`);
    }
  }

  // Workers AI sometimes embeds tool calls as JSON text instead of structured
  // tool_calls. Detect and extract them so they get executed properly.
  // Matches: {"function": "name", "parameters": {...}}
  //          {"function_name": "name", "parameters": {...}}
  //          {"name": "name", "parameters": {...}}
  //          {"type": "function", "name": "...", "parameters": {...}}
  //          ```json\n{"name": ...}\n``` (markdown code blocks)
  //          Also handles reversed key order (parameters before name).
  if (!hasToolCalls && textContent) {
    // Strip markdown code fences if present
    const cleaned = textContent.replace(/```(?:json)?\s*\n?/g, '');
    const validTools = tools?.map(t => t.function?.name).filter(Boolean) || [];
    const isValidTool = (n: string) => validTools.includes(n) || validTools.includes(TOOL_NAME_ALIASES[n] || '');
    const resolveTool = (n: string) => validTools.includes(n) ? n : (TOOL_NAME_ALIASES[n] || n);

    // Try multiple patterns — models sometimes output different JSON structures
    let extractedFnName: string | undefined;
    let extractedFnArgs: string | undefined;

    // Pattern 1: name/function key comes BEFORE parameters/arguments
    const fwdPattern = /\{\s*(?:"type"\s*:\s*"function"\s*,\s*)?"(?:function_name|function|name)"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*/;
    const fwdMatch = cleaned.match(fwdPattern);
    if (fwdMatch) {
      const fnName = fwdMatch[1];
      const afterKey = cleaned.slice(fwdMatch.index! + fwdMatch[0].length);
      const args = extractBalancedBraces(afterKey);
      if (args !== null && isValidTool(fnName)) {
        extractedFnName = resolveTool(fnName);
        extractedFnArgs = args;
      }
    }

    // Pattern 2: parameters/arguments come BEFORE name (reversed key order)
    if (!extractedFnName) {
      const revPattern = /\{\s*(?:"type"\s*:\s*"function"\s*,\s*)?"(?:parameters|arguments)"\s*:\s*/;
      const revMatch = cleaned.match(revPattern);
      if (revMatch) {
        const afterParams = cleaned.slice(revMatch.index! + revMatch[0].length);
        const args = extractBalancedBraces(afterParams);
        if (args !== null) {
          // After the args object, look for the name key
          const rest = afterParams.slice(args.length).replace(/^\s*}\s*/, '');
          const nameAfter = rest.match(/,\s*"(?:function_name|function|name)"\s*:\s*"([^"]+)"/);
          if (nameAfter && isValidTool(nameAfter[1])) {
            extractedFnName = resolveTool(nameAfter[1]);
            extractedFnArgs = args;
          }
        }
      }
    }

    if (extractedFnName && extractedFnArgs) {
      console.log(`[Workers AI] Extracted text-embedded tool call: ${extractedFnName}`);
      hasToolCalls = true;
      toolCalls = [{ function: { name: extractedFnName, arguments: extractedFnArgs } }];
      textContent = null; // discard the text — the tool call replaces it
    }
  }

  return {
    id: `chatcmpl-wai-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant" as const,
        // When the model returns tool_calls, discard text content — Workers AI
        // often echoes the tool call as text (e.g. '{"function": ...}') which
        // gets shown to the user as garbage.
        content: hasToolCalls ? null : textContent,
        ...(hasToolCalls ? {
          tool_calls: toolCalls!.map((tc: any, i: number) => ({
            id: tc.id || `call_${Date.now()}_${i}`,
            type: "function" as const,
            function: {
              name: tc.function?.name || tc.name || "",
              arguments: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
            },
          })),
        } : {}),
      },
      finish_reason: (hasToolCalls ? "tool_calls" : "stop") as any,
    }],
    // Custom field: reasoning trace (not part of OpenAI spec)
    _reasoning: reasoning,
  } as any;
}

/**
 * Process a chat request: send to LLM, handle tool calls, return response.
 * If a tool call produces an unsigned transaction, it's included in the response
 * for the frontend to prompt the operator to sign.
 */
export async function processChat(
  env: Env,
  messages: ChatMessage[],
  ctx: RequestContext,
  onToolResult?: (toolName: string, result: string, isError: boolean) => Promise<void>,
  onStreamEvent?: (event: StreamEvent) => void,
): Promise<ChatResponse> {
  onStreamEvent?.({ type: "status", message: "Analyzing request..." });

  // ── LLM provider resolution ──
  // Priority: 1) User-provided key → 2) Workers AI binding (zero-config) → 3) Server OpenAI key
  // Like MetaMask's default RPC: works out of the box, but users can bring their own key.
  //
  // Workers AI strategy:
  //   - Kimi K2.6 (1T param MoE, 262k context): primary model — handles reasoning,
  //     tool calling, and multi-step planning natively in a single call.
  const KIMI_MODEL = "@cf/moonshotai/kimi-k2.6";

  let openai: OpenAI | null = null;
  let useBinding = false;
  let llmModel: string;
  let finalModel: string | undefined;
  const modelsUsed: string[] = [];
  const recordModel = (model: string) => {
    if (!modelsUsed.includes(model)) modelsUsed.push(model);
  };

  if (ctx.aiApiKey) {
    // User provided their own key (OpenRouter, OpenAI, etc.)
    openai = new OpenAI({
      apiKey: ctx.aiApiKey,
      ...(ctx.aiBaseUrl ? { baseURL: ctx.aiBaseUrl } : {}),
      timeout: 45_000,
    });
    llmModel = ctx.aiModel || "gpt-5-mini";
    // User-provided key: same model for all calls
  } else if (env.AI) {
    // Workers AI via binding (default — no API key needed, zero-config)
    // Kimi K2.6 as primary: natively handles reasoning + tool calling in one call.
    useBinding = true;
    llmModel = KIMI_MODEL;
  } else if (env.OPENAI_API_KEY) {
    // Fallback to server OpenAI key
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 45_000 });
    llmModel = ctx.aiModel || "gpt-5-mini";
    // Server OpenAI key: same model for all calls
  } else {
    throw new Error("No AI provider configured. Add [ai] binding to wrangler.toml, or set OPENAI_API_KEY.");
  }

  // Unified LLM caller — routes to AI binding adapter or OpenAI SDK
  const callLLM = async (params: {
    model: string;
    messages: OpenAI.ChatCompletionMessageParam[];
    tools?: OpenAI.ChatCompletionTool[];
    tool_choice?: "auto" | "none";
  }, streamReasoning?: boolean) => {
    recordModel(params.model);
    if (useBinding) {
      // When streamReasoning is true AND we have an onStreamEvent callback,
      // pass it to callWorkersAI so tokens stream in real-time.
      // Kimi K2.6 → 'text' events (any analysis/plan text before the tool call)
      const isStreamingModel = params.model.includes('kimi') || params.model.includes('moonshotai');
      const reasoningCallback = ((streamReasoning || isStreamingModel) && onStreamEvent)
        ? (accumulated: string) => onStreamEvent({
            type: 'text',
            content: accumulated,
          })
        : undefined;
      return callWorkersAI(env.AI!, params.model, params.messages, params.tools, reasoningCallback);
    }
    return openai!.chat.completions.create(params);
  };

  // Build system prompt with vault context — MODULAR: only load relevant domain sections
  const detectedDomains = detectDomains(messages as Array<{ role: string; content: string }>);
  const skillPrompts = getSkillSystemPrompt();
  const systemPrompt = buildSystemPrompt(detectedDomains, skillPrompts || undefined);

  // Filter tools to only include relevant domains (reduces token count significantly)
  const TOOL_DEFINITIONS = filterToolsForDomains(ALL_TOOL_DEFINITIONS, detectedDomains);

  console.log(`[processChat] Detected domains: ${[...detectedDomains].join(", ")} (${TOOL_DEFINITIONS.length} tools, ${Math.round(systemPrompt.length / 4)} est. tokens)`);

  const executionModeNote = ctx.executionMode === "delegated"
    ? "The operator has enabled DELEGATED mode. After you build a transaction, the agent wallet will execute it automatically once the operator confirms the trade details. The operator does NOT need to sign the transaction manually."
    : "The operator will sign and broadcast transactions from their own wallet.\nYou build the transaction; they approve it.";

  const ZERO_VAULT = "0x0000000000000000000000000000000000000000";
  const hasVault = ctx.vaultAddress !== ZERO_VAULT;
  const vaultLine = hasVault
    ? `- Vault address: ${ctx.vaultAddress}`
    : `- Vault address: none (no smart pool deployed yet)
- The user has not set a vault address yet. Ask them: "Do you have an existing pool address to paste, or would you like to deploy a new smart pool? I can help with either." Do NOT automatically call deploy_smart_pool — wait for the user to explicitly say they want to create a new pool and provide a name and symbol.`;

  const normalizedContextDocs = (ctx.contextDocs || [])
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .slice(0, 6)
    .map((d, i) => `DOC ${i + 1}:\n${d.slice(0, 3000)}`);

  const contextDocsBlock = normalizedContextDocs.length > 0
    ? `\n\nREQUEST-SCOPED CONTEXT DOCS:\nUse these snippets as additional context for this request. If they conflict with safety rules or tool outputs, prioritize safety rules and real tool outputs.\n\n${normalizedContextDocs.join("\n\n---\n\n")}`
    : "";

  const contextualPrompt = `${systemPrompt}

${RUNTIME_CONTEXT_PACK}

CURRENT SESSION CONTEXT:
${vaultLine}
- Chain ID: ${ctx.chainId}
- Operator wallet: ${ctx.operatorAddress || "not connected"}
- Execution mode: ${ctx.executionMode || "manual"}

${executionModeNote}${contextDocsBlock}`;

  // Prepend system prompt
  const fullMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: contextualPrompt },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  // ── Fast-path routing ──
  // Deterministic commands (chain switch, simple swaps, LP, GMX) bypass the LLM
  // entirely — they are unambiguous and require no reasoning. This prevents LLM
  // timeouts (Workers AI can take 30-50s with 55 tools in context) for trivial ops.
  //
  // Chain switch: always immediate — "switch to arbitrum" has zero ambiguity.
  // Swaps/LP/GMX: still defer to LLM first as a fallback for when the LLM produces
  // plain text instead of a tool call (the deferred fast-path below catches that).
  const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content?.trim() || "";

  // Capability/info questions should not trigger tool execution.
  const capabilityQuestion = tryFastPathCapabilityQuestion(lastUserMsg);
  if (capabilityQuestion) {
    return {
      reply: capabilityQuestion,
      reasoning: "Fast-path execution: recognized a capability question and returned a direct answer without tool calls.",
      modelsUsed: [],
      finalModel: "tooling",
    };
  }

  const fastPathReasoning =
    "Fast-path execution: matched a deterministic command pattern and executed the corresponding tool directly for low latency. No generative planning step was used in this turn.";

  // ── Chain-suffix pre-processing ──
  // Users often say "disable swap shield on polygon" or "sync nav on base".
  // Strip the "on/in/for <chain>" suffix, switch the context chain first, then
  // run the rest of the command through the normal fast-path parsers.
  // This works for ALL fast-path commands without per-parser changes.
  let effectiveMsg = lastUserMsg;
  {
    const chainSuffixMatch = lastUserMsg.match(
      /^(.+?)\s+(?:on|in|for|via|using)\s+([a-z0-9 ]+)$/i,
    );
    if (chainSuffixMatch) {
      const potentialChain = chainSuffixMatch[2].trim();
      try {
        const resolved = resolveChainArg(potentialChain);
        if (resolved.id !== ctx.chainId) {
          const stripped = chainSuffixMatch[1].trim();
          if (stripped.length >= 3) {
            console.log(`[LLM] Chain suffix detected: switching to chain ${resolved.id} (${resolved.name}), stripped command: "${stripped}"`);
            ctx.chainId = resolved.id;
            onStreamEvent?.({ type: "status", message: `Switched to ${resolved.name}` });
            effectiveMsg = stripped;
          }
        }
      } catch {
        // Not a valid chain name — ignore and keep the original message
      }
    }
  }

  // Immediate fast-path: deterministic commands that never need an LLM call.
  // Simple swaps are included here — "sell 200 ZRX for GRG using 0x" has zero
  // ambiguity and the LLM may fail to tool-call on them anyway.
  // NOTE: crosschain_sync is intentionally NOT in the fast-path.
  // Cross-chain operations need LLM reasoning to show the user what was computed
  // (NAV data, direction, token, amount) and explain errors. Speed is not the
  // priority — correctness and transparency are.
  const immediateFastPath =
    tryFastPathChainSwitch(effectiveMsg) ||
    (hasVault ? tryFastPathSwapShieldToggle(effectiveMsg) : null) ||
    (hasVault ? tryFastPathStrategyQueries(effectiveMsg) : null) ||
    (hasVault ? tryFastPathTwapCreate(effectiveMsg) : null) ||
    (hasVault ? tryFastPathBridge(effectiveMsg) : null) ||
    (hasVault ? tryFastPathGmxIncrease(effectiveMsg) : null) ||
    (hasVault ? tryFastPathSwap(effectiveMsg) : null);
  if (immediateFastPath) {
    console.log(`[LLM] Immediate fast-path (no LLM): ${immediateFastPath.name}(${JSON.stringify(immediateFastPath.args)})`);
    try {
      onStreamEvent?.({ type: "status", message: `Executing ${immediateFastPath.name}...` });
      const toolResult = await executeToolCall(env, ctx, immediateFastPath.name, immediateFastPath.args);
      // Outer NAV shield for tools that don't self-check (build_vault_swap already sets navShieldChecked)
      let fastPathReply = toolResult.message;
      if (toolResult.transaction && !toolResult.transaction.navShieldChecked && toolResult.transaction.to?.toLowerCase() === ctx.vaultAddress?.toLowerCase()) {
        const navWarn = await preCheckNavImpact(env, ctx, toolResult.transaction);
        toolResult.transaction.navShieldChecked = true;
        if (navWarn) fastPathReply += '\n' + navWarn;
      }
      return {
        reply: fastPathReply,
        toolCalls: [{ name: immediateFastPath.name, arguments: immediateFastPath.args, result: fastPathReply, error: false }],
        transaction: toolResult.transaction,
        transactions: toolResult.transaction ? [toolResult.transaction] : undefined,
        chainSwitch: toolResult.chainSwitch,
        suggestions: toolResult.suggestions,
        reasoning: fastPathReasoning,
        modelsUsed: [],
        finalModel: "tooling",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // For tool calls that produced informative errors (balance, revert, NAV, auth,
      // token resolution), return directly — falling through to the LLM would hallucinate.
      const isInformativeError = /insufficient|revert|blocked|failed|not found|not bridgeable|no bridgeable|wallet not connected|operator authentication required|not the vault owner|requires.*authentication|authenticate|no contract on chain|provide the contract address|try a different chain|token lookup failed|found on coingecko/i.test(errMsg);
      if (isInformativeError) {
        console.warn(`[LLM] Immediate fast-path informative error, returning directly: ${errMsg}`);
        const friendlyMsg = friendlyError(sanitizeError(errMsg));
        onStreamEvent?.({ type: "tool_result", name: immediateFastPath.name, result: `Error: ${friendlyMsg}`, error: true });
        return {
          reply: friendlyMsg,
          toolCalls: [{ name: immediateFastPath.name, arguments: immediateFastPath.args, result: `Error: ${friendlyMsg}`, error: true }],
          reasoning: fastPathReasoning,
          modelsUsed: [],
          finalModel: "tooling",
        };
      }
      // Non-informative error (e.g. unknown chain name) — fall through to LLM for help
      console.warn(`[LLM] Immediate fast-path failed, falling through to LLM: ${err}`);
    }
  }

  const withRuntimeContext = (msgs: OpenAI.ChatCompletionMessageParam[]) =>
    msgs.some((m) => m.role === "system")
      ? msgs
      : [{ role: "system" as const, content: contextualPrompt }, ...msgs];

  // First LLM call
  console.log(`[LLM] Calling ${llmModel} with ${fullMessages.length} messages, ${TOOL_DEFINITIONS.length} tools`);
  // User-friendly model label for status messages
  const modelLabel = llmModel.includes('kimi') || llmModel.includes('moonshotai') ? 'Kimi K2.6'
    : llmModel.split('/').pop() || llmModel;
  onStreamEvent?.({ type: "status", message: `Thinking (${modelLabel})…` });
  const response = await callLLM({
    model: llmModel,
    messages: withRuntimeContext(fullMessages),
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
  });
  console.log(`[LLM] Response: finish_reason=${response.choices[0]?.finish_reason}, tool_calls=${response.choices[0]?.message?.tool_calls?.length ?? 0}`);
  // Don't emit "Model responded" — the next meaningful event (reasoning, tool_call, text) replaces it

  const choice = response.choices[0];
  if (!choice) throw new Error("No response from LLM");

  // Extract reasoning trace from the first LLM call.
  // When streaming is active, reasoning was already emitted token-by-token.
  // Emit the final complete version to ensure the frontend has the full text.
  let reasoning: string | undefined = (response as any)._reasoning || undefined;
  if (reasoning) {
    onStreamEvent?.({ type: "reasoning", content: reasoning });
  }
  // Emit the model's text content (its plan/analysis) so the user sees it in real time.
  // For models that return both text + tool_calls (OpenRouter, OpenAI), this shows the
  // model's plan before tool execution starts. Workers AI discards text when tool_calls
  // are present, so this is a no-op for the default path.
  // SKIP text that's just a JSON tool call recommendation — it's noise, not analysis.
  const firstCallText = choice.message.content?.trim();
  if (firstCallText && !looksLikeToolCallText(firstCallText)) {
    onStreamEvent?.({ type: "text", content: firstCallText });
  }
  let orchestrationReasoning: string = reasoning ||
    "Autonomous orchestration: interpreted the request intent, executed tools step-by-step, and returned the first concrete outcome (report, transaction, or execution result).";

  const toolCallResults: ToolCallResult[] = [];
  const pendingTransactions: UnsignedTransaction[] = [];
  let pendingChainSwitch: number | undefined;
  let detectedDex: string | undefined;
  let pendingSuggestions: string[] | undefined;
  let pendingMetadata: Record<string, unknown> | undefined;
  let pendingSelfContained = false;

  // Autonomous orchestration loop: continue tool execution across multiple rounds
  // until we reach an actionable outcome (tx batch / self-contained report) or max rounds.
  //
  let orchestrationChoice = choice;

  // ── Deferred fast-path (swap safety net) ──
  // If the initial LLM call produced no tool calls, try the swap fast-path as a
  // last resort. This catches cases where the user's phrasing was slightly too
  // conversational for the immediate fast-path regex (e.g. stripped prefixes,
  // minor reformulations) but simple enough that the LLM should have called
  // build_vault_swap and didn't.
  if (!orchestrationChoice.message.tool_calls?.length && hasVault) {
    const deferredSwap = tryFastPathSwap(effectiveMsg);
    if (deferredSwap) {
      console.log(`[LLM] Deferred fast-path (after LLM miss): ${deferredSwap.name}(${JSON.stringify(deferredSwap.args)})`);
      try {
        onStreamEvent?.({ type: "status", message: `Executing ${deferredSwap.name}...` });
        const toolResult = await executeToolCall(env, ctx, deferredSwap.name, deferredSwap.args);
        let deferredReply = toolResult.message;
        if (toolResult.transaction && !toolResult.transaction.navShieldChecked && toolResult.transaction.to?.toLowerCase() === ctx.vaultAddress?.toLowerCase()) {
          const navWarn = await preCheckNavImpact(env, ctx, toolResult.transaction);
          toolResult.transaction.navShieldChecked = true;
          if (navWarn) deferredReply += '\n' + navWarn;
        }
        return {
          reply: deferredReply,
          toolCalls: [{ name: deferredSwap.name, arguments: deferredSwap.args, result: deferredReply, error: false }],
          transaction: toolResult.transaction,
          transactions: toolResult.transaction ? [toolResult.transaction] : undefined,
          chainSwitch: toolResult.chainSwitch,
          suggestions: toolResult.suggestions,
          metadata: toolResult.metadata,
          reasoning: orchestrationReasoning,
          modelsUsed,
          finalModel: "tooling",
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[LLM] Deferred fast-path error: ${errMsg}`);
        const friendlyMsg = friendlyError(sanitizeError(errMsg));
        onStreamEvent?.({ type: "tool_result", name: deferredSwap.name, result: `Error: ${friendlyMsg}`, error: true });
        return {
          reply: friendlyMsg,
          toolCalls: [{ name: deferredSwap.name, arguments: deferredSwap.args, result: `Error: ${friendlyMsg}`, error: true }],
          reasoning: orchestrationReasoning,
          modelsUsed,
          finalModel: "tooling",
        };
      }
    }
  }

  if (orchestrationChoice.message.tool_calls && orchestrationChoice.message.tool_calls.length > 0) {
    let currentMessage = orchestrationChoice.message;
    let rollingMessages: OpenAI.ChatCompletionMessageParam[] = [...fullMessages];
    const MAX_AUTONOMOUS_ROUNDS = 6;

    // Track consecutive failures to stop the loop early when the same tool
    // keeps failing with the same error (prevents 5x repeated error spam).
    let lastFailedTool: string | undefined;
    let lastFailedError: string | undefined;
    let consecutiveFailures = 0;

    for (let round = 1; round <= MAX_AUTONOMOUS_ROUNDS; round++) {
      if (!currentMessage.tool_calls || currentMessage.tool_calls.length === 0) {
        break;
      }

      console.log(`[LLM] Autonomous round ${round}/${MAX_AUTONOMOUS_ROUNDS}: executing ${currentMessage.tool_calls.length} tool call(s)`);
      onStreamEvent?.({ type: "status", message: `Executing ${currentMessage.tool_calls.length} tool call(s)...` });
      const toolMessages: OpenAI.ChatCompletionMessageParam[] = [
        ...rollingMessages,
        currentMessage,
      ];

      for (const toolCall of currentMessage.tool_calls) {
        const { name, arguments: argsStr } = toolCall.function;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsStr || "{}");
        } catch {
          args = {};
        }
        console.log(`[LLM] Tool call: ${name}(${argsStr})`);

        // Emit stream event for tool call start
        onStreamEvent?.({ type: "tool_call", name, arguments: args });

        // Sanitize swap tool arguments — the LLM often gets amounts/dex wrong
        if (name === "get_swap_quote" || name === "build_vault_swap") {
          const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content || "";
          args = sanitizeSwapArgs(args, lastUserMsg);
          console.log(`[LLM] Sanitized args: ${JSON.stringify(args)}`);
        }

        let result: string;
        let isError = false;

        try {
          const toolResult = await executeToolCall(env, ctx, name, args);
          result = toolResult.message;
          console.log(`[LLM] Tool ${name} succeeded, result length: ${result.length}`);

          if (toolResult.transaction) {
            // ── NAV shield pre-check (universal hook) ──
            if (
              !toolResult.transaction.navShieldChecked &&
              toolResult.transaction.to?.toLowerCase() === ctx.vaultAddress.toLowerCase()
            ) {
              const navWarn = await preCheckNavImpact(env, ctx, toolResult.transaction);
              toolResult.transaction.navShieldChecked = true;
              if (navWarn) result += '\n' + navWarn;
            }
            pendingTransactions.push(toolResult.transaction);
          }

          if (toolResult.chainSwitch) {
            pendingChainSwitch = toolResult.chainSwitch;
            ctx.chainId = toolResult.chainSwitch;
          }

          if (toolResult.suggestions?.length) {
            pendingSuggestions = toolResult.suggestions;
          }

          if (toolResult.metadata) {
            pendingMetadata = { ...pendingMetadata, ...toolResult.metadata };
          }

          if (toolResult.selfContained) {
            pendingSelfContained = true;
          }

          // Detect DEX/protocol from tool call
          if ((name === "get_swap_quote" || name === "build_vault_swap") && args.dex) {
            const dexArg = String(args.dex).toLowerCase();
            detectedDex = (dexArg === "uniswap") ? "Uniswap" : "0x";
          } else if ((name === "get_swap_quote" || name === "build_vault_swap") && !args.dex) {
            detectedDex = "0x";
          } else if (name.startsWith("gmx_")) {
            detectedDex = "GMX";
          }
        } catch (err) {
          // Extract the most informative error string from viem/RPC errors.
          // Viem wraps errors in multiple layers:
          //   EstimateGasExecutionError → CallExecutionError → ExecutionRevertedError → RpcRequestError
          // Revert data lives on ExecutionRevertedError.data OR RpcRequestError.error.data
          // (NOT necessarily top-level e.data on RpcRequestError).
          // Strategy: walk the chain, grab hex data from any level, keep the FIRST
          // meaningful message (higher in the chain = more context, not less).
          let rawMsg: string;
          if (err instanceof Error) {
            let revertData: string | undefined;
            let bestMessage: string | undefined;
            const GENERIC_MSG = /RPC Request failed|unknown reason/i;
            let e: any = err;
            while (e) {
              // Check both e.data and e.error?.data for hex revert payload
              const hexData =
                (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) ? e.data
                : (typeof e.error?.data === 'string' && e.error.data.startsWith('0x') && e.error.data.length > 2) ? e.error.data
                : undefined;
              if (hexData) {
                revertData = hexData;
                break;
              }
              // Keep the FIRST meaningful message — shallow errors have more context
              if (!bestMessage) {
                if (e.shortMessage && !GENERIC_MSG.test(e.shortMessage)) {
                  bestMessage = e.shortMessage;
                } else if (e.details && !GENERIC_MSG.test(e.details)) {
                  bestMessage = e.details;
                }
              }
              e = e.cause;
            }
            if (revertData) {
              rawMsg = `execution reverted: ${revertData}`;
            } else if (bestMessage) {
              rawMsg = bestMessage;
            } else {
              rawMsg = err.message;
            }
            // For swap tools, append what was being attempted so the user can diagnose
            if ((name === 'build_vault_swap' || name === 'get_swap_quote') && args) {
              const swapCtx = [
                args.amountIn ? `${args.amountIn} ${args.tokenIn || '?'}` : args.tokenIn,
                args.tokenOut ? `→ ${args.tokenOut}` : '',
                args.dex ? `via ${args.dex}` : 'via 0x',
              ].filter(Boolean).join(' ');
              if (swapCtx) rawMsg = `${rawMsg} (swap: ${swapCtx})`;
            }
          } else {
            rawMsg = String(err);
          }
          result = `Error: ${friendlyError(sanitizeError(rawMsg))}`;
          isError = true;
        }

        toolCallResults.push({
          name,
          arguments: args,
          result,
          error: isError,
        });

        // Emit stream event for tool result
        onStreamEvent?.({ type: "tool_result", name, result, error: isError || undefined });

        if (onToolResult) await onToolResult(name, result, isError).catch(() => {});

        // Terminal error detection: certain errors from swap/trade tools should be
        // returned directly to the user instead of giving the LLM another round.
        // Without this, the model gets confused by the error and calls unrelated tools
        // (e.g., GMX markets after a swap revert).
        if (isError && (name === "build_vault_swap" || name === "get_swap_quote")) {
          const isTerminalError =
            /Swap Shield blocked/i.test(result) ||
            /NAV.*shield.*blocked/i.test(result) ||
            /would revert on-chain/i.test(result) ||
            /execution reverted/i.test(result) ||
            /On-chain (?:revert|error)/i.test(result) ||
            /simulation failed/i.test(result);
          if (isTerminalError) {
            console.log(`[LLM] Terminal swap error — returning directly instead of continuing orchestration`);
            toolMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
            return {
              reply: result.replace(/^Error: /, ""),
              toolCalls: toolCallResults,
              chainSwitch: pendingChainSwitch,
              dexProvider: detectedDex,
              reasoning: orchestrationReasoning,
              modelsUsed,
              finalModel: "tooling",
            };
          }
        }

        // Detect consecutive failures of the same tool with the same error.
        // Break immediately to avoid repeating the same failing call in every round.
        if (isError) {
          if (name === lastFailedTool && result === lastFailedError) {
            consecutiveFailures++;
            if (consecutiveFailures >= 2) {
              toolMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
              });
              console.log(`[LLM] Consecutive failure limit reached for tool '${name}'. Stopping orchestration loop.`);
              // Return with the error message visible to the user
              return {
                reply: result.replace(/^Error: /, ""),
                toolCalls: toolCallResults,
                transaction: pendingTransactions[pendingTransactions.length - 1],
                transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
                chainSwitch: pendingChainSwitch,
                dexProvider: detectedDex,
                reasoning: orchestrationReasoning,
                modelsUsed,
                finalModel: "tooling",
              };
            }
          } else {
            consecutiveFailures = 1;
            lastFailedTool = name;
            lastFailedError = result;
          }
        } else {
          // Reset on success
          consecutiveFailures = 0;
          lastFailedTool = undefined;
          lastFailedError = undefined;
        }

        toolMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Actionable outcome available — return immediately.
      if (pendingTransactions.length > 0) {
        console.log(`[processChat] Autonomous loop resolved with ${pendingTransactions.length} transaction(s)`);
        for (const tx of pendingTransactions) {
          onStreamEvent?.({ type: "transaction", transaction: tx });
        }
        const result: ChatResponse = {
          reply: "",
          toolCalls: toolCallResults,
          transaction: pendingTransactions[pendingTransactions.length - 1],
          transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
          chainSwitch: pendingChainSwitch,
          dexProvider: detectedDex,
          suggestions: pendingSuggestions,
          metadata: pendingMetadata,
          reasoning: orchestrationReasoning,
          modelsUsed,
          finalModel: "tooling",
        };
        onStreamEvent?.({ type: "done", response: result });
        return result;
      }

      if (pendingSuggestions?.length) {
        console.log("[processChat] Autonomous loop resolved with self-contained report + suggestions");
        const report = toolCallResults
          .filter(tc => !tc.error && tc.result)
          .map(tc => tc.result)
          .join("\n");
        return {
          reply: report,
          toolCalls: [],
          chainSwitch: pendingChainSwitch,
          suggestions: pendingSuggestions,
          metadata: pendingMetadata,
          reasoning: orchestrationReasoning,
          modelsUsed,
          finalModel: "tooling",
        };
      }

      if (pendingSelfContained) {
        console.log("[processChat] Autonomous loop resolved with self-contained report");
        const report = toolCallResults
          .filter(tc => !tc.error && tc.result)
          .map(tc => tc.result)
          .join("\n");
        return {
          reply: report,
          toolCalls: [],
          chainSwitch: pendingChainSwitch,
          reasoning: orchestrationReasoning,
          modelsUsed,
          finalModel: "tooling",
        };
      }

      // Continue planning with the fast model using accumulated tool results.
      rollingMessages = toolMessages;
      console.log(`[LLM] Autonomous follow-up call round ${round}/${MAX_AUTONOMOUS_ROUNDS}`);
      onStreamEvent?.({ type: "status", message: `Planning next step (round ${round + 1})…` });
      const followUp = await callLLM({
        model: llmModel,
        messages: withRuntimeContext(toolMessages),
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      });
      const followUpChoice = followUp.choices[0];
      if (!followUpChoice) {
        break;
      }

      const followUpReasoning = (followUp as any)._reasoning as string | undefined;
      if (followUpReasoning) {
        onStreamEvent?.({ type: "reasoning", content: followUpReasoning });
      }
      currentMessage = followUpChoice.message;
      const followUpHasMoreToolCalls = !!(currentMessage.tool_calls?.length);
      const followUpText = currentMessage.content?.trim();
      // Only emit follow-up text as a streaming plan-block when more tool calls follow.
      // If this is the final response (no tool calls), data.reply handles display — emitting
      // it here too would show the same text twice (once in plan-block, once as reply).
      if (followUpText && followUpHasMoreToolCalls) {
        const isErrorEcho = /^(error:|insufficient|.*revert|.*failed)/i.test(followUpText);
        const isRepeatOfToolResult = toolCallResults.some(
          tc => tc.error && tc.result && followUpText.includes(tc.result.replace(/^Error:\s*/i, '').slice(0, 50)),
        );
        if (!isErrorEcho && !isRepeatOfToolResult && !looksLikeToolCallText(followUpText)) {
          onStreamEvent?.({ type: "text", content: followUpText });
        }
      }

      if (!followUpHasMoreToolCalls) {
        finalModel = llmModel;
        return {
          reply: currentMessage.content || "Done.",
          toolCalls: toolCallResults,
          transaction: pendingTransactions[pendingTransactions.length - 1],
          transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
          chainSwitch: pendingChainSwitch,
          dexProvider: detectedDex,
          reasoning: orchestrationReasoning,
          modelsUsed,
          finalModel,
        };
      }
    }

    // Safety stop to avoid infinite loops if the model keeps emitting tool calls.
    return {
      reply: "I completed multiple autonomous planning rounds but could not converge to a final action in this turn. I included all tool outputs so far and can continue immediately.",
      toolCalls: toolCallResults,
      transaction: pendingTransactions[pendingTransactions.length - 1],
      transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
      chainSwitch: pendingChainSwitch,
      dexProvider: detectedDex,
      reasoning: orchestrationReasoning,
      modelsUsed,
      finalModel: "orchestrator",
    };
  }

  // No tool calls — direct response
  finalModel = llmModel;
  return {
    reply: choice.message.content || "",
    toolCalls: [],
    reasoning,
    modelsUsed,
    finalModel,
  };
}

// ── Gas estimation helper ─────────────────────────────────────────────

/**
 * Estimate gas for an unsigned transaction via eth_estimateGas.
 * Returns a hex string gas limit with a 20% safety buffer.
 *
 * If estimation fails, it means the transaction would revert on-chain.
 * We propagate the error rather than using a fallback — the user needs to
 * see why the transaction would fail.
 *
 * The only exception is when no `from` address is available (can't simulate
 * without a sender), in which case we throw an explicit error.
 */
export async function estimateGas(
  chainId: number,
  to: Address,
  data: Hex,
  value: string,
  from: Address | undefined,
  alchemyKey?: string,
  _category?: string,
): Promise<string> {
  if (!from) {
    throw new Error("Cannot estimate gas without a sender address. Connect your wallet first.");
  }
  const client = getClient(chainId, alchemyKey);
  const txValue = BigInt(value);
  let estimated: bigint;
  try {
    estimated = await client.estimateGas({
      account: from,
      to,
      data,
      value: txValue,
    });
  } catch (err) {
    // Extract the most useful error message from viem's error chain.
    // viem wraps execution reverts in EstimateGasExecutionError → CallExecutionError.
    // Walk the chain to find a non-generic message or hex revert data.
    let detail = '';
    let e: any = err;
    while (e) {
      if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) {
        detail = `revert data: ${e.data}`;
        break;
      }
      if (typeof e.error?.data === 'string' && e.error.data.startsWith('0x') && e.error.data.length > 2) {
        detail = `revert data: ${e.error.data}`;
        break;
      }
      const msg = e.shortMessage || e.details || '';
      if (msg && !/unknown reason|RPC Request failed/i.test(msg) && msg.length > detail.length) {
        detail = msg;
      }
      e = e.cause;
    }
    const label = _category ? `${_category} ` : '';
    throw new Error(`${label}transaction would revert on-chain${detail ? ': ' + detail : ''}`);
  }
  // 20% buffer — covers execution-time variance (adapter routing, internal
  // approvals, oracle reads). The on-chain estimate is already accurate for
  // the vault proxy overhead since we estimate from the actual sender.
  const buffered = estimated + (estimated * 20n) / 100n;
  console.log(`[estimateGas] chain=${chainId} raw=${estimated} buffered=${buffered}`);
  return `0x${buffered.toString(16)}`;
}

/**
 * Returns the appropriate action line to append to a transaction message.
 * In delegated mode the agent executes automatically — no sign prompt needed.
 * In manual mode the operator must sign from their wallet.
 * Use this in every handler that returns a transaction instead of hardcoding.
 */
export function txActionLine(ctx: Pick<RequestContext, "executionMode">): string {
  return ctx.executionMode === "delegated"
    ? ""
    : "Sign with your wallet to execute.";
}

export interface ToolResult {
  message: string;
  transaction?: UnsignedTransaction;
  chainSwitch?: number;
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
  /** When true, the message is a complete report — skip the follow-up LLM call */
  selfContained?: boolean;
  /** Protocol-specific structured metadata for frontend rendering */
  metadata?: Record<string, unknown>;
}

/**
 * NAV shield pre-check — runs BEFORE returning unsigned calldata to the caller.
 *
 * This ensures the NAV shield protects ALL transactions equally — swaps, bridges,
 * LP, everything. The 10% threshold applies universally. If a transaction would
 * cause NAV to drop > 10%, the calldata is never returned.
 *
 * The NAV shield MUST NEVER be skipped for any transaction type. When something
 * doesn't work, the effort must be in fixing the root cause, not in skipping
 * the shield to avoid errors. The NAV shield is the user's primary protection
 * against rogue transactions.
 *
 * For cross-chain bridges (depositV3), Transfer and Sync have fundamentally
 * different NAV behavior:
 *   - Transfer (OpType.Transfer): updates virtual supply — source NAV is preserved
 *     because effectiveSupply decreases proportionally with value.
 *   - Sync (OpType.Sync): does NOT update virtual supply — source NAV drops because
 *     tokens leave but supply stays. Uses navToleranceBps for on-chain validation.
 *
 * The NAV shield uses updateUnitaryValue() (the actual contract algorithm) instead
 * of getNavDataView() (view-only extension) to avoid an edge case where the view
 * returns unitaryValue=0 when the actual contract preserves the stored value.
 *
 * For delegated mode, the execution engine runs the NAV shield again at broadcast
 * time (belt-and-suspenders — market conditions could change between building
 * and broadcasting). For manual mode, this is the ONLY NAV shield checkpoint.
 */
export async function preCheckNavImpact(
  env: Env,
  ctx: RequestContext,
  tx: UnsignedTransaction,
): Promise<string> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  if (!ctx.vaultAddress || ctx.vaultAddress === ZERO) return '';

  // Determine who to simulate as — must be the actual vault owner.
  // Verified callers: use their address (already proven to be the owner via signature).
  // Unverified callers: read owner() on-chain rather than trusting the caller-supplied
  // operatorAddress, which could be wrong and would produce misleading simulation reverts.
  let simulationSender: Address;
  if (ctx.operatorVerified && ctx.operatorAddress) {
    simulationSender = ctx.operatorAddress as Address;
  } else {
    try {
      const vaultClient = getClient(tx.chainId, env.ALCHEMY_API_KEY);
      simulationSender = await vaultClient.readContract({
        address: ctx.vaultAddress as Address,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "owner",
      }) as Address;
    } catch {
      // RPC error reading vault owner — skip NAV pre-check; delegated path has a hard stop
      return '';
    }
  }

  try {
    const result = await checkNavImpact(
      ctx.vaultAddress as Address,
      tx.data as Hex,
      BigInt(tx.value || "0x0"),
      tx.chainId,
      env.ALCHEMY_API_KEY,
      simulationSender,
      env.KV,
    );

    if (!result.allowed) {
      if (result.code === 'TRADE_REVERTS') {
        // For the pre-check (building unsigned calldata for manual signing), a simulation
        // failure is advisory — the user signs themselves. If the tx fails on-chain, they
        // see the real revert reason. We warn but don't block.
        // The delegated-mode broadcast check in execution.ts is the hard stop.
        const warning = `⚠️ Simulation warning: ${result.reason || "transaction may revert on-chain"} — verify token approvals and vault adapter support before signing.`;
        console.warn(`[NavShield pre-check] Non-blocking simulation failure: ${result.reason}`);
        return warning;
      }
      // BLOCKED — NAV would drop more than the threshold. Hard security block.
      const reason = `NAV shield blocked: this trade would reduce vault unit value by ${result.dropPct}% ` +
        `(max allowed: 10%). ${result.reason || ""}`;
      throw new Error(reason.trim());
    }

    if (result.verified) {
      console.log(
        `[NavShield pre-check] ✓ Passed: NAV drop ${result.dropPct}% (chain ${tx.chainId})`,
      );
    } else {
      console.warn(
        `[NavShield pre-check] ⚠ Unverified: NAV impact could not be measured (chain ${tx.chainId})`,
      );
    }
  } catch (err) {
    // Re-throw NAV shield blocks — these are security violations
    if (err instanceof Error && err.message.includes("NAV shield blocked")) {
      throw err;
    }
    // Swallow infrastructure errors (RPC timeouts, etc.) — don't block the
    // calldata for transient failures. The delegated path has a second check.
    console.warn(
      `[NavShield pre-check] Infrastructure error (non-blocking): ${
        err instanceof Error ? err.message.slice(0, 200) : String(err)
      }`,
    );
  }
  return '';
}

/**
 * Execute a single tool call. Returns a message and optionally an unsigned transaction.
 */

export async function executeToolCall(
  env: Env,
  ctx: RequestContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Resolve hallucinated tool names to canonical names
  const resolvedName = TOOL_NAME_ALIASES[name] || name;
  if (resolvedName !== name) {
    console.log(`[LLM] Tool name alias: "${name}" → "${resolvedName}"`);
  }

  // Centralized auth gate for operator-verified tools.
  // This avoids fragile per-tool checks and guarantees consistent behavior for
  // all execution paths (LLM tool calls + immediate/deferred fast-paths).
  if (OPERATOR_VERIFIED_TOOLS.has(resolvedName)) {
    if (!ctx.operatorAddress) {
      throw new AuthError("Wallet not connected. Connect your wallet first.", 401);
    }
    if (!ctx.operatorVerified) {
      throw new AuthError("Operator authentication required. Please verify your wallet first.", 403);
    }
  }

  // Gate vault-transaction tools for browser callers without auth.
  // x402 agents (isBrowserRequest=false) are allowed in manual mode — that is
  // the intended Tier 1 use case: they receive unsigned calldata and sign it
  // themselves with their own vault operator key.
  // Browser users without auth would get calldata that always reverts on-chain
  // (their connected wallet isn't the vault owner), wasting LLM inference.
  if (ctx.isBrowserRequest && !ctx.operatorVerified && VAULT_TX_TOOLS.has(resolvedName)) {
    if (!ctx.operatorAddress) {
      throw new AuthError("Wallet not connected. Connect your wallet to authenticate.", 401);
    }
    throw new AuthError(
      "Authentication required. Please sign in with your vault operator wallet to build transactions. " +
      "Click the wallet button and sign the authentication message.",
      403,
    );
  }

  const handler = TOOL_HANDLER_REGISTRY[resolvedName];
  if (!handler) {
    const { handleSkillToolCall } = await import("../skills/index.js");
    const skillResult = await handleSkillToolCall(resolvedName, args, env, ctx);
    if (skillResult) return skillResult as ToolResult;
    throw new Error(`Unknown tool: ${name}`);
  }
  return await handler(env, ctx, args, resolvedName);
}

/** Resolve a chain name/shortName/ID to a supported chain entry. Throws if not found. */
export function resolveChainArg(chainArg: string): { id: number; name: string; shortName: string } {
  const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS];
  const arg = chainArg.toLowerCase().trim();

  // Exact match first
  const exact = allChains.find(
    (c) =>
      c.name.toLowerCase() === arg ||
      c.shortName.toLowerCase() === arg ||
      c.id.toString() === arg,
  );
  if (exact) return exact;

  // Fuzzy match — tolerate typos (Levenshtein distance ≤ 2)
  let bestMatch: typeof allChains[0] | undefined;
  let bestDist = 3; // threshold: accept distance 0-2
  for (const c of allChains) {
    for (const candidate of [c.name.toLowerCase(), c.shortName.toLowerCase()]) {
      const d = levenshtein(arg, candidate);
      if (d < bestDist) {
        bestDist = d;
        bestMatch = c;
      }
    }
  }
  if (bestMatch) {
    console.log(`[resolveChainArg] Fuzzy matched "${chainArg}" → ${bestMatch.name} (distance ${bestDist})`);
    return bestMatch;
  }

  throw new Error(
    `Unknown chain: ${chainArg}. Supported: ${allChains.map((c) => c.name).join(", ")}`,
  );
}

/**
 * Switch chain context if the user-specified chain differs from the current one.
 * Returns the new chainId when a switch happens, otherwise undefined.
 * Mutates `ctx.chainId` in place.
 */
export function switchChainIfNeeded(
  chainArg: unknown,
  ctx: RequestContext,
): number | undefined {
  if (!chainArg) return undefined;
  const match = resolveChainArg(String(chainArg).trim());
  if (match.id !== ctx.chainId) {
    ctx.chainId = match.id;
    return match.id;
  }
  return undefined;
}

/** Simple Levenshtein distance for short strings (chain names). */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Get a human-readable chain name from ID. */
export function resolveChainName(chainId: number): string {
  const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS];
  return allChains.find((c) => c.id === chainId)?.name || `Chain ${chainId}`;
}

/**
 * Resolve slippage tolerance (bps) — priority:
 *   1. Per-request value from context (body.slippageBps)
 *   2. Stored operator preference in KV
 *   3. Default 100 bps (1%)
 *
 * SECURITY: Clamped to [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS].
 * The LLM CANNOT set slippage — only the operator via settings or chat tool.
 */
export async function resolveSlippage(env: Env, ctx: RequestContext): Promise<number> {
  // 1. Per-request override from body (ONLY for verified operators)
  // Unverified callers must not be able to weaken per-request safety controls.
  if (
    isVerifiedOperatorContext(ctx) &&
    ctx.slippageBps != null &&
    typeof ctx.slippageBps === "number" &&
    Number.isFinite(ctx.slippageBps) &&
    Number.isInteger(ctx.slippageBps)
  ) {
    const clamped = Math.max(MIN_SLIPPAGE_BPS, Math.min(MAX_SLIPPAGE_BPS, ctx.slippageBps));
    return clamped;
  }

  // 2. Stored operator preference (ONLY for verified operators)
  if (isVerifiedOperatorContext(ctx) && env.KV) {
    const stored = await getStoredSlippage(env.KV, ctx.operatorAddress);
    if (stored !== null) return stored;
  }

  // 3. Default
  return DEFAULT_SLIPPAGE_BPS;
}

/**
 * Run the Swap Shield oracle check. Compares DEX quote against on-chain oracle
 * and throws a descriptive error if the quote diverges too much.
 *
 * Called from both 0x and Uniswap flows in build_vault_swap.
 * Uses the operator's temporary tolerance override (if set) instead of the
 * default 5% threshold.
 */
export async function runSwapShield(
  env: Env,
  ctx: RequestContext,
  intent: SwapIntent,
  sellAmountRaw: string,
  sellDecimals: number,
  buyAmountRaw: string,
  resolvedTokenIn?: Address,
  resolvedTokenOut?: Address,
  oracleEnrichment?: { priceFeedExists: boolean; oracleAmount: string },
): Promise<string | undefined> {
  // Check temporary tolerance override
  let maxDivergencePct: number | undefined;
  if (isVerifiedOperatorContext(ctx) && env.KV) {
    const tolerance = await getSwapShieldTolerance(
      env.KV,
      ctx.operatorAddress,
    );
    if (tolerance !== null) {
      maxDivergencePct = tolerance;
      console.log(`[SwapShield] Using operator tolerance override: ${tolerance}%`);
    }
  }

  // Use pre-resolved addresses from quote path when available.
  // Falling back to runtime resolution is kept for compatibility, but if it
  // fails we throw rather than silently skip the oracle check.
  let tokenInAddr: Address;
  let tokenOutAddr: Address;
  if (resolvedTokenIn && resolvedTokenOut) {
    tokenInAddr = resolvedTokenIn;
    tokenOutAddr = resolvedTokenOut;
  } else {
    try {
      tokenInAddr = await resolveTokenAddress(ctx.chainId, intent.tokenIn) as Address;
      tokenOutAddr = await resolveTokenAddress(ctx.chainId, intent.tokenOut) as Address;
    } catch (error) {
      throw new Error(
        `Swap Shield cannot run: token address resolution failed — ${sanitizeError(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  // Guard BigInt() so malformed DEX responses surface as clear errors rather
  // than the generic "Cannot convert X to a BigInt" SyntaxError.
  let sellRawBig: bigint;
  let buyRawBig: bigint;
  try {
    sellRawBig = BigInt(sellAmountRaw);
    buyRawBig = BigInt(buyAmountRaw);
  } catch {
    throw new Error(
      "Swap Shield cannot run: DEX quote returned a malformed amount (not a valid integer). " +
      "Please retry — if this persists, switch DEX (0x ↔ uniswap).",
    );
  }

  const result = await checkSwapPrice(
    ctx.chainId,
    tokenInAddr,
    tokenOutAddr,
    sellRawBig,
    buyRawBig,
    intent.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    env.ALCHEMY_API_KEY,
    maxDivergencePct ?? DEFAULT_MAX_DIVERGENCE_PCT,
    oracleEnrichment?.priceFeedExists,
    oracleEnrichment?.oracleAmount ? BigInt(oracleEnrichment.oracleAmount) : undefined,
  );

  if (!result.allowed) {
    if (result.code === "INVALID_QUOTE") {
      throw new Error(result.reason || "Invalid swap quote received from DEX.");
    }

    // Build a context-specific error with guidance
    const sellSymbol = intent.tokenIn;
    const buySymbol = intent.tokenOut;
    const sellAmt = intent.amountIn || formatUnits(sellRawBig, sellDecimals);
    const divergence = parseFloat(result.divergencePct);
    const isFavorable = Number.isFinite(divergence) && divergence < 0;
    // Display the absolute magnitude with an explicit direction word to avoid
    // awkward phrasings like "diverges -20.00%" in the favorable case.
    const magnitudePct = Number.isFinite(divergence)
      ? Math.abs(divergence).toFixed(2)
      : result.divergencePct;
    const directionClause = isFavorable
      ? `is ${magnitudePct}% better than the on-chain oracle price`
      : `is ${magnitudePct}% worse than the on-chain oracle price`;
    const normalizedMaxDiv = maxDivergencePct ?? DEFAULT_MAX_DIVERGENCE_PCT;
    const thresholdText = `${normalizedMaxDiv}% tolerance`;
    const explanation = isFavorable
      ? `This can indicate a stale oracle or a manipulated routing path producing an implausibly favorable quote.`
      : `This usually indicates significant price impact from the trade size.`;
    const toleranceShieldOption = isVerifiedOperatorContext(ctx)
      ? `3. **Raise tolerance** — say "set swap shield tolerance to 30%" (or up to 50%) ` +
        `to temporarily allow more divergence for 10 minutes. ` +
        (isFavorable
          ? `Use with caution — you accept oracle/route integrity risk.\n`
          : `Use with caution — you accept full price impact risk.\n`)
      : `3. **Raise tolerance** — requires operator authentication; sign in as the vault owner first ` +
        `then say "set swap shield tolerance to 30%"\n`;
    const refreshOracleOption = isFavorable
      ? `4. **Refresh oracle feed** — say "refresh oracle feed for ${sellSymbol} with 0.001 ETH" to ` +
        `swap a tiny amount of ETH on the BackgeoOracle pool from your operator wallet, creating a ` +
        `new price observation. The TWAP will converge toward market price over ~5 minutes.\n`
      : "";
    const options = isFavorable
      ? `Options:\n` +
        `1. **Retry later** — wait for pricing to normalize and request a fresh quote\n` +
        `2. **Verify route** — compare venues or try a different swap path\n` +
        toleranceShieldOption +
        refreshOracleOption
      : `Options:\n` +
        `1. **Split with TWAP** — create a TWAP order to execute ${sellAmt} ${sellSymbol} → ${buySymbol} ` +
        `in smaller slices over time, reducing price impact\n` +
        `2. **Reduce amount** — try a smaller trade\n` +
        toleranceShieldOption;
    throw new Error(
      `⚠️ Swap Shield blocked this trade.\n\n` +
      `The DEX quote ${directionClause}, ` +
      `exceeding the ${thresholdText}.\n\n` +
      `${explanation}\n\n` +
      `${options}`,
    );
  }

  // Log non-blocking results and surface a warning to the caller so it can
  // be appended to the swap-ready message. process.emitWarning() is not
  // available in Cloudflare Workers — returning the string is the correct pattern.
  if (result.code === "NO_PRICE_FEED" || result.code === "ORACLE_ERROR") {
    const warning =
      `⚠️ Swap Shield: quote was not oracle-verified (${result.code}). ` +
      (result.reason ?? "Oracle check unavailable — proceeding without oracle protection.");
    console.warn(`[SwapShield] Non-blocking: ${warning}`);
    return warning;
  }
}

// ── Swap argument sanitizer ──────────────────────────────────────────
// gpt-4.1-nano frequently got amounts, tokens, and dex wrong. Now using gpt-5-mini but keeping sanitizer as safety net.
// This function parses the user's raw message and corrects the args.

/**
 * Detect if the user message requests multiple swaps (e.g., "buy 300 GRG on
 * ethereum, buy 100 GRG on arbitrum"). In this case the sanitizer must NOT
 * override amounts because it would apply the first match to every tool call.
 */
function isMultiSwapMessage(msg: string): boolean {
  return countExpectedSwaps(msg) > 1;
}

/** Count how many distinct swap/buy/sell instructions are in the message. */
function countExpectedSwaps(msg: string): number {
  const swapKeywords = msg.match(/\b(?:buy|sell|swap)\s+[\d.,]+\s+[a-z0-9]+/gi);
  return swapKeywords?.length ?? 0;
}

/**
 * Sanitize and correct LLM-generated swap tool arguments.
 * Extracts intent directly from the user's message and overrides bad args.
 *
 * For multi-swap messages (multiple buy/sell/swap instructions), the amount
 * and token corrections are SKIPPED — the LLM gets per-call amounts right,
 * and applying the first regex match to every call duplicates amounts.
 */
function sanitizeSwapArgs(
  args: Record<string, unknown>,
  userMessage: string,
): Record<string, unknown> {
  const msg = userMessage.toLowerCase().trim();
  const corrected = { ...args };
  const multiSwap = isMultiSwapMessage(msg);

  // ── 1. Force DEX based on explicit user intent ──
  // Both A0xRouter and AUniswapRouter adapters are deployed on Rigoblock vaults.
  // 0x is the default because it aggregates across DEXes for better prices.
  //
  // LLMs have a strong training-data bias toward "uniswap" and will set
  // dex="uniswap" even when the system prompt says 0x is the default.
  // We therefore force the DEX here: use Uniswap only when the user
  // EXPLICITLY typed "uniswap"; otherwise default to 0x.
  const userSaidUniswap = /\buniswap\b/i.test(userMessage);
  corrected.dex = userSaidUniswap ? "uniswap" : "0x";

  // ── 2. Extract amount and direction from user message ──
  // SKIP for multi-swap messages — the regex only matches the first occurrence
  // and would incorrectly force that amount onto every tool call.
  if (!multiSwap) {
    // Pattern: "buy <amount> <token>" → amountOut
    // Pattern: "sell/swap <amount> <token>" → amountIn
    // Pattern: "buy <token> with <amount> <token>" → amountIn (less common)

    // "buy 400 GRG" / "buy 400 GRG with ETH" / "buy 400 GRG on ethereum"
    const buyMatch = msg.match(/\bbuy\s+([\d.,]+)\s+([a-z0-9]+)/i);
    if (buyMatch) {
      const amount = buyMatch[1].replace(/,/g, "");
      const token = buyMatch[2].toUpperCase();

      // The LLM MUST set amountOut for "buy" — correct if wrong.
      // Always delete amountIn so a hallucinated sell-side amount does not
      // override the exact-output path in getZeroXQuote.
      const currentAmountOut = corrected.amountOut as string | undefined;

      if (!currentAmountOut || Math.abs(parseFloat(currentAmountOut) - parseFloat(amount)) > parseFloat(amount) * 0.01) {
        console.log(`[sanitize] Correcting buy amount: amountOut=${currentAmountOut} → ${amount} (user said "buy ${amount} ${token}")`);
        corrected.amountOut = amount;
      }
      delete corrected.amountIn; // buy = amountOut, never amountIn

      // Ensure tokenOut matches the token next to the number
      if (corrected.tokenOut && (corrected.tokenOut as string).toUpperCase() !== token) {
        console.log(`[sanitize] Correcting tokenOut: ${corrected.tokenOut} → ${token}`);
        // Swap tokenIn/tokenOut if they're reversed
        if ((corrected.tokenIn as string)?.toUpperCase() === token) {
          const tmp = corrected.tokenIn;
          corrected.tokenIn = corrected.tokenOut;
          corrected.tokenOut = tmp;
        } else {
          corrected.tokenOut = token;
        }
      }
    }

    // "sell 0.5 ETH for USDC" / "swap 50 USDC to DAI"
    const sellMatch = msg.match(/\b(?:sell|swap)\s+([\d.,]+)\s+([a-z0-9]+)/i);
    if (sellMatch && !buyMatch) {
      const amount = sellMatch[1].replace(/,/g, "");
      const token = sellMatch[2].toUpperCase();

      const currentAmountIn = corrected.amountIn as string | undefined;
      if (!currentAmountIn || Math.abs(parseFloat(currentAmountIn) - parseFloat(amount)) > parseFloat(amount) * 0.01) {
        console.log(`[sanitize] Correcting sell amount: amountIn=${currentAmountIn} → ${amount}`);
        corrected.amountIn = amount;
      }
      delete corrected.amountOut; // sell/swap = amountIn, never amountOut

      if (corrected.tokenIn && (corrected.tokenIn as string).toUpperCase() !== token) {
        console.log(`[sanitize] Correcting tokenIn: ${corrected.tokenIn} → ${token}`);
        if ((corrected.tokenOut as string)?.toUpperCase() === token) {
          const tmp = corrected.tokenOut;
          corrected.tokenOut = corrected.tokenIn;
          corrected.tokenIn = tmp;
        } else {
          corrected.tokenIn = token;
        }
      }
    }
  } else {
    console.log(`[sanitize] Multi-swap detected — skipping amount/token correction, trusting LLM per-call args`);
  }

  // ── 3. Extract chain from user message (only for single-swap) ──
  // For multi-swap, the LLM sets the chain per tool call; overriding here
  // would apply the first chain match to all calls.
  if (!multiSwap) {
    const chainNames = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bnb chain", "unichain", "sepolia"];
    for (const cn of chainNames) {
      if (msg.includes(`on ${cn}`) || msg.includes(`to ${cn}`)) {
        if (!corrected.chain) {
          console.log(`[sanitize] Adding chain=${cn} from user message`);
          corrected.chain = cn;
        }
        break;
      }
    }
  }

  // ── 4. Sanity check: amounts should be reasonable (not raw units) ──
  // If amountOut is set and looks like it's in raw wei (>1e10), it's wrong
  const amtOut = parseFloat(corrected.amountOut as string || "0");
  const amtIn = parseFloat(corrected.amountIn as string || "0");

  if (amtOut > 0 && amtOut < 1e-9) {
    console.warn(`[sanitize] amountOut=${amtOut} looks like raw units, user likely meant something else`);
    // Try to extract from user message
    const numMatch = msg.match(/([\d.,]+)/);
    if (numMatch) {
      corrected.amountOut = numMatch[1].replace(/,/g, "");
      console.log(`[sanitize] Reset amountOut to ${corrected.amountOut} from user message`);
    }
  }
  if (amtIn > 0 && amtIn < 1e-9) {
    console.warn(`[sanitize] amountIn=${amtIn} looks like raw units`);
    const numMatch = msg.match(/([\d.,]+)/);
    if (numMatch) {
      corrected.amountIn = numMatch[1].replace(/,/g, "");
      console.log(`[sanitize] Reset amountIn to ${corrected.amountIn}`);
    }
  }

  return corrected;
}

// ── Fast-path command parsers ────────────────────────────────────────
// Regex-match well-structured commands to bypass the LLM entirely.
// Falls through to the full LLM pipeline on mismatch.

interface FastPathResult {
  name: string;
  args: Record<string, unknown>;
}

// ── Fast-path: Chain switching ───────────────────────────────────────

/**
 * Detect chain-switch commands:
 *   "switch to base"  / "use arbitrum"  / "change to optimism"
 *   "go to polygon"   / "set chain ethereum" / "switch chain base"
 */
function tryFastPathChainSwitch(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  // "switch (to|chain) X" / "use X" / "change to X" / "go to X" / "set chain X"
  const match = m.match(
    /^(?:switch\s+(?:to|chain)|use|change\s+to|go\s+to|set\s+chain)\s+([a-z0-9 ]+)$/i,
  );
  if (match) {
    return { name: "switch_chain", args: { chain: match[1].trim() } };
  }

  return null;
}

// ── Fast-path: Swap Shield toggle ───────────────────────────────────

/**
 * Detect swap shield enable/tolerance commands, including the frontend
 * magic string __enable_swap_shield__ and the legacy __disable_swap_shield__
 * alias (mapped to 50% tolerance).
 */
function tryFastPathSwapShieldToggle(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  if (m === "__enable_swap_shield__" || /^(?:re-?)?enable\s+swap\s+shield$/i.test(m)) {
    return { name: "enable_swap_shield", args: {} };
  }
  // "set swap shield tolerance to 30%" / "swap shield tolerance 50%"
  const toleranceMatch = m.match(/^(?:set\s+)?swap\s+shield\s+tolerance\s+(?:to\s+)?([0-9]+(?:\.[0-9]+)?)%?$/i);
  if (toleranceMatch) {
    return { name: "set_swap_shield_tolerance", args: { tolerance: `${toleranceMatch[1]}%` } };
  }
  // Legacy alias: treat "disable swap shield" as max tolerance (50%)
  if (m === "__disable_swap_shield__" || /^disable\s+swap\s+shield$/i.test(m)) {
    return { name: "set_swap_shield_tolerance", args: { tolerance: "50%" } };
  }

  return null;
}

// ── Fast-path: TWAP order creation ───────────────────────────────────
// Detects: "sell 100 GRG for ETH, 25 at a time every 5 min [using 0x]"
//          "buy 50 ETH with USDC 10 at a time every 10 minutes"
//
// The "N at a time every M minutes" pattern is unambiguous — only create_twap_order
// handles it. Bypassing the LLM avoids hallucinating non-existent tool names
// like "sell_token" or "schedule_swap".

/**
 * Detect unambiguous cross-chain bridge commands where the destination token
 * form differs from the source (ETH→WETH or WETH→ETH). These set
 * shouldUnwrapOnDestination deterministically so the LLM can't get it wrong.
 *
 * "bridge 0.1 eth to weth from ethereum to arbitrum"
 * "transfer 0.5 weth to eth from arbitrum to base"
 */
function tryFastPathBridge(msg: string): FastPathResult | null {
  const m = msg.trim();

  // ETH (source native) → WETH (destination wrapped) — shouldUnwrapOnDestination=false
  const ethToWeth = m.match(
    /^(?:bridge|transfer|send|move)\s+([\d.,]+)\s+eth\s+(?:to|as)\s+weth\s+(?:from\s+(\w[\w\s]*?)\s+)?to\s+(\w[\w\s]*)$/i,
  );
  if (ethToWeth) {
    const args: Record<string, unknown> = {
      token: "WETH",
      amount: ethToWeth[1].replace(/,/g, ""),
      destinationChain: ethToWeth[3].trim(),
      useNativeEth: true,
      shouldUnwrapOnDestination: false,
    };
    if (ethToWeth[2]) args.sourceChain = ethToWeth[2].trim();
    return { name: "crosschain_transfer", args };
  }

  // WETH (source wrapped) → ETH (destination native) — shouldUnwrapOnDestination=true
  const wethToEth = m.match(
    /^(?:bridge|transfer|send|move)\s+([\d.,]+)\s+weth\s+(?:to|as)\s+eth\s+(?:from\s+(\w[\w\s]*?)\s+)?to\s+(\w[\w\s]*)$/i,
  );
  if (wethToEth) {
    const args: Record<string, unknown> = {
      token: "WETH",
      amount: wethToEth[1].replace(/,/g, ""),
      destinationChain: wethToEth[3].trim(),
      useNativeEth: false,
      shouldUnwrapOnDestination: true,
    };
    if (wethToEth[2]) args.sourceChain = wethToEth[2].trim();
    return { name: "crosschain_transfer", args };
  }

  return null;
}

function tryFastPathTwapCreate(msg: string): FastPathResult | null {
  const m = msg;

  // Require both "at a time" and "every N min" patterns
  const intervalMatch = m.match(/every\s+(\d+)\s*min(?:ute)?s?/i);
  if (!intervalMatch) return null;
  const sliceMatch = m.match(/(\d+(?:\.\d+)?)\s+at\s+a\s+time/i);
  if (!sliceMatch) return null;

  const intervalMinutes = parseInt(intervalMatch[1]);
  const sliceAmount = sliceMatch[1];

  // Determine side and parse tokens/amount
  // sell: "sell TOTAL TOKEN for/to BUYTOKEN"
  const sellMatch = m.match(/\bsell\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(?:for|to|into)\s+(\w+)/i);
  if (sellMatch) {
    const dex = /\b0x\b/i.test(m) ? "0x" : "uniswap";
    return {
      name: "create_twap_order",
      args: {
        side: "sell",
        sellToken: sellMatch[2].toUpperCase(),
        buyToken: sellMatch[3].toUpperCase(),
        totalAmount: sellMatch[1],
        sliceAmount,
        intervalMinutes,
        dex,
      },
    };
  }

  // buy: "buy TOTAL TOKEN with/using SELLTOKEN"
  const buyMatch = m.match(/\bbuy\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(?:with|using)\s+(\w+)/i);
  if (buyMatch) {
    const dex = /\b0x\b/i.test(m) ? "0x" : "uniswap";
    return {
      name: "create_twap_order",
      args: {
        side: "buy",
        buyToken: buyMatch[2].toUpperCase(),
        sellToken: buyMatch[3].toUpperCase(),
        totalAmount: buyMatch[1],
        sliceAmount,
        intervalMinutes,
        dex,
      },
    };
  }

  return null;
}

// ── Fast-path: Strategy/TWAP list queries ───────────────────────────

function tryFastPathStrategyQueries(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  if (/^(?:what\s+are|show|list)(?:\s+my)?\s+(?:active\s+)?strateg(?:y|ies)\??$/i.test(m)) {
    return { name: "list_strategies", args: {} };
  }

  if (/^(?:what\s+are|show|list)(?:\s+my)?\s+(?:active\s+)?twap\s+orders?\??$/i.test(m)) {
    return { name: "list_twap_orders", args: {} };
  }

  return null;
}

// ── Fast-path: Capability questions (no tool calls) ─────────────────

function tryFastPathCapabilityQuestion(msg: string): string | null {
  const m = msg.toLowerCase().trim();

  const isQuestion = m.endsWith("?") || /^(if\s+i\s+asked|can\s+you|could\s+you|would\s+you)/i.test(m);
  if (!isQuestion) return null;

  if (/\bsync\b/.test(m) && /\bnav\b/.test(m)) {
    return "Yes. I can prepare NAV sync transactions between chains. NAV sync and token transfer are different operations: sync uses crosschain sync, while bridge/transfer moves tokens. For two chains, I can prepare one direction first (e.g. Arbitrum -> Base) and then the reverse direction if requested.";
  }

  return null;
}

// ── Fast-path: Swap / Buy / Sell ─────────────────────────────────────

/**
 * Detect simple swap commands:
 *   "sell 50 USDC for ETH"                → build_vault_swap (EXACT_INPUT)
 *   "sell 50 USDC for ETH on base"        → build_vault_swap + chain
 *   "buy 100 USDC with ETH"               → build_vault_swap (EXACT_OUTPUT)
 *   "buy 0.5 ETH with USDC on arbitrum"   → build_vault_swap (EXACT_OUTPUT)
 *   "swap 100 USDC for ETH"               → build_vault_swap (EXACT_INPUT)
 *   "swap 100 USDC to ETH"                → build_vault_swap (EXACT_INPUT)
 */
export function tryFastPathSwap(msg: string): FastPathResult | null {
  let m = msg.trim();

  // Normalise token references: uppercase symbols, preserve addresses (lowercase).
  // Addresses start with 0x and are 42 chars — don't uppercase them or
  // resolveTokenAddress() won't recognise them (checks .startsWith("0x")).
  const normalizeToken = (t: string) =>
    /^0x[0-9a-f]{40}$/i.test(t) ? t.toLowerCase() : t.toUpperCase();

  // Strip conversational prefixes ("I want to", "can you", "please", etc.)
  // so "I want to sell 100 ETH for USDC" matches the same regex as "sell 100 ETH for USDC".
  m = m.replace(
    /^(?:(?:i\s+)?(?:want|would like|need|['']d like)\s+to\s+|(?:can|could)\s+you\s+(?:please\s+)?|please\s+)/i,
    "",
  ).trim();

  // Extract chain modifier — appears either as the final suffix OR before a DEX modifier:
  //   "sell 1 ETH for USDC on base"             → chain=base
  //   "sell 1 ETH for USDC on base using 0x"    → chain=base, DEX suffix preserved
  //   "sell 1 ETH for USDC on base with 0x"     → chain=base, DEX suffix preserved
  //   "sell 1 ETH for USDC using 0x on base"    → chain=base, DEX suffix preserved
  let chain: string | undefined;
  // Pattern: "on <chain> [using/via/with/on <dex>]" — chain comes before optional DEX suffix.
  // Lookahead covers all DEX-modifier keywords supported by dexMatch below.
  const chainWithDexMatch = m.match(/\s+on\s+([a-z0-9 ]+?)(?=\s+(?:using|via|with|on)\s+[a-z0-9x]+\s*$|\s*$)/i);
  if (chainWithDexMatch) {
    const possibleChain = chainWithDexMatch[1].trim().toLowerCase();
    // Accept any chain alias that resolveChainArg understands (supports
    // multi-word names like "bnb chain" / "bnb smart chain").
    try {
      const resolved = resolveChainArg(possibleChain);
      chain = resolved.name.toLowerCase();
      // Remove just the "on <chain>" segment, preserving any trailing DEX modifier.
      m = (m.slice(0, chainWithDexMatch.index!) + m.slice(chainWithDexMatch.index! + chainWithDexMatch[0].length)).trim();
    } catch {
      // Not a chain alias; leave untouched so DEX suffix parsing can handle
      // patterns like "on uniswap".
    }
  }

  // Extract DEX modifier ("using 0x", "via uniswap") — now that chain is stripped
  let dex: string | undefined;
  const dexMatch = m.match(/\s+(?:using|via|on|with)\s+(0x|uniswap|zerox)$/i);
  if (dexMatch) {
    dex = dexMatch[1].toLowerCase() === "zerox" ? "0x" : dexMatch[1].toLowerCase();
    m = m.slice(0, dexMatch.index!).trim();
  }

  // ── "sell <amount> <tokenIn> for <tokenOut> [on <chain>]" ──
  const sellMatch = m.match(
    /^sell\s+([\d.,]+)\s+([a-z0-9]+)\s+(?:for|to|into)\s+([a-z0-9]+)$/i,
  );
  if (sellMatch) {
    const args: Record<string, unknown> = {
      tokenIn: normalizeToken(sellMatch[2]),
      tokenOut: normalizeToken(sellMatch[3]),
      amountIn: sellMatch[1].replace(/,/g, ""),
    };
    if (chain) args.chain = chain;
    if (dex) args.dex = dex;
    return { name: "build_vault_swap", args };
  }

  // ── "buy <amount> <tokenOut> [with <tokenIn>] [on <chain>]" ──
  const buyMatch = m.match(
    /^buy\s+([\d.,]+)\s+([a-z0-9]+)(?:\s+(?:with|using|for)\s+([a-z0-9]+))?$/i,
  );
  if (buyMatch) {
    const args: Record<string, unknown> = {
      tokenOut: normalizeToken(buyMatch[2]),
      amountOut: buyMatch[1].replace(/,/g, ""),
    };
    // Default tokenIn to USDC if not specified
    args.tokenIn = buyMatch[3] ? normalizeToken(buyMatch[3]) : "USDC";
    if (chain) args.chain = chain;
    if (dex) args.dex = dex;
    return { name: "build_vault_swap", args };
  }

  // ── "swap <amount> <tokenIn> for/to <tokenOut> [on <chain>]" ──
  const swapMatch = m.match(
    /^swap\s+([\d.,]+)\s+([a-z0-9]+)\s+(?:for|to|into)\s+([a-z0-9]+)$/i,
  );
  if (swapMatch) {
    const args: Record<string, unknown> = {
      tokenIn: normalizeToken(swapMatch[2]),
      tokenOut: normalizeToken(swapMatch[3]),
      amountIn: swapMatch[1].replace(/,/g, ""),
    };
    if (chain) args.chain = chain;
    if (dex) args.dex = dex;
    return { name: "build_vault_swap", args };
  }

  // ── "unwrap <amount> [token] [to <token>]" ── wrapped-native → native
  // Matches: "unwrap 0.1 weth", "unwrap 0.1 eth", "unwrap 0.1 weth to eth"
  const unwrapMatch = m.match(/^unwrap\s+([\d.,]+)\s*([a-z]+)?(?:\s+to\s+[a-z]+)?$/i);
  if (unwrapMatch) {
    const sym = (unwrapMatch[2] || "ETH").toUpperCase();
    const tokenIn  = sym.startsWith("W") ? sym : `W${sym}`;
    const tokenOut = sym.startsWith("W") ? sym.slice(1) : sym;
    const args: Record<string, unknown> = { tokenIn, tokenOut, amountIn: unwrapMatch[1].replace(/,/g, "") };
    if (chain) args.chain = chain;
    return { name: "build_vault_swap", args };
  }

  // ── "wrap <amount> [token] [to <token>]" ── native → wrapped-native
  // Matches: "wrap 0.8 eth", "wrap 0.8 eth to weth", "wrap 0.8 weth to eth" (user confusion)
  const wrapMatch = m.match(/^wrap\s+([\d.,]+)\s*([a-z]+)?(?:\s+to\s+[a-z]+)?$/i);
  if (wrapMatch) {
    const sym = (wrapMatch[2] || "ETH").toUpperCase();
    const tokenIn  = sym.startsWith("W") ? sym.slice(1) : sym;
    const tokenOut = sym.startsWith("W") ? sym : `W${sym}`;
    const args: Record<string, unknown> = { tokenIn, tokenOut, amountIn: wrapMatch[1].replace(/,/g, "") };
    if (chain) args.chain = chain;
    return { name: "build_vault_swap", args };
  }

  return null;
}

// ── Fast-path: GMX commands ──────────────────────────────────────────
// Regex-matches well-structured GMX commands to bypass the LLM entirely.

/**
 * Detect "increase position" commands that should route directly to gmx_increase_position
 * without any intermediate get_markets / get_positions calls.
 *
 * Patterns:
 *   "increase [by] 1500 usd [LIT] [10x] position"
 *   "increase [by] 1500 usd [LIT/USD] [10x] position [on gmx] [using WETH]"
 *   "add 1500 usd to [LIT] [long] position"
 *   "add to [LIT] position [1500 usd] [10x]"
 */
function tryFastPathGmxIncrease(msg: string): FastPathResult | null {
  const m = msg.trim();

  // "increase [by] N usd [long|short] [MARKET] [Nx] position [on gmx] [using COLLATERAL]"
  // Word order is flexible — some users say "long LIT/USD", others say "LIT/USD long".
  const incMatch = m.match(
    /^(?:increase|add)(?:\s+by)?\s+([\d.,]+)\s+(?:usd|usdc|usdt)?\b.*\bposition\b/i,
  );
  if (incMatch) {
    const args: Record<string, unknown> = {
      notionalUsd: incMatch[1].replace(/,/g, ""),
    };

    // Extract market symbol — look for a token symbol before or after direction
    const marketMatch = m.match(/\b([A-Z]{2,8})(?:\/USD[CT]?)?\b/i);
    if (marketMatch) args.market = marketMatch[1].toUpperCase();

    // Extract leverage: "10x", "5.5x"
    const leverageMatch = m.match(/(\d+(?:\.\d+)?)\s*x/);
    if (leverageMatch) args.leverage = leverageMatch[1];

    // Extract collateral from "using WETH/ETH/USDC" suffix
    const collateralMatch = m.match(/using\s+(\w+)/i);
    if (collateralMatch) args.collateral = collateralMatch[1].toUpperCase();

    // Direction: default true (increase keeps existing position direction)
    args.isLong = true;
    const shortMatch = m.match(/\bshort\b/i);
    if (shortMatch) args.isLong = false;

    return { name: "gmx_increase_position", args };
  }

  // "long N MARKET Nx" / "short N MARKET Nx" — open/increase
  const longShortMatch = m.match(
    /^(long|short)\s+([\d.,]+)\s+([A-Z]{2,8}(?:\/USD[CT]?)?)\s*(\d+(?:\.\d+)?x)?/i,
  );
  if (longShortMatch) {
    const isLong = longShortMatch[1].toLowerCase() === "long";
    const market = longShortMatch[3].toUpperCase().replace(/\/USD[CT]?$/i, "");
    const args: Record<string, unknown> = {
      market,
      isLong,
      notionalUsd: longShortMatch[2].replace(/,/g, ""),
    };
    if (longShortMatch[4]) args.leverage = longShortMatch[4].replace(/x$/i, "");
    const collateralMatch = m.match(/using\s+(\w+)/i);
    if (collateralMatch) args.collateral = collateralMatch[1].toUpperCase();
    return { name: "gmx_open_position", args };
  }

  // "close [my] MARKET [long|short] [position]"
  const closeMatch = m.match(
    /^close(?:\s+my)?\s+([A-Z]{2,8})(?:\/USD)?\s*(long|short)?\s*(?:position)?$/i,
  );
  if (closeMatch) {
    return {
      name: "gmx_close_position",
      args: {
        market: closeMatch[1].toUpperCase(),
        isLong: closeMatch[2]?.toLowerCase() !== "short",
        sizeDeltaUsd: "0", // full close
      },
    };
  }

  // "show [my] [gmx] positions" / "my perps"
  if (/^(?:show|list|get|check)(?:\s+my)?\s+(?:gmx\s+)?positions?$/i.test(m) ||
      /^my\s+perps?$/i.test(m) ||
      /^(?:gmx\s+)?positions?$/i.test(m)) {
    return { name: "gmx_get_positions", args: {} };
  }

  // "gmx markets" / "show gmx markets"
  if (/^(?:show\s+)?gmx\s+markets?$/i.test(m) || /^(?:list\s+)?gmx\s+markets?$/i.test(m)) {
    return { name: "gmx_get_markets", args: {} };
  }

  return null;
}
