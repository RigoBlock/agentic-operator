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
import { detectDomains, buildSystemPrompt, filterToolsForDomains, type DomainKey } from "./prompts.js";
import { getSkillTools, getSkillSystemPrompt } from "../skills/index.js";

// Merge skill tools into the base definitions (skill tools are always available for dispatch)
const ALL_TOOL_DEFINITIONS = [...BASE_TOOL_DEFINITIONS, ...getSkillTools()];
import { getUniswapQuote, getUniswapSwapCalldata, formatUniswapQuoteForDisplay } from "../services/uniswapTrading.js";
import { getZeroXQuote, formatZeroXQuoteForDisplay } from "../services/zeroXTrading.js";
import { getVaultInfo, getVaultTokenBalance, encodeVaultExecute, getTokenDecimals, getPoolData, getNavData, encodeMint, getClient } from "../services/vault.js";
import { resolveTokenAddress, resolveChainId, SUPPORTED_CHAINS, TESTNET_CHAINS, sanitizeError, STAKING_PROXY } from "../config.js";
import { decodeFunctionData, encodeFunctionData, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { POOL_FACTORY_ADDRESS, POOL_FACTORY_ABI } from "../abi/poolFactory.js";
import { ERC20_ABI } from "../abi/erc20.js";
import {
  prepareDelegation,
  prepareRevocation,
  prepareSelectiveRevocation,
  checkDelegationOnChain,
  buildDefaultSelectors,
  getDelegationConfig,
} from "../services/delegation.js";
import { getAgentWalletInfo } from "../services/agentWallet.js";
import {
  findGmxMarket,
  getGmxMarkets,
  getGmxTickers,
  getGmxTokenPrice,
  resolveGmxCollateral,
  getGmxTokenDecimals,
  buildCreateIncreaseOrderCalldata,
  buildCreateDecreaseOrderCalldata,
  buildUpdateOrderCalldata,
  buildCancelOrderCalldata,
  buildClaimFundingFeesCalldata,
} from "../services/gmxTrading.js";
import { getGmxPositionsSummary, getGmxPositions } from "../services/gmxPositions.js";
import { ARBITRUM_CHAIN_ID, GmxOrderType } from "../abi/gmx.js";
import {
  getCrosschainQuote,
  buildCrosschainTransfer,
  buildCrosschainSync,
  getAggregatedNav,
  buildRebalancePlan,
  chainName as crosschainChainName,
} from "../services/crosschain.js";
import { buildAddLiquidityTx, buildRemoveLiquidityTx, getVaultLPPositions, buildCollectFeesTx, buildBurnPositionTx, getPoolInfoById, getPositionDirect } from "../services/uniswapLP.js";
import {
  buildStakeCalldata,
  buildUndelegateStakeCalldata,
  buildUnstakeCalldata,
  buildEndEpochCalldata,
  buildWithdrawDelegatorRewardsCalldata,
} from "../services/grgStaking.js";
import { checkNavImpact } from "../services/navGuard.js";
import {
  checkSwapPrice,
  isSwapShieldDisabled,
  disableSwapShield,
  enableSwapShield,
  getStoredSlippage,
  setStoredSlippage,
  DEFAULT_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
} from "../services/swapShield.js";

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
 * Workers AI (Llama) sometimes calls "swap" instead of "build_vault_swap",
 * "quote" instead of "get_swap_quote", etc.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  swap: "build_vault_swap",
  quote: "get_swap_quote",
  get_quote: "get_swap_quote",
  swap_tokens: "build_vault_swap",
  execute_swap: "build_vault_swap",
  trade: "build_vault_swap",
};

/**
 * Tools that require verified operator authentication.
 *
 * Keep this as the single source of truth instead of scattering checks in
 * individual tool handlers.
 */
const OPERATOR_VERIFIED_TOOLS = new Set<string>([
  // Operator-scoped KV mutations
  "set_default_slippage",
  "disable_swap_shield",
  "enable_swap_shield",
  // Strategy visibility is operator-private
  "list_strategies",
]);

/**
 * Translate raw error messages into user-friendly language.
 * Preserves on-chain revert details (decoded from selectors) while hiding
 * RPC internals, stack traces, and API keys.
 */
function friendlyError(raw: string): string {
  // Pass through already-formatted rich error messages (multiline with context).
  // These come from tool handlers (crosschain_sync, Swap Shield, etc.) that include proposed
  // action details, NAV data, options, and decoded revert reasons. Don't strip them.
  if (raw.includes('\n') && (raw.startsWith('❌') || raw.startsWith('⚠️') || raw.includes('Proposed action:'))) {
    return raw;
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
    return onChainErr
      ? `Transaction would fail on-chain: ${onChainErr[1].trim()}.`
      : "Transaction simulation failed — it would revert on-chain. Check parameters and try again.";
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
  // Starts with or contains a tool-call-shaped JSON object
  if (/(?:function.?call|should\s+(?:be|call)|here\s+is|call\s+the\s+tool)\s*:?\s*\{/i.test(stripped)) return true;
  // Text is predominantly JSON (>60% of content is inside braces)
  const braceStart = stripped.indexOf('{');
  if (braceStart >= 0 && braceStart < 80) {
    const jsonPart = extractBalancedBraces(stripped.slice(braceStart));
    if (jsonPart && jsonPart.length > stripped.length * 0.5) return true;
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
 * Handles DeepSeek R1 reasoning: extracts <think>...</think> blocks and
 * stores them in a custom `_reasoning` field on the response for the caller.
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

  // For DeepSeek R1: use higher max_tokens to allow full chain-of-thought reasoning.
  // Default Workers AI token limit can truncate reasoning mid-thought, causing the
  // model to produce incomplete plans. DeepSeek R1 needs more tokens for <think> blocks.
  const isDeepSeek = model.includes('deepseek');

  // ── Streaming mode for DeepSeek + live reasoning callback ──
  // Streams tokens as they arrive so the user sees reasoning in real-time
  // instead of a static "Thinking…" for 20 seconds.
  if (isDeepSeek && onReasoningToken) {
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
    let inThink = false;
    let reasoning = '';
    // Throttle reasoning events: emit at most every 150ms to avoid flooding the SSE pipe
    let lastEmitTime = 0;

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
          const token: string = json.response || '';
          if (!token) continue;
          fullText += token;

          // Detect <think> open tag
          if (!inThink && fullText.includes('<think>')) {
            inThink = true;
            reasoning = fullText.split('<think>').slice(1).join('<think>');
            if (reasoning.includes('</think>')) {
              reasoning = reasoning.split('</think>')[0];
              inThink = false;
            }
          } else if (inThink) {
            reasoning += token;
            // Detect </think> close tag
            if (reasoning.includes('</think>')) {
              reasoning = reasoning.split('</think>')[0];
              inThink = false;
            }
          }

          // Emit accumulated reasoning periodically (throttled)
          if (inThink && reasoning.length > 0) {
            const now = Date.now();
            if (now - lastEmitTime > 150) {
              onReasoningToken(reasoning.trim());
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

    // Extract text-embedded tool calls (same logic as non-streaming path)
    if (textContent) {
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

  // ── Non-streaming path (Llama, or DeepSeek without reasoning callback) ──
  const result = await (ai as any).run(model, {
    messages: sanitizedMessages as any,
    ...(tools ? { tools: tools as any } : {}),
    max_tokens: isDeepSeek ? 16384 : 4096,
  });

  let hasToolCalls = Array.isArray(result.tool_calls) && result.tool_calls.length > 0;
  let toolCalls = hasToolCalls ? result.tool_calls : undefined;
  let textContent: string | null = typeof result.response === 'string' ? result.response : null;

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

  // ── Extract DeepSeek R1 reasoning (<think>...</think> blocks) ──
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

    // Try multiple patterns — Llama sometimes outputs different JSON structures
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
    // Custom field: DeepSeek R1 reasoning trace (not part of OpenAI spec)
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
  // Dual-model Workers AI strategy:
  //   - DeepSeek R1 (32B): primary reasoning model — handles initial request analysis,
  //     complex decisions, and strategy planning. Produces <think> reasoning traces.
  //   - Llama 3.3 70B: fast tool-calling model — used for follow-up calls after tool
  //     results come back (formatting, next-step decisions). Faster for simple tasks.
  const DEEPSEEK_MODEL = "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
  const LLAMA_FAST_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  let openai: OpenAI | null = null;
  let useBinding = false;
  let llmModel: string;
  let fastModel: string; // For follow-up/chained calls (Workers AI only)
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
    fastModel = llmModel; // Same model for user-provided keys
  } else if (env.AI) {
    // Workers AI via binding (default — no API key needed, zero-config)
    //
    // Primary model: Llama 3.3 70B — reliable structured tool calling on Workers AI.
    // DeepSeek R1 is available as opt-in or auto-selected for complex multi-step reasoning.
    //
    // Fast follow-up model: always Llama 3.3 70B (better tool calling, lower latency).
    useBinding = true;
    // Model routing strategy:
    //   Default: Llama 3.3 70B — fast, reliable tool calling.
    //   DeepSeek R1: opt-in via user setting, OR automatic escalation.
    //
    // NO regex pattern matching for model selection. Instead:
    //   1. Llama tries first (fast — handles most requests in ~5s)
    //   2. If Llama fails (no tool calls, unhelpful text) → escalate to DeepSeek
    //   3. DeepSeek reasons → hand back to Llama for tool execution
    // This is robust: no regex can be tricked, no pattern can be missed.
    llmModel = (ctx.aiModel === "deepseek" || ctx.routingMode === "deepseek_only")
      ? DEEPSEEK_MODEL
      : LLAMA_FAST_MODEL;
    fastModel = LLAMA_FAST_MODEL; // always Llama for follow-up tool calls
  } else if (env.OPENAI_API_KEY) {
    // Fallback to server OpenAI key
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 45_000 });
    llmModel = ctx.aiModel || "gpt-5-mini";
    fastModel = llmModel;
  } else {
    throw new Error("No AI provider configured. Add [ai] binding to wrangler.toml, or set OPENAI_API_KEY.");
  }

  // Unified LLM caller — routes to AI binding adapter or OpenAI SDK
  const callLLM = async (params: {
    model: string;
    messages: OpenAI.ChatCompletionMessageParam[];
    tools?: OpenAI.ChatCompletionTool[];
    tool_choice?: "auto";
  }, streamReasoning?: boolean) => {
    recordModel(params.model);
    if (useBinding) {
      // When streamReasoning is true AND we have an onStreamEvent callback,
      // pass it to callWorkersAI so DeepSeek reasoning streams in real-time.
      const reasoningCallback = (streamReasoning && onStreamEvent)
        ? (accumulated: string) => onStreamEvent({ type: 'reasoning', content: accumulated })
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

  // Immediate fast-path: deterministic commands that never need an LLM call.
  // NOTE: crosschain_sync is intentionally NOT in the fast-path.
  // Cross-chain operations need LLM reasoning to show the user what was computed
  // (NAV data, direction, token, amount) and explain errors. Speed is not the
  // priority — correctness and transparency are.
  const immediateFastPath =
    tryFastPathChainSwitch(lastUserMsg) ||
    (hasVault ? tryFastPathSwapShieldToggle(lastUserMsg) : null) ||
    (hasVault ? tryFastPathStrategyQueries(lastUserMsg) : null) ||
    (hasVault ? tryFastPathTwapCreate(lastUserMsg) : null);
  if (immediateFastPath) {
    console.log(`[LLM] Immediate fast-path (no LLM): ${immediateFastPath.name}(${JSON.stringify(immediateFastPath.args)})`);
    try {
      onStreamEvent?.({ type: "status", message: `Executing ${immediateFastPath.name}...` });
      const toolResult = await executeToolCall(env, ctx, immediateFastPath.name, immediateFastPath.args);
      return {
        reply: toolResult.message,
        toolCalls: [{ name: immediateFastPath.name, arguments: immediateFastPath.args, result: toolResult.message, error: false }],
        chainSwitch: toolResult.chainSwitch,
        suggestions: toolResult.suggestions,
        reasoning: fastPathReasoning,
        modelsUsed: [],
        finalModel: "tooling",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // For tool calls that produced informative errors (balance, revert, NAV),
      // return the error directly — falling through to DeepSeek would hallucinate.
      const isInformativeError = /insufficient|revert|blocked|failed|not found|not bridgeable|no bridgeable/i.test(errMsg);
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

  // Deferred fast-path for swaps/LP/GMX: compute the match now, execute AFTER the
  // first LLM call only if the LLM produces no tool calls (plain-text response).
  const deferredFastPath: FastPathResult | null =
    (hasVault ? tryFastPathSwap(lastUserMsg) : null) ||
    (hasVault ? tryFastPathUniswapLP(lastUserMsg) : null) ||
    (hasVault ? tryFastPathGmx(lastUserMsg) : null);

  const withRuntimeContext = (msgs: OpenAI.ChatCompletionMessageParam[]) =>
    msgs.some((m) => m.role === "system")
      ? msgs
      : [{ role: "system" as const, content: contextualPrompt }, ...msgs];

  // First LLM call
  console.log(`[LLM] Calling ${llmModel} with ${fullMessages.length} messages, ${TOOL_DEFINITIONS.length} tools`);
  // User-friendly model label for status messages
  const modelLabel = llmModel.includes('deepseek') ? 'DeepSeek R1 (reasoning)'
    : llmModel.includes('llama') ? 'Llama 3.3' : llmModel.split('/').pop() || llmModel;
  onStreamEvent?.({ type: "status", message: `Thinking (${modelLabel})…` });
  // For DeepSeek: stream reasoning tokens in real-time so the user sees thinking progress
  // instead of a static "Thinking…" for 20 seconds. The streamReasoning flag enables this.
  const isDeepSeekFirstCall = llmModel.includes('deepseek');
  const response = await callLLM({
    model: llmModel,
    messages: withRuntimeContext(fullMessages),
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
  }, isDeepSeekFirstCall);
  console.log(`[LLM] Response: finish_reason=${response.choices[0]?.finish_reason}, tool_calls=${response.choices[0]?.message?.tool_calls?.length ?? 0}`);
  // Don't emit "Model responded" — the next meaningful event (reasoning, tool_call, text) replaces it

  const choice = response.choices[0];
  if (!choice) throw new Error("No response from LLM");

  // Extract DeepSeek R1 reasoning from the first LLM call.
  // When DeepSeek streaming is active, reasoning was already emitted token-by-token.
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
  let pendingSelfContained = false;

  // Autonomous orchestration loop: continue tool execution across multiple rounds
  // until we reach an actionable outcome (tx batch / self-contained report) or max rounds.
  //
  // Bidirectional model escalation:
  //   Llama → DeepSeek: when Llama can't handle a request (no tool calls, unhelpful text)
  //   DeepSeek → Llama: when DeepSeek reasons but doesn't call tools (existing path below)
  let orchestrationChoice = choice;

  // ── Llama → DeepSeek escalation ──
  // If Llama returned no tool calls and gave an unhelpful response ("lacking details",
  // "provide more information", etc.), escalate to DeepSeek R1 for reasoning.
  // DeepSeek understands complex intents (crosschain sync, multi-step plans) that
  // Llama can't handle alone. Its reasoning is then handed to Llama for tool execution.
  //
  // This is the robust alternative to regex pattern matching: instead of trying to
  // predict which requests need reasoning, we let Llama try first and escalate on failure.
  //
  // LOOP GUARD: The entire escalation path is bounded to at most 3 LLM calls:
  //   Call 1: Llama (fast) — initial attempt
  //   Call 2: DeepSeek (reasoning) — escalation (only if Llama was unhelpful)
  //   Call 3: Llama (fast retry) — tool execution with DeepSeek's context
  // After that, we proceed to the orchestration loop or return directly.
  // No further escalation is possible because `escalatedToDeepSeek` prevents re-entry.
  let escalatedToDeepSeek = false;
  if (
    !orchestrationChoice.message.tool_calls?.length &&
    llmModel === LLAMA_FAST_MODEL &&
    useBinding
  ) {
    const llamaText = orchestrationChoice.message.content?.trim() || '';
    const isUnhelpful = !llamaText || llamaText.length < 100 ||
      /\b(lacking|need more|specify|provide more|unable to|cannot determine|more information|more details|more context)\b/i.test(llamaText);

    if (isUnhelpful) {
      console.log(`[LLM] Llama produced unhelpful response — escalating to DeepSeek R1 for reasoning`);
      onStreamEvent?.({ type: "status", message: "Escalating to DeepSeek R1 for deeper analysis…" });

      const deepSeekEscalation = await callLLM({
        model: DEEPSEEK_MODEL,
        messages: withRuntimeContext(fullMessages),
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      }, true); // stream reasoning in real-time

      const dsChoice = deepSeekEscalation.choices[0];
      if (dsChoice) {
        // Update reasoning from DeepSeek's response
        const dsReasoning = (deepSeekEscalation as any)._reasoning as string | undefined;
        if (dsReasoning) {
          reasoning = dsReasoning;
          orchestrationReasoning = dsReasoning;
          onStreamEvent?.({ type: "reasoning", content: dsReasoning });
        }
        const dsText = dsChoice.message.content?.trim();
        if (dsText && !looksLikeToolCallText(dsText)) {
          onStreamEvent?.({ type: "text", content: dsText });
        }
        orchestrationChoice = dsChoice;
        // Mark as DeepSeek so the existing DeepSeek→Llama handoff fires below
        // if DeepSeek also produced no tool calls (it will hand reasoning to Llama).
        llmModel = DEEPSEEK_MODEL;
        escalatedToDeepSeek = true;
      }
    }
  }

  // ── DeepSeek → Llama handoff ──
  // DeepSeek is great at reasoning but often doesn't produce structured tool calls.
  // When DeepSeek returns text (reasoning + plan) but no tool calls, hand the
  // condensed intent to Llama for fast, reliable tool execution.
  if (!orchestrationChoice.message.tool_calls?.length && llmModel === DEEPSEEK_MODEL) {
    console.log(`[LLM] DeepSeek produced no tool calls — retrying with ${LLAMA_FAST_MODEL} for tool execution`);
    // DeepSeek's text was already emitted as "text" event via firstCallText above — don't duplicate it.
    const deepseekText = orchestrationChoice.message.content?.trim();
    onStreamEvent?.({ type: "status", message: "Executing DeepSeek's plan…" });

    // CRITICAL: Pass DeepSeek's intent (not raw text) to Llama so it calls the right tools.
    // DeepSeek's raw text often contains hallucinated numbers, formulas, and step-by-step
    // instructions ("bridge 1000 USDC", "use Dune Analytics") that Llama copies literally
    // instead of using the tools' built-in calculation logic.
    //
    // Strategy: pass a condensed intent summary with explicit tool-calling guidance,
    // NOT DeepSeek's full text with hallucinated specifics.
    const deepseekContext: OpenAI.ChatCompletionMessageParam[] = [];

    // Extract intent from DeepSeek's reasoning (short summary, no numbers or token bias)
    const intentSummary = reasoning
      ? reasoning
          // Strip formula blocks (LaTeX, code blocks, equations)
          .replace(/\$\$[\s\S]*?\$\$/g, '')
          .replace(/\$[^$]+\$/g, '')
          .replace(/```[\s\S]*?```/g, '')
          // Strip specific numbers that DeepSeek hallucinated
          .replace(/\b\d+(?:\.\d+)?\s*(?:USDC|USDT|ETH|WETH|WBTC|tokens?|units?)\b/gi, '[auto-calculated]')
          // Strip token-specific assumptions ("use USDT", "with USDC", "bridge USDT")
          .replace(/\b(use|with|bridge|send|transfer)\s+(USDC|USDT|WETH|WBTC)\b/gi, '$1 [auto-selected token]')
          // Strip "I remember" / "from previous" bias patterns
          .replace(/I\s+remember\s+that[^.]*\./gi, '')
          .replace(/from\s+(?:the\s+)?previous[^.]*\./gi, '')
          .replace(/in\s+(?:the\s+)?(?:last|prior|earlier)[^.]*\./gi, '')
          // Collapse to first 500 chars of cleaned text
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500)
      : null;

    const planBlock = deepseekText || '';
    // Extract just the high-level intent (first 1-2 sentences), strip formulas and specifics
    const cleanedPlan = planBlock
      .replace(/###.*$/gm, '')          // strip markdown headers
      .replace(/\*\*/g, '')             // strip bold markers
      .replace(/\[.*?\]/g, '')          // strip LaTeX
      .replace(/\d{3,}/g, '[N]')        // replace large numbers with placeholder
      .split(/\n\n/)[0]                 // take first paragraph only
      ?.trim()
      .slice(0, 300) || '';

    if (intentSummary || cleanedPlan) {
      deepseekContext.push({
        role: "assistant" as const,
        content: `DeepSeek analysis summary: ${intentSummary || cleanedPlan}`,
      });
      deepseekContext.push({
        role: "user" as const,
        content: [
          "Now execute the intent above using the available tools.",
          "Call the appropriate tool — do NOT output text analysis.",
          "",
          "CRITICAL TOOL-CALLING RULES:",
          "- For crosschain sync / NAV equalization / price equalization: call crosschain_sync with equalizeNav=true.",
          "  Do NOT set amount or token — the service auto-calculates direction, amount, and token.",
          "  Do NOT assume source chain, token, or direction from the analysis above or conversation history.",
          "  Just pass the two chain names and equalizeNav=true. The tool handles everything else.",
          "- For bridge/transfer: call crosschain_transfer. Do NOT set amounts from the analysis.",
          "- NEVER hardcode amounts or token names from the reasoning. The tools read on-chain state.",
          "- NEVER echo or repeat the analysis text. Just call the tool.",
        ].join("\n"),
      });
    }

    const retryResponse = await callLLM({
      model: LLAMA_FAST_MODEL,
      messages: withRuntimeContext([...fullMessages, ...deepseekContext]),
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    });
    const retryChoice = retryResponse.choices[0];
    if (retryChoice?.message?.tool_calls?.length) {
      orchestrationChoice = retryChoice;
      console.log(`[LLM] Llama retry produced ${retryChoice.message.tool_calls.length} tool call(s)`);
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
              await preCheckNavImpact(env, ctx, toolResult.transaction);
              toolResult.transaction.navShieldChecked = true;
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

          if (toolResult.selfContained) {
            pendingSelfContained = true;
          }

          // Detect DEX/protocol from tool call
          if ((name === "get_swap_quote" || name === "build_vault_swap") && args.dex) {
            const dexArg = String(args.dex).toLowerCase();
            detectedDex = (dexArg === "uniswap") ? "Uniswap" : "0x";
          } else if ((name === "get_swap_quote" || name === "build_vault_swap") && !args.dex) {
            detectedDex = "Uniswap";
          } else if (name.startsWith("gmx_")) {
            detectedDex = "GMX";
          }
        } catch (err) {
          // Extract the most informative error string from viem/RPC errors.
          // Viem wraps errors in multiple layers:
          //   EstimateGasExecutionError → CallExecutionError → ExecutionRevertedError → RpcRequestError
          // The revert data (4-byte selector) is on RpcRequestError.data, 3+ levels deep.
          // The top-level .message is often just "Execution reverted for an unknown reason."
          let rawMsg: string;
          if (err instanceof Error) {
            // Walk the full cause chain to find revert data or a meaningful message
            let revertData: string | undefined;
            let bestMessage: string | undefined;
            let e: any = err;
            while (e) {
              // RpcRequestError.data contains raw hex revert data
              if (e.data && typeof e.data === 'string' && e.data.startsWith('0x')) {
                revertData = e.data;
                break;
              }
              // Collect the deepest meaningful message
              if (e.shortMessage && !e.shortMessage.includes('unknown reason')) {
                bestMessage = e.shortMessage;
              } else if (e.details && !e.details.includes('unknown reason')) {
                bestMessage = e.details;
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
      console.log(`[LLM] Autonomous follow-up call (fast: ${fastModel}) round ${round}/${MAX_AUTONOMOUS_ROUNDS}`);
      onStreamEvent?.({ type: "status", message: `Planning next step (round ${round + 1})…` });
      const followUp = await callLLM({
        model: fastModel,
        messages: withRuntimeContext(toolMessages),
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      });
      const followUpChoice = followUp.choices[0];
      if (!followUpChoice) {
        break;
      }

      // Stream the model's plan/thinking text so the user sees what it decided.
      // This replaces the old "Continuing plan…" hardcoded message.
      const followUpReasoning = (followUp as any)._reasoning as string | undefined;
      if (followUpReasoning) {
        onStreamEvent?.({ type: "reasoning", content: followUpReasoning });
      }
      const followUpText = followUpChoice.message.content?.trim();
      if (followUpText) {
        // Suppress text that just echoes an already-shown error (prevents 3x+ duplication)
        const isErrorEcho = /^(error:|insufficient|.*revert|.*failed)/i.test(followUpText);
        const isRepeatOfToolResult = toolCallResults.some(
          tc => tc.error && tc.result && followUpText.includes(tc.result.replace(/^Error:\s*/i, '').slice(0, 50)),
        );
        if (!isErrorEcho && !isRepeatOfToolResult && !looksLikeToolCallText(followUpText)) {
          onStreamEvent?.({ type: "text", content: followUpText });
        }
      }

      currentMessage = followUpChoice.message;
      if (!currentMessage.tool_calls || currentMessage.tool_calls.length === 0) {
        finalModel = fastModel;
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

  // DeepSeek-first fallback: if first-pass model didn't emit tool calls but the
  // user intent matches a deterministic command, execute fast-path now.
  if (deferredFastPath) {
    console.log(`[LLM] Deferred fast-path after first model pass: ${deferredFastPath.name}`);
    let fpDex: string | undefined;
    if (deferredFastPath.name.startsWith("gmx_")) fpDex = "GMX";
    if (deferredFastPath.name === "get_lp_positions") fpDex = "Uniswap";
    if (deferredFastPath.name === "build_vault_swap" || deferredFastPath.name === "get_swap_quote") {
      const dexArg = String((deferredFastPath.args as Record<string, unknown>).dex || "uniswap").toLowerCase();
      fpDex = dexArg === "0x" ? "0x" : "Uniswap";
    }
    try {
      const toolResult = await executeToolCall(env, ctx, deferredFastPath.name, deferredFastPath.args);
      return {
        reply: toolResult.message,
        toolCalls: [{ name: deferredFastPath.name, arguments: deferredFastPath.args, result: toolResult.message, error: false }],
        transaction: toolResult.transaction,
        chainSwitch: toolResult.chainSwitch,
        suggestions: toolResult.suggestions,
        dexProvider: fpDex,
        reasoning: reasoning || fastPathReasoning,
        modelsUsed,
        finalModel: "tooling",
      };
    } catch (err) {
      // Don't silently swallow — return the error so the user knows why the swap failed.
      const rawMsg = err instanceof Error ? err.message : String(err);
      const friendly = friendlyError(sanitizeError(rawMsg));
      console.log(`[LLM] Deferred fast-path error: ${friendly}`);
      return {
        reply: friendly,
        toolCalls: [{ name: deferredFastPath.name, arguments: deferredFastPath.args, result: `Error: ${friendly}`, error: true }],
        dexProvider: fpDex,
        reasoning: reasoning || fastPathReasoning,
        modelsUsed,
        finalModel: "tooling",
      };
    }
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
 * Fallback gas limits when on-chain estimation fails.
 *
 * IMPORTANT: RigoBlock vault proxy adds significant overhead on top of the
 * raw DEX swap gas — adapter routing, on-chain checks, and (for the first
 * swap of a given token) an ERC-20 approval via the vault's internal
 * approval logic. For tokenized stocks (XAUT, PAXG, etc.) the token
 * contracts themselves have extra transfer hooks that increase gas further.
 *
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
async function estimateGas(
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
  const estimated = await client.estimateGas({
    account: from,
    to,
    data,
    value: txValue,
  });
  // 20% buffer — covers execution-time variance (adapter routing, internal
  // approvals, oracle reads). The on-chain estimate is already accurate for
  // the vault proxy overhead since we estimate from the actual sender.
  const buffered = estimated + (estimated * 20n) / 100n;
  console.log(`[estimateGas] chain=${chainId} raw=${estimated} buffered=${buffered}`);
  return `0x${buffered.toString(16)}`;
}

export interface ToolResult {
  message: string;
  transaction?: UnsignedTransaction;
  chainSwitch?: number;
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
  /** When true, the message is a complete report — skip the follow-up LLM call */
  selfContained?: boolean;
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
async function preCheckNavImpact(
  env: Env,
  ctx: RequestContext,
  tx: UnsignedTransaction,
): Promise<void> {
  if (!ctx.operatorAddress) return; // Can't simulate without caller address

  try {
    const result = await checkNavImpact(
      ctx.vaultAddress as Address,
      tx.data as Hex,
      BigInt(tx.value || "0x0"),
      tx.chainId,
      env.ALCHEMY_API_KEY,
      ctx.operatorAddress as Address,
      env.KV,
    );

    if (!result.allowed) {
      const reason = result.code === "TRADE_REVERTS"
        ? `Transaction simulation failed — the transaction would revert on-chain. ${result.reason || ""}`
        : `NAV shield blocked: this trade would reduce vault unit value by ${result.dropPct}% ` +
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
    // Re-throw NAV shield blocks and simulation failures
    if (err instanceof Error && (
      err.message.includes("NAV shield blocked") ||
      err.message.includes("simulation failed")
    )) {
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
      throw new Error("Wallet not connected. Connect your wallet first.");
    }
    if (!ctx.operatorVerified) {
      throw new Error("Operator authentication required. Please verify your wallet first.");
    }
  }

  switch (resolvedName) {
    case "get_swap_quote": {
      // Auto-switch chain if specified
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      // Resolve slippage: request body → KV stored default → 100 bps
      const resolvedSlippage = await resolveSlippage(env, ctx);

      const intent: SwapIntent = {
        tokenIn: args.tokenIn as string,
        tokenOut: args.tokenOut as string,
        amountIn: args.amountIn as string | undefined,
        amountOut: args.amountOut as string | undefined,
        slippageBps: resolvedSlippage,
      };
      if (!intent.amountIn && !intent.amountOut) {
        throw new Error("Either amountIn or amountOut must be specified.");
      }
      // XAUT (Tether Gold) only exists on Arbitrum (42161) and Ethereum (1).
      // Reject immediately if the LLM tries to quote it on any other chain.
      if (
        /xaut/i.test(intent.tokenIn) || /xaut/i.test(intent.tokenOut) ||
        intent.tokenIn === "0x40461291347e1eCbb09499F3371D3f17f10d7159" ||
        intent.tokenOut === "0x40461291347e1eCbb09499F3371D3f17f10d7159" ||
        intent.tokenIn === "0x68749665FF8D2d112Fa859AA293F07A622782F38" ||
        intent.tokenOut === "0x68749665FF8D2d112Fa859AA293F07A622782F38"
      ) {
        if (ctx.chainId !== 1 && ctx.chainId !== 42161) {
          throw new Error(
            `XAUT (Tether Gold) is only available on Arbitrum (chain 42161) and Ethereum (chain 1). ` +
            `Current chain: ${resolveChainName(ctx.chainId)} (${ctx.chainId}). ` +
            `Switch to Arbitrum first, then retry the swap.`,
          );
        }
      }
      const dex = ((args.dex as string) || "0x").toLowerCase();
      if (dex === "0x" || dex === "zerox") {
        const quote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress);
        return { message: formatZeroXQuoteForDisplay(intent, quote), chainSwitch: chainSwitched };
      }
      const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);
      return { message: formatUniswapQuoteForDisplay(intent, quote), chainSwitch: chainSwitched };
    }

    case "build_vault_swap": {
      // Verify operator is connected
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      // Auto-switch chain if specified
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      // Resolve slippage: request body → KV stored default → 100 bps
      const resolvedSlippage = await resolveSlippage(env, ctx);

      const intent: SwapIntent = {
        tokenIn: args.tokenIn as string,
        tokenOut: args.tokenOut as string,
        amountIn: args.amountIn as string | undefined,
        amountOut: args.amountOut as string | undefined,
        slippageBps: resolvedSlippage,
      };
      if (!intent.amountIn && !intent.amountOut) {
        throw new Error("Either amountIn or amountOut must be specified.");
      }
      // XAUT (Tether Gold) only exists on Arbitrum (42161) and Ethereum (1).
      // Hard reject here so the LLM can't accidentally execute on the wrong chain.
      if (
        /xaut/i.test(intent.tokenIn) || /xaut/i.test(intent.tokenOut) ||
        intent.tokenIn === "0x40461291347e1eCbb09499F3371D3f17f10d7159" ||
        intent.tokenOut === "0x40461291347e1eCbb09499F3371D3f17f10d7159" ||
        intent.tokenIn === "0x68749665FF8D2d112Fa859AA293F07A622782F38" ||
        intent.tokenOut === "0x68749665FF8D2d112Fa859AA293F07A622782F38"
      ) {
        if (ctx.chainId !== 1 && ctx.chainId !== 42161) {
          throw new Error(
            `XAUT (Tether Gold) is only available on Arbitrum (chain 42161) and Ethereum (chain 1). ` +
            `Current chain: ${resolveChainName(ctx.chainId)} (${ctx.chainId}). ` +
            `Switch to Arbitrum first, then retry the swap.`,
          );
        }
      }

      // Ownership already verified by auth layer (verifyOperatorAuth checks
      // all supported chains). Skipping redundant on-chain owner() call here
      // avoids an extra RPC round-trip and prevents errors when the vault
      // contract doesn't exist on the currently-selected chain.

      // Resolve chain name for display
      const chainName = resolveChainName(ctx.chainId);

      // ── Balance pre-check for exact-input swaps ──
      // Prevents wasting time on DEX API calls and confusing the user with
      // transactions that would inevitably revert (insufficient balance).
      if (intent.amountIn) {
        try {
          const sellAddr = await resolveTokenAddress(ctx.chainId, intent.tokenIn);
          const { balance, decimals, symbol } = await getVaultTokenBalance(
            ctx.chainId, ctx.vaultAddress as Address, sellAddr as Address, env.ALCHEMY_API_KEY,
          );
          const requestedRaw = parseUnits(intent.amountIn, decimals);
          if (requestedRaw > balance) {
            const available = formatUnits(balance, decimals);
            throw new Error(
              `Insufficient ${symbol} balance. ` +
              `Requested: ${intent.amountIn} ${symbol}, ` +
              `Available: ${available} ${symbol} on ${chainName}. ` +
              `Use a smaller amount or bridge more ${symbol} to this chain first.`,
            );
          }
        } catch (err) {
          // Re-throw balance errors; swallow resolution errors (let DEX handle)
          if (err instanceof Error && err.message.includes("Insufficient")) throw err;
        }
      }

      // Determine which DEX to use
      const dex = ((args.dex as string) || "0x").toLowerCase();

      if (dex === "0x" || dex === "zerox") {
        // ── 0x AllowanceHolder flow ──
        const zxQuote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress);

        // ── Swap Shield — oracle price check ──
        await runSwapShield(
          env, ctx, intent,
          zxQuote.sellAmount, zxQuote.decimalsIn,
          zxQuote.buyAmount,
        );

        // The 0x API returns a complete transaction targeting AllowanceHolder.
        // For the vault, we send the 0x calldata TO the vault address.
        // The vault's 0x adapter (when built) will route it through AllowanceHolder.
        const outputAmount = formatRawAmount(zxQuote.buyAmount, zxQuote.decimalsOut);
        const inputAmount = formatRawAmount(zxQuote.sellAmount, zxQuote.decimalsIn);
        const isExactOutput = !!intent.amountOut;
        // For 0x, even when user requested exact output, the swap is always exact-input internally.
        // The sell amount was estimated via the 0x price endpoint.
        const is0xEstimated = isExactOutput;

        // Derive implied price
        const sellNum = parseFloat(inputAmount);
        const buyNum = parseFloat(outputAmount);
        let priceLine = "";
        if (sellNum > 0 && buyNum > 0) {
          priceLine = `Price: 1 ${intent.tokenIn} = ${(buyNum / sellNum).toFixed(6)} ${intent.tokenOut}`;
        }

        const sellDesc = intent.amountIn
          ? `${intent.amountIn} ${intent.tokenIn}`
          : `~${inputAmount} ${intent.tokenIn}`;
        const buyDesc = `~${outputAmount} ${intent.tokenOut}`;
        const descParts = [`[0x] Sell ${sellDesc} for ${buyDesc}`];
        if (priceLine) descParts.push(priceLine);

        const zxGas = await estimateGas(
          ctx.chainId, ctx.vaultAddress as Address,
          zxQuote.transaction.data as Hex, "0x0",
          ctx.operatorAddress, env.ALCHEMY_API_KEY, "swap",
        );

        const transaction: UnsignedTransaction = {
          to: ctx.vaultAddress as Address,
          data: zxQuote.transaction.data,
          value: "0x0", // vault uses its own ETH, never pass value
          chainId: ctx.chainId,
          gas: zxGas,
          description: descParts.join(" | "),
          swapMeta: {
            sellAmount: inputAmount,
            sellToken: intent.tokenIn,
            buyAmount: outputAmount,
            buyToken: intent.tokenOut,
            price: sellNum > 0 && buyNum > 0
              ? `1 ${intent.tokenIn} = ${(buyNum / sellNum).toFixed(6)} ${intent.tokenOut}`
              : "",
            dex: "0x Aggregator",
          },
          navShieldChecked: true,
        };

        const sellLine = is0xEstimated
          ? `Sell: ~${inputAmount} ${intent.tokenIn} (estimated for ~${intent.amountOut} ${intent.tokenOut})`
          : `Sell: ${intent.amountIn} ${intent.tokenIn}`;
        const buyLine = `Buy: ~${outputAmount} ${intent.tokenOut}`;

        const message = [
          "✅ Swap ready (0x Aggregator)",
          sellLine,
          buyLine,
          ...(priceLine ? [priceLine] : []),
          `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
          `Chain: ${chainName}`,
          `Gas limit: ${parseInt(zxGas, 16)}`,
        ].join("\n");

        // Enforce NAV shield before returning unsigned calldata on direct tool calls.
        await preCheckNavImpact(env, ctx, transaction);

        return { message, transaction, chainSwitch: chainSwitched };
      }

      // ── Uniswap flow (default) ──

      // 2. Get quote from Uniswap Trading API
      const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);

      // ── Swap Shield — oracle price check ──
      if (quote.quote.input?.amount && quote.quote.output?.amount) {
        await runSwapShield(
          env, ctx, intent,
          quote.quote.input.amount, quote.decimalsIn,
          quote.quote.output.amount,
        );
      }

      // ── Balance pre-check for exact-output swaps ──
      // For exact-output, we only know required input after the quote. Check here
      // before calling the heavier swapCalldata endpoint to give a clear error.
      if (intent.amountOut && quote.quote.input?.amount) {
        try {
          const sellAddr = await resolveTokenAddress(ctx.chainId, intent.tokenIn);
          const { balance, symbol } = await getVaultTokenBalance(
            ctx.chainId, ctx.vaultAddress as Address, sellAddr as Address, env.ALCHEMY_API_KEY,
          );
          const requiredIn = BigInt(quote.quote.input.amount);
          if (requiredIn > balance) {
            const available = formatUnits(balance, quote.decimalsIn);
            const needed = formatUnits(requiredIn, quote.decimalsIn);
            throw new Error(
              `Insufficient ${symbol} balance. ` +
              `Need ~${needed} ${symbol} to buy ${intent.amountOut} ${intent.tokenOut}, ` +
              `but vault only has ${available} ${symbol} on ${chainName}. ` +
              `Use a smaller amount or bridge more ${symbol} to this chain first.`,
            );
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("Insufficient")) throw err;
        }
      }

      // 3. Get executable swap calldata from Uniswap Trading API
      const swapTx = await getUniswapSwapCalldata(env, quote._raw);

      // 4. Decode the Universal Router execute(commands, inputs, deadline) calldata
      const decoded = decodeFunctionData({
        abi: RIGOBLOCK_VAULT_ABI,
        data: swapTx.data,
      });

      if (decoded.functionName !== "execute") {
        throw new Error(
          `Unexpected function from Uniswap API: ${decoded.functionName}. Expected execute().`,
        );
      }

      // 5. Re-encode as a call to the vault's execute()
      let vaultCalldata: Hex;
      const decodedArgs = decoded.args as unknown as unknown[];
      if (decodedArgs.length === 3) {
        vaultCalldata = encodeVaultExecute(
          decodedArgs[0] as Hex,
          decodedArgs[1] as Hex[],
          decodedArgs[2] as bigint,
        );
      } else {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
        vaultCalldata = encodeVaultExecute(
          decodedArgs[0] as Hex,
          decodedArgs[1] as Hex[],
          deadline,
        );
      }

      // The operator calls vault.execute() — the vault uses its OWN ETH balance.
      // Value is always 0 regardless of what Uniswap API returns.

      const outputAmount = quote.quote.output?.amount
        ? formatRawAmount(quote.quote.output.amount, quote.decimalsOut)
        : "?";
      const inputAmount = quote.quote.input?.amount
        ? formatRawAmount(quote.quote.input.amount, quote.decimalsIn)
        : "?";

      const isExactOutput = !!intent.amountOut;

      // Derive implied price
      const sellNum = parseFloat(inputAmount);
      const buyNum = parseFloat(outputAmount);
      let priceLine = "";
      if (sellNum > 0 && buyNum > 0) {
        priceLine = `Price: 1 ${intent.tokenIn} = ${(buyNum / sellNum).toFixed(6)} ${intent.tokenOut}`;
      }

      const descParts = [
        isExactOutput
          ? `[Uniswap] Buy ${intent.amountOut} ${intent.tokenOut} with ~${inputAmount} ${intent.tokenIn}`
          : `[Uniswap] Sell ${intent.amountIn} ${intent.tokenIn} for ~${outputAmount} ${intent.tokenOut}`,
      ];
      if (priceLine) descParts.push(priceLine);

      // 7. Build the unsigned transaction for the frontend
      const uniGas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        vaultCalldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "swap",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: vaultCalldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas: uniGas,
        description: descParts.join(" | "),
        swapMeta: {
          sellAmount: inputAmount,
          sellToken: intent.tokenIn,
          buyAmount: outputAmount,
          buyToken: intent.tokenOut,
          price: sellNum > 0 && buyNum > 0
            ? `1 ${intent.tokenIn} = ${(buyNum / sellNum).toFixed(6)} ${intent.tokenOut}`
            : "",
          dex: "Uniswap",
        },
        navShieldChecked: true,
      };

      const sellLine = isExactOutput
        ? `Sell: ~${inputAmount} ${intent.tokenIn} (estimated)`
        : `Sell: ${intent.amountIn} ${intent.tokenIn}`;
      const buyLine = isExactOutput
        ? `Buy: ${intent.amountOut} ${intent.tokenOut}`
        : `Buy: ~${outputAmount} ${intent.tokenOut}`;

      const message = [
        "✅ Swap ready (Uniswap)",
        sellLine,
        buyLine,
        ...(priceLine ? [priceLine] : []),
        `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
        `Chain: ${chainName}`,
        `Gas limit: ${parseInt(uniGas, 16)}`,
      ].join("\n");

      // Enforce NAV shield before returning unsigned calldata on direct tool calls.
      await preCheckNavImpact(env, ctx, transaction);

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "get_vault_info": {
      const info = await getVaultInfo(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);

      // Fetch NAV data for richer display
      const navInfo = await getNavData(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY)
        .catch(() => null);

      const decimals = info.decimals ?? 18;
      const supplyFormatted = parseFloat(info.totalSupply).toFixed(4);
      const unitaryFormatted = navInfo
        ? (Number(navInfo.unitaryValue) / (10 ** decimals)).toFixed(6)
        : "N/A";
      const totalValueFormatted = navInfo
        ? (Number(navInfo.totalValue) / (10 ** decimals)).toFixed(6)
        : "N/A";

      const chainLabel = resolveChainName(ctx.chainId);

      return {
        message: [
          `**${info.name}** (${info.symbol}) on ${chainLabel}`,
          `Supply: ${supplyFormatted} | Unitary value: ${unitaryFormatted} | Total value: ${totalValueFormatted}`,
        ].join("\n"),
        selfContained: true,
      };
    }

    case "get_token_balance": {
      const tokenAddress = await resolveTokenAddress(
        ctx.chainId,
        args.token as string,
      );
      const { balance, decimals, symbol } = await getVaultTokenBalance(
        ctx.chainId,
        ctx.vaultAddress as Address,
        tokenAddress as Address,
        env.ALCHEMY_API_KEY,
      );
      const formatted = Number(balance) / 10 ** decimals;
      return { message: `Vault holds ${formatted.toFixed(6)} ${symbol}`, selfContained: true };
    }

    case "verify_bridge_arrival": {
      const tokenArg = args.token as string;
      const chainArg = args.chain as string;
      const minAmountStr = args.minAmount as string;

      const targetChainId = resolveChainArg(chainArg.trim()).id;
      const targetChainName = resolveChainName(targetChainId);
      const tokenAddress = await resolveTokenAddress(targetChainId, tokenArg);
      const minAmount = parseFloat(minAmountStr);

      // Snapshot balance BEFORE polling — so we detect actual increase,
      // not a pre-existing balance that already exceeds minAmount.
      const { balance: initialBal, decimals, symbol } = await getVaultTokenBalance(
        targetChainId,
        ctx.vaultAddress as Address,
        tokenAddress as Address,
        env.ALCHEMY_API_KEY,
      );
      const initialAmount = Number(initialBal) / 10 ** decimals;

      const MAX_POLLS = 10;    // 10 × 3s = 30s max
      const POLL_INTERVAL = 3000;

      for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        }
        const { balance } = await getVaultTokenBalance(
          targetChainId,
          ctx.vaultAddress as Address,
          tokenAddress as Address,
          env.ALCHEMY_API_KEY,
        );
        const current = Number(balance) / 10 ** decimals;
        const increase = current - initialAmount;
        if (increase >= minAmount * 0.90) {
          // Accept if increase is ≥ 90% of expected (bridge fees reduce the output)
          return {
            message: `✅ Bridge complete! ${increase.toFixed(6)} ${symbol} arrived on ${targetChainName} (vault now holds ${current.toFixed(6)} ${symbol}). Ready to proceed.`,
          };
        }
      }

      // Timed out — funds may still be in transit
      const { balance: finalBal } = await getVaultTokenBalance(
        targetChainId,
        ctx.vaultAddress as Address,
        tokenAddress as Address,
        env.ALCHEMY_API_KEY,
      );
      const finalAmount = Number(finalBal) / 10 ** decimals;
      const totalIncrease = finalAmount - initialAmount;
      return {
        message: `⏳ Bridge still in progress after 30s. Balance increased by ${totalIncrease.toFixed(6)} ${symbol} on ${targetChainName} (current: ${finalAmount.toFixed(6)}, expected increase ≥${minAmountStr}). The bridge may take longer — Across fills can take minutes. Check the balance again after waiting.`,
      };
    }

    case "switch_chain": {
      const match = resolveChainArg((args.chain as string).trim());
      return {
        message: `Switched to ${match.name} (chain ${match.id}). All subsequent operations will use this chain.`,
        chainSwitch: match.id,
      };
    }

    // ── Trading Settings ────────────────────────────────────────────

    case "set_default_slippage": {
      const raw = String(args.slippage ?? "").trim();
      let bps: number;
      const percentMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/i);
      const bpsMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*bps$/i);
      const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
      if (percentMatch) {
        const num = parseFloat(percentMatch[1]);
        if (isNaN(num) || num <= 0) {
          throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
        }
        bps = Math.round(num * 100);
      } else if (bpsMatch) {
        const num = parseFloat(bpsMatch[1]);
        if (isNaN(num) || num <= 0) {
          throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
        }
        bps = Math.round(num);
      } else if (plainMatch) {
        const num = parseFloat(plainMatch[1]);
        if (isNaN(num) || num <= 0) {
          throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
        }
        // Integers within the configured BPS range are treated as bps (e.g. "50" => 50 bps = 0.5%)
        // Small decimals and values outside BPS range are treated as percentages (e.g. "0.5" => 50 bps)
        if (Number.isInteger(num) && num >= MIN_SLIPPAGE_BPS && num <= MAX_SLIPPAGE_BPS) {
          bps = Math.round(num);
        } else {
          bps = Math.round(num * 100);
        }
      } else {
        throw new Error("Invalid slippage value. Use a positive number, optionally suffixed with '%' or 'bps' (e.g., '0.5%', '50bps', or '0.5').");
      }
      if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
        throw new Error(
          `Slippage must be between ${MIN_SLIPPAGE_BPS / 100}% and ${MAX_SLIPPAGE_BPS / 100}%. ` +
          `Got: ${bps / 100}% (${bps} bps).`,
        );
      }
      await setStoredSlippage(env.KV, ctx.operatorAddress!, bps);
      return {
        message: `✅ Default slippage set to ${bps / 100}% (${bps} bps). This applies to all future swaps until changed.`,
      };
    }

    case "disable_swap_shield": {
      await disableSwapShield(
        env.KV,
        ctx.operatorAddress!,
        ctx.vaultAddress as string,
      );
      return {
        message:
          "⚠️ Swap Shield disabled for 10 minutes. During this time, swaps will NOT be checked " +
          "against oracle prices. The shield will re-enable automatically.\n\n" +
          "The NAV shield (10% max loss) still protects against catastrophic trades.",
      };
    }

    case "enable_swap_shield": {
      await enableSwapShield(
        env.KV,
        ctx.operatorAddress!,
        ctx.vaultAddress as string,
      );
      return {
        message: "✅ Swap Shield re-enabled. All swaps will be checked against oracle prices.",
      };
    }

    // ── GMX Perpetuals ──────────────────────────────────────────────

    case "gmx_open_position":
    case "gmx_increase_position": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      // Auto-switch to Arbitrum if needed
      let chainSwitched: number | undefined;
      if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
        ctx.chainId = ARBITRUM_CHAIN_ID;
        chainSwitched = ARBITRUM_CHAIN_ID;
      }

      const marketSymbol = (args.market as string).toUpperCase();
      const isLong = args.isLong as boolean;
      const collateralSymbol = (args.collateral as string) || "USDC";

      // Find market and get prices
      const market = await findGmxMarket(marketSymbol);
      const collateralAddr = await resolveGmxCollateral(collateralSymbol);
      const collateralDecimals = getGmxTokenDecimals(collateralAddr);
      const [collateralPrice, indexTokenPrice] = await Promise.all([
        getGmxTokenPrice(collateralAddr),
        getGmxTokenPrice(market.indexToken),
      ]);

      // Determine collateralAmount and sizeDeltaUsd.
      // Three modes:
      //   A) notionalUsd + leverage → collateral = notional / leverage, size = notional
      //   B) collateralAmount + leverage → size = collateralValue * leverage
      //   C) collateralAmount + sizeDeltaUsd → explicit
      let collateralAmount: string;
      let sizeDeltaUsd: string;

      if (args.notionalUsd && args.leverage) {
        // Mode A: "long 1000 ETHUSDC 5x" → notionalUsd=1000, leverage=5
        const notional = parseFloat(args.notionalUsd as string);
        const leverageNum = parseFloat(args.leverage as string);
        sizeDeltaUsd = notional.toFixed(2);
        const collateralValueUsd = notional / leverageNum;
        // Convert USD value to collateral token units
        collateralAmount = (collateralValueUsd / collateralPrice.mid).toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
      } else if (args.collateralAmount) {
        collateralAmount = args.collateralAmount as string;
        if (args.sizeDeltaUsd && (args.sizeDeltaUsd as string) !== "") {
          sizeDeltaUsd = args.sizeDeltaUsd as string;
        } else if (args.leverage) {
          const leverageNum = parseFloat(args.leverage as string);
          const collateralValueUsd = parseFloat(collateralAmount) * collateralPrice.mid;
          sizeDeltaUsd = (collateralValueUsd * leverageNum).toFixed(2);
        } else {
          // Default 2x leverage
          const collateralValueUsd = parseFloat(collateralAmount) * collateralPrice.mid;
          sizeDeltaUsd = (collateralValueUsd * 2).toFixed(2);
        }
      } else if (args.notionalUsd) {
        // notionalUsd without leverage → default 2x
        const notional = parseFloat(args.notionalUsd as string);
        sizeDeltaUsd = notional.toFixed(2);
        const collateralValueUsd = notional / 2;
        collateralAmount = (collateralValueUsd / collateralPrice.mid).toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
      } else {
        throw new Error("Please specify either collateralAmount or notionalUsd for the position.");
      }

      // ── Pre-checks ────────────────────────────────────────────────────

      // 1. Check vault native ETH balance for GMX keeper fee.
      //    AGmxV2._ensureWeth() wraps vault ETH → WETH to pay the GMX
      //    execution fee before creating the order. Without ETH the tx reverts.
      //    Instead of throwing an error, build a stablecoin→ETH swap and return
      //    it so the user signs one transaction and then retries.
      //    We check USDC and USDT balances first to pick the token actually in
      //    the vault (avoids NAV shield simulation failure from missing balance).
      const NATIVE_ZERO = "0x0000000000000000000000000000000000000000" as Address;
      const MIN_KEEPER_ETH = 1_000_000_000_000_000n; // 0.001 ETH
      // Arbitrum stablecoin addresses — used only for balance disambiguation
      const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
      const USDT_ARBITRUM = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address;
      try {
        const { balance: ethBal } = await getVaultTokenBalance(
          ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, NATIVE_ZERO, env.ALCHEMY_API_KEY,
        );
        if (ethBal < MIN_KEEPER_ETH) {
          const ethBalFmt = formatUnits(ethBal, 18);
          console.log(`[gmx_open_position] Vault has ${ethBalFmt} ETH — below keeper minimum. Building ETH swap.`);

          // Find the stablecoin with the largest balance that can fund the swap.
          // USDC is preferred (primary carry-trade token on Arbitrum).
          const [usdcBal, usdtBal] = await Promise.all([
            getVaultTokenBalance(ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, USDC_ARBITRUM, env.ALCHEMY_API_KEY)
              .catch(() => ({ balance: 0n })),
            getVaultTokenBalance(ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, USDT_ARBITRUM, env.ALCHEMY_API_KEY)
              .catch(() => ({ balance: 0n })),
          ]);

          // Pick the stablecoin with more balance (USDC wins ties)
          const stableIn = usdcBal.balance >= usdtBal.balance && usdcBal.balance > 0n
            ? "USDC"
            : usdtBal.balance > 0n ? "USDT" : null;

          if (!stableIn) {
            throw new Error(
              `The vault needs ETH to pay the GMX keeper execution fee ` +
              `(current: ${ethBalFmt} ETH) but has no USDC or USDT to swap for ETH. ` +
              `Send at least 0.005 ETH to the vault (${ctx.vaultAddress}) and retry.`,
            );
          }

          console.log(`[gmx_open_position] Building ${stableIn}→ETH swap (vault stableBalance: USDC=${usdcBal.balance}, USDT=${usdtBal.balance})`);
          try {
            const savedChainId = ctx.chainId;
            ctx.chainId = ARBITRUM_CHAIN_ID;
            const ethSwapResult = await executeToolCall(env, ctx, "build_vault_swap", {
              tokenIn: stableIn,
              tokenOut: "ETH",
              amountOut: "0.002",   // 0.002 ETH ≈ ~$4 at current price — minimal to cover keeper fee
              chain: "arbitrum",
            });
            ctx.chainId = savedChainId;
            return {
              message:
                `⚠️ **ETH required for GMX keeper fee**\n` +
                `Vault ETH balance: ${ethBalFmt} ETH (need ≥ 0.001 ETH)\n\n` +
                `Sign the swap below to get 0.002 ETH, then resubmit your GMX position.\n\n` +
                ethSwapResult.message,
              transaction: ethSwapResult.transaction,
              chainSwitch: ARBITRUM_CHAIN_ID !== savedChainId ? ARBITRUM_CHAIN_ID : undefined,
            };
          } catch (swapErr) {
            // Swap build failed — give a clear manual instruction
            throw new Error(
              `The vault needs ETH to pay the GMX keeper execution fee. ` +
              `Current balance: ${ethBalFmt} ETH. ` +
              `Swap ${stableIn} → ETH first: build_vault_swap(tokenIn="${stableIn}", tokenOut="ETH", amountOut="0.002", chain="arbitrum"), ` +
              `then retry the GMX position.`,
            );
          }
        }
      } catch (err) {
        // Re-throw errors we generated above; swallow RPC failures (simulation will catch)
        if (err instanceof Error && (
          err.message.includes("keeper execution fee") ||
          err.message.includes("ETH required")
        )) throw err;
      }

      // 2. Balance pre-check: cap collateral to available vault balance.
      //    Rather than throwing and forcing the LLM to retry with random guesses,
      //    auto-scale both collateral and notional to what the vault actually holds.
      let cappedNote = "";
      try {
        const { balance: colBal } = await getVaultTokenBalance(
          ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, collateralAddr, env.ALCHEMY_API_KEY,
        );
        const requestedRaw = parseUnits(collateralAmount, collateralDecimals);
        if (requestedRaw > colBal) {
          const availableNum = parseFloat(formatUnits(colBal, collateralDecimals));
          if (availableNum < 0.5) {
            // Not enough for even a minimum GMX position (~$1 collateral)
            throw new Error(
              `Insufficient ${collateralSymbol} balance for GMX collateral. ` +
              `Requested: ${collateralAmount} ${collateralSymbol}, ` +
              `Available: ${availableNum.toFixed(6)} ${collateralSymbol} on Arbitrum. ` +
              `Swap more ${collateralSymbol} first.`,
            );
          }
          // Scale down: maintain same leverage, use all available collateral.
          const prevCollateral = parseFloat(collateralAmount);
          const scaleFactor = availableNum / prevCollateral;
          collateralAmount = availableNum.toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
          sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * scaleFactor).toFixed(2);
          cappedNote = `\n⚠️ Collateral capped to available balance: ${collateralAmount} ${collateralSymbol} (position size scaled proportionally to $${sizeDeltaUsd})`;
          console.log(`[gmx_open_position] Collateral auto-capped from ${prevCollateral} to ${collateralAmount} ${collateralSymbol}, notional → $${sizeDeltaUsd}`);
        }
      } catch (err) {
        if (err instanceof Error && (
          err.message.includes("Insufficient") ||
          err.message.includes("keeper")
        )) throw err;
        // RPC failure — proceed, on-chain execution will validate
      }

      const calldata = buildCreateIncreaseOrderCalldata({
        market: market.marketToken as Address,
        collateralToken: collateralAddr,
        collateralAmount,
        collateralDecimals,
        sizeDeltaUsd,
        isLong,
        indexTokenPriceUsd: indexTokenPrice.mid.toString(),
      });

      const leverage = args.leverage || (parseFloat(sizeDeltaUsd) / (parseFloat(collateralAmount) * collateralPrice.mid)).toFixed(1);
      const collateralValueUsdDisplay = (parseFloat(collateralAmount) * collateralPrice.mid).toFixed(2);

      const gmxGas = await estimateGas(
        ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
        calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: gmxGas,
        description: `[GMX] ${isLong ? "Long" : "Short"} ${marketSymbol} ${leverage}x — ${collateralAmount} ${collateralSymbol} collateral (~$${collateralValueUsdDisplay}), $${sizeDeltaUsd} size`,
      };

      const message = [
        `✅ GMX ${name === "gmx_increase_position" ? "Increase" : "Open"} Position ready`,
        `Direction: ${isLong ? "🟢 LONG" : "🔴 SHORT"} ${marketSymbol}/USD`,
        `Size (notional): $${parseFloat(sizeDeltaUsd).toLocaleString()}`,
        `Collateral: ${collateralAmount} ${collateralSymbol} (~$${collateralValueUsdDisplay})`,
        `Leverage: ~${leverage}x`,
        `Market: ${market.marketToken}`,
        `Chain: Arbitrum`,
        ``,
        `💡 Collateral is the amount deposited into the position. Size is the leveraged notional exposure.`,
        ...(cappedNote ? [cappedNote] : []),
      ].join("\n");

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "gmx_close_position": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
        ctx.chainId = ARBITRUM_CHAIN_ID;
        chainSwitched = ARBITRUM_CHAIN_ID;
      }

      const marketSymbol = (args.market as string).toUpperCase();
      const isLong = args.isLong as boolean;
      const market = await findGmxMarket(marketSymbol);

      // Resolve collateral from args or from position
      let collateralSymbol = (args.collateral as string) || "USDC";
      const collateralAddr = await resolveGmxCollateral(collateralSymbol);
      const collateralDecimals = getGmxTokenDecimals(collateralAddr);

      // Get index token price for slippage protection
      const indexTokenPrice = await getGmxTokenPrice(market.indexToken);

      // sizeDeltaUsd: "all" means close full position — find position size
      let sizeDeltaUsd = (args.sizeDeltaUsd as string) || "all";
      if (sizeDeltaUsd.toLowerCase() === "all") {
        // Query current positions to find size
        const positions = await getGmxPositions(ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
        const matchingPos = positions.find(
          (p) =>
            p.indexTokenSymbol.toUpperCase() === marketSymbol &&
            p.isLong === isLong,
        );
        if (matchingPos) {
          // Parse the sizeInUsd string ($X,XXX.XX format)
          sizeDeltaUsd = matchingPos.sizeInUsd.replace(/[\$,KM]/g, "");
          // Handle K/M suffixes
          if (matchingPos.sizeInUsd.includes("K")) sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * 1000).toString();
          if (matchingPos.sizeInUsd.includes("M")) sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * 1000000).toString();
          collateralSymbol = matchingPos.collateralSymbol;
        } else {
          throw new Error(`No open ${isLong ? "long" : "short"} ${marketSymbol} position found.`);
        }
      }

      const collateralDelta = (args.collateralDeltaAmount as string) || "0";

      // Resolve order type
      let orderType = GmxOrderType.MarketDecrease;
      const orderTypeStr = ((args.orderType as string) || "market").toLowerCase();
      if (orderTypeStr === "limit") orderType = GmxOrderType.LimitDecrease;
      else if (orderTypeStr === "stop_loss" || orderTypeStr === "stoploss") orderType = GmxOrderType.StopLossDecrease;

      const calldata = buildCreateDecreaseOrderCalldata({
        market: market.marketToken as Address,
        collateralToken: collateralAddr,
        collateralDeltaAmount: collateralDelta,
        collateralDecimals,
        sizeDeltaUsd,
        isLong,
        orderType,
        triggerPriceUsd: args.triggerPrice as string | undefined,
        indexTokenPriceUsd: indexTokenPrice.mid.toString(),
        acceptablePriceUsd: args.acceptablePrice as string | undefined,
      });

      const orderLabel = orderTypeStr === "limit" ? "Limit Decrease" : orderTypeStr.includes("stop") ? "Stop-Loss" : "Market Close";

      const gmxDecGas = await estimateGas(
        ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
        calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: gmxDecGas,
        description: `[GMX] ${orderLabel} ${isLong ? "Long" : "Short"} ${marketSymbol} — $${sizeDeltaUsd} size`,
      };

      const message = [
        `✅ GMX ${orderLabel} ready`,
        `Direction: ${isLong ? "LONG" : "SHORT"} ${marketSymbol}/USD`,
        `Size to close: $${parseFloat(sizeDeltaUsd).toLocaleString()}`,
        `Collateral withdraw: ${collateralDelta} ${collateralSymbol}`,
        ...(args.triggerPrice ? [`Trigger: $${args.triggerPrice}`] : []),
        `Order type: ${orderLabel}`,
        `Chain: Arbitrum`,
      ].join("\n");

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "gmx_get_positions": {
      // Auto-switch to Arbitrum
      let chainSwitched: number | undefined;
      if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
        ctx.chainId = ARBITRUM_CHAIN_ID;
        chainSwitched = ARBITRUM_CHAIN_ID;
      }

      const summary = await getGmxPositionsSummary(
        ctx.vaultAddress as Address,
        env.ALCHEMY_API_KEY,
      );

      // Build context-aware suggestions
      const suggestions: string[] = [];
      if (summary.positions.length > 0) {
        suggestions.push("Close position", "Add collateral", "Set stop-loss", "Open new position");
      } else {
        suggestions.push("Open a long", "Open a short", "Show GMX markets");
      }
      if (summary.pendingOrders.length > 0) {
        suggestions.push("Cancel order");
      }

      return { message: summary.formattedReport, chainSwitch: chainSwitched, suggestions };
    }

    case "gmx_cancel_order": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
        ctx.chainId = ARBITRUM_CHAIN_ID;
        chainSwitched = ARBITRUM_CHAIN_ID;
      }

      const orderKey = args.orderKey as Hex;
      const calldata = buildCancelOrderCalldata(orderKey);

      const cancelGas = await estimateGas(
        ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
        calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: cancelGas,
        description: `[GMX] Cancel order ${orderKey.slice(0, 10)}…`,
      };

      return {
        message: `✅ Cancel order ready\nOrder: ${orderKey}\nNote: GMX enforces a 300-second delay before cancellation.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "gmx_update_order": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
        ctx.chainId = ARBITRUM_CHAIN_ID;
        chainSwitched = ARBITRUM_CHAIN_ID;
      }

      const calldata = buildUpdateOrderCalldata({
        orderKey: args.orderKey as Hex,
        sizeDeltaUsd: args.sizeDeltaUsd as string,
        acceptablePriceUsd: args.acceptablePrice as string,
        triggerPriceUsd: args.triggerPrice as string,
      });

      const updateGas = await estimateGas(
        ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
        calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: updateGas,
        description: `[GMX] Update order ${(args.orderKey as string).slice(0, 10)}…`,
      };

      return {
        message: [
          "✅ Order update ready",
          `Order: ${args.orderKey}`,
          `New size: $${args.sizeDeltaUsd}`,
          `New trigger: $${args.triggerPrice}`,
          `New acceptable: $${args.acceptablePrice}`,
        ].join("\n"),
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "gmx_claim_funding_fees": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
        ctx.chainId = ARBITRUM_CHAIN_ID;
        chainSwitched = ARBITRUM_CHAIN_ID;
      }

      let claimMarkets = (args.markets as string[]) || [];
      let claimTokens = (args.tokens as string[]) || [];

      // Auto-detect from positions if not provided
      if (claimMarkets.length === 0) {
        const positions = await getGmxPositions(ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
        for (const p of positions) {
          claimMarkets.push(p.market);
          claimTokens.push(p.collateralToken);
        }
        if (claimMarkets.length === 0) {
          throw new Error("No open positions found to claim funding fees from.");
        }
      }

      const calldata = buildClaimFundingFeesCalldata({
        markets: claimMarkets as Address[],
        tokens: claimTokens as Address[],
      });

      const claimGas = await estimateGas(
        ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
        calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: claimGas,
        description: `[GMX] Claim funding fees from ${claimMarkets.length} market(s)`,
      };

      return {
        message: `✅ Claim funding fees ready\nMarkets: ${claimMarkets.length}\nTokens are sent to the vault.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "gmx_get_markets": {
      const [markets, tickers] = await Promise.all([
        getGmxMarkets(),
        getGmxTickers(),
      ]);

      const tickerMap = new Map<string, { symbol: string; price: number }>();
      for (const t of tickers) {
        const decimals = getGmxTokenDecimals(t.tokenAddress);
        const mid = (Number(BigInt(t.minPrice)) + Number(BigInt(t.maxPrice))) / 2 / (10 ** (30 - decimals));
        tickerMap.set(t.tokenAddress.toLowerCase(), { symbol: t.tokenSymbol, price: mid });
      }

      const seen = new Set<string>();
      const lines = ["📊 GMX v2 Available Markets (Arbitrum)", "─".repeat(40)];
      for (const m of markets) {
        const idx = tickerMap.get(m.indexToken.toLowerCase());
        if (!idx || seen.has(idx.symbol)) continue;
        seen.add(idx.symbol);
        // Strip version suffixes like .v2 for display
        const displaySymbol = idx.symbol.replace(/\.v\d+$/i, "");
        lines.push(`  ${displaySymbol}/USD — $${idx.price.toFixed(2)}`);
      }
      lines.push("─".repeat(40));
      lines.push(`Total: ${seen.size} markets`);

      return { message: lines.join("\n") };
    }

    // ── Delegation Management ─────────────────────────────────────────

    case "setup_delegation": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      // Handle optional chain switch
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const chainName = resolveChainName(ctx.chainId);

      // Check if delegation already exists — if so, this is an "update" (add missing selectors)
      const existingConfig = await getDelegationConfig(env.KV, ctx.vaultAddress as string);
      const isUpdate = existingConfig?.enabled && !!existingConfig.chains?.[String(ctx.chainId)];
      const existingSelectors = existingConfig?.chains?.[String(ctx.chainId)]?.delegatedSelectors || [];

      const result = await prepareDelegation(
        env,
        ctx.operatorAddress,
        ctx.vaultAddress as Address,
        ctx.chainId,
      );

      // Compute which selectors are new vs already delegated
      const existingSet = new Set(existingSelectors.map(s => s.toLowerCase()));
      const newSelectors = result.selectors.filter(s => !existingSet.has(s.toLowerCase()));

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        result.transaction.data as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "delegation",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.transaction.data,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: result.transaction.description,
        operatorOnly: true,
      };

      const message = isUpdate
        ? [
            "🔄 Delegation update ready",
            `Agent wallet: ${result.agentAddress}`,
            `New selectors: ${newSelectors.length} (total: ${result.selectors.length})`,
            `Chain: ${chainName}`,
            "",
            newSelectors.length > 0
              ? "Sign this transaction to add the missing selectors. No need to revoke first — this is additive."
              : "All selectors are already delegated. Sign to confirm the current state on-chain.",
          ].join("\n")
        : [
            "✅ Delegation setup ready",
            `Agent wallet: ${result.agentAddress}`,
            `Selectors: ${result.selectors.length} vault functions`,
            `Chain: ${chainName}`,
            "",
            "Sign this transaction to grant the agent permission to execute trades on your vault.",
            "Note: Delegation is per-chain. You'll need to set it up separately on each chain you want to use.",
          ].join("\n");

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "revoke_delegation": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      // Handle optional chain switch
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const chainName = resolveChainName(ctx.chainId);
      const revocation = await prepareRevocation(
        env,
        ctx.vaultAddress as Address,
        ctx.chainId,
      );

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        revocation.transaction.data as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "delegation",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: revocation.transaction.data,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: revocation.transaction.description,
        operatorOnly: true,
      };

      const message = [
        "✅ Revocation ready",
        `Chain: ${chainName}`,
        "",
        "Sign this transaction to revoke the agent's delegation on your vault.",
        "After this, the agent will no longer be able to execute trades automatically.",
      ].join("\n");

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "check_delegation_status": {
      // Handle optional chain switch
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const chainName = resolveChainName(ctx.chainId);

      // Check KV config
      const config = await getDelegationConfig(env.KV, ctx.vaultAddress as string);
      const walletInfo = await getAgentWalletInfo(env.KV, ctx.vaultAddress as string);

      if (!walletInfo?.address) {
        return {
          message: `No agent wallet has been created for this vault yet.\nUse "set up delegation" to get started.`,
          chainSwitch: chainSwitched,
          suggestions: ["Set up delegation"],
        };
      }

      // On-chain verification
      const selectors = buildDefaultSelectors();
      const onChain = await checkDelegationOnChain(
        ctx.chainId,
        ctx.vaultAddress as Address,
        walletInfo.address,
        selectors,
        env.ALCHEMY_API_KEY,
      );

      const kvActive = config?.enabled && !!config.chains?.[String(ctx.chainId)];
      const activeChains = config ? Object.keys(config.chains || {}).map(Number) : [];

      const lines = [
        `🔍 Delegation Status — ${chainName}`,
        "─".repeat(35),
        `Agent wallet: ${walletInfo.address}`,
        `On-chain: ${onChain.allDelegated ? "✅ Fully delegated" : `⚠️ ${onChain.delegatedSelectors.length}/${selectors.length} selectors delegated`}`,
        `KV state: ${kvActive ? "✅ Active" : "❌ Inactive"}`,
        `Active chains: ${activeChains.length > 0 ? activeChains.map(id => resolveChainName(id)).join(", ") : "None"}`,
      ];

      if (onChain.undelegatedSelectors.length > 0 && onChain.delegatedSelectors.length > 0) {
        lines.push("", `Missing selectors: ${onChain.undelegatedSelectors.length} — re-run delegation setup to fix.`);
      }

      const suggestions: string[] = [];
      if (!onChain.allDelegated) {
        suggestions.push("Set up delegation");
      } else {
        suggestions.push("Revoke delegation");
      }

      return { message: lines.join("\n"), chainSwitch: chainSwitched, suggestions };
    }

    // ── Pool Deployment ───────────────────────────────────────────────

    case "deploy_smart_pool": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      // Handle optional chain switch
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const chainName = resolveChainName(ctx.chainId);
      const poolName = args.name as string;
      const poolSymbol = args.symbol as string;

      // Resolve base token — default to ETH (address(0))
      let baseTokenAddress: Address = "0x0000000000000000000000000000000000000000";
      const baseTokenArg = (args.baseToken as string) || "ETH";

      if (baseTokenArg.startsWith("0x") && baseTokenArg.length === 42) {
        baseTokenAddress = baseTokenArg as Address;
      } else if (baseTokenArg.toUpperCase() !== "ETH") {
        baseTokenAddress = await resolveTokenAddress(ctx.chainId, baseTokenArg) as Address;
      }

      const data = encodeFunctionData({
        abi: POOL_FACTORY_ABI,
        functionName: "createPool",
        args: [poolName, poolSymbol, baseTokenAddress],
      });

      const gas = await estimateGas(
        ctx.chainId, POOL_FACTORY_ADDRESS as Address,
        data, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "deploy",
      );

      const transaction: UnsignedTransaction = {
        to: POOL_FACTORY_ADDRESS as Address,
        data,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: `Deploy new Rigoblock pool: ${poolName} (${poolSymbol})`,
        operatorOnly: true,
      };

      const baseLabel = baseTokenArg.toUpperCase() === "ETH"
        ? "ETH (native)"
        : baseTokenArg.startsWith("0x")
          ? `${baseTokenArg.slice(0, 6)}…${baseTokenArg.slice(-4)}`
          : baseTokenArg.toUpperCase();

      const message = [
        "✅ Pool deployment ready",
        `Name: ${poolName}`,
        `Symbol: ${poolSymbol}`,
        `Base token: ${baseLabel}`,
        `Chain: ${chainName}`,
        `Factory: ${POOL_FACTORY_ADDRESS}`,
        "",
        "Sign this transaction to deploy your new smart pool.",
        "After deployment, the new pool address will appear in the transaction receipt.",
        "You can then paste it in the vault address field to start trading.",
      ].join("\n");

      return { message, transaction, chainSwitch: chainSwitched };
    }

    // ── Pool Funding (Mint) ───────────────────────────────────────────

    case "fund_pool": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      const amountStr = args.amount as string;
      if (!amountStr) {
        throw new Error("Amount is required. Specify how much base token to deposit (e.g., '1.5' ETH).");
      }

      const recipient = (args.recipient as string) || ctx.operatorAddress;
      const chainName = resolveChainName(ctx.chainId);

      // 1. Read pool data (base token) and NAV in parallel
      const [poolData, navData] = await Promise.all([
        getPoolData(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY),
        getNavData(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY),
      ]);

      const baseToken = poolData.baseToken;
      const isNativeBase = baseToken.toLowerCase() === "0x0000000000000000000000000000000000000000";

      // 2. Resolve base token decimals and symbol
      let baseDecimals: number;
      let baseSymbol: string;
      if (isNativeBase) {
        baseDecimals = 18;
        // Determine native symbol based on chain
        const nativeSymbols: Record<number, string> = { 56: "BNB", 137: "POL" };
        baseSymbol = nativeSymbols[ctx.chainId] || "ETH";
      } else {
        baseDecimals = await getTokenDecimals(ctx.chainId, baseToken, env.ALCHEMY_API_KEY);
        const tokenInfo = await getVaultTokenBalance(ctx.chainId, ctx.vaultAddress as Address, baseToken as Address, env.ALCHEMY_API_KEY);
        baseSymbol = tokenInfo.symbol;
      }

      // 3. Parse amount to smallest units
      const amountInWei = parseUnits(amountStr, baseDecimals);

      // 4. Calculate amountOutMin from NAV with 5% slippage
      //    unitaryValue = price of 1 pool token in base token units (18 decimals)
      //    expectedPoolTokens = amountIn * 10^18 / unitaryValue
      //    amountOutMin = expectedPoolTokens * 0.95
      const unitaryValue = navData.unitaryValue;
      let amountOutMin: bigint;
      if (unitaryValue === 0n) {
        // First mint (empty pool) — no NAV yet, accept any amount
        amountOutMin = 0n;
      } else {
        const expectedPoolTokens = (amountInWei * (10n ** 18n)) / unitaryValue;
        amountOutMin = (expectedPoolTokens * 95n) / 100n; // 5% slippage
      }

      // Format for display
      const unitaryValueFormatted = unitaryValue > 0n
        ? formatUnits(unitaryValue, 18)
        : "N/A (first mint)";
      const expectedTokensFormatted = unitaryValue > 0n
        ? formatUnits((amountInWei * (10n ** 18n)) / unitaryValue, 18)
        : amountStr;
      const minTokensFormatted = formatUnits(amountOutMin, 18);

      // 5. Build the mint transaction
      const mintData = encodeMint(
        recipient as Address,
        amountInWei,
        amountOutMin,
      );

      if (isNativeBase) {
        // Native base token — send as msg.value, no approval needed
        const mintGas = await estimateGas(
          ctx.chainId, ctx.vaultAddress as Address,
          mintData as Hex, "0x" + amountInWei.toString(16),
          ctx.operatorAddress, env.ALCHEMY_API_KEY,
        );

        const transaction: UnsignedTransaction = {
          to: ctx.vaultAddress as Address,
          data: mintData,
          value: "0x" + amountInWei.toString(16),
          chainId: ctx.chainId,
          gas: mintGas,
          description: `Fund pool: deposit ${amountStr} ${baseSymbol} into ${poolData.name}`,
          operatorOnly: true,
        };

        const message = [
          `✅ Pool funding ready`,
          `Pool: ${poolData.name} (${poolData.symbol})`,
          `Deposit: ${amountStr} ${baseSymbol}`,
          `NAV per token: ${unitaryValueFormatted} ${baseSymbol}`,
          `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
          `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
          `Chain: ${chainName}`,
          `Recipient: ${recipient}`,
          "",
          "Sign this transaction to deposit capital and receive pool tokens.",
        ].join("\n");

        return { message, transaction };
      }

      // ERC-20 base token — need approve first, then mint
      // Build approve(vaultAddress, amountIn) on the base token
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [ctx.vaultAddress as Address, amountInWei],
      });

      // Return the approve transaction first — the mint follows after approval
      const approveGas = await estimateGas(
        ctx.chainId, baseToken as Address,
        approveData, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "approve",
      );

      const transaction: UnsignedTransaction = {
        to: baseToken as Address,
        data: approveData,
        value: "0x0",
        chainId: ctx.chainId,
        gas: approveGas,
        description: `Approve ${amountStr} ${baseSymbol} for pool ${poolData.name}`,
        operatorOnly: true,
      };

      const message = [
        `✅ Pool funding ready (2 transactions)`,
        `Pool: ${poolData.name} (${poolData.symbol})`,
        `Deposit: ${amountStr} ${baseSymbol}`,
        `NAV per token: ${unitaryValueFormatted} ${baseSymbol}`,
        `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
        `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
        `Chain: ${chainName}`,
        `Recipient: ${recipient}`,
        "",
        "**Step 1/2:** Sign the approval transaction to allow the pool to transfer your ${baseSymbol}.",
        "**Step 2/2:** After approval, you'll be prompted to sign the mint transaction.",
      ].join("\n");

      return { message, transaction };
    }

    // ── Cross-chain (AIntents + Across Protocol) ──────────────────────

    case "crosschain_transfer": {
      const srcChainArg = args.sourceChain as string | undefined;
      const destChainArg = args.destinationChain as string;
      const tokenSymbol = args.token as string;
      const amount = args.amount as string;
      const useNativeEth = args.useNativeEth === true || args.useNativeEth === "true";
      const shouldUnwrapOnDestination = args.shouldUnwrapOnDestination === true || args.shouldUnwrapOnDestination === "true";

      if (!destChainArg || !tokenSymbol || !amount) {
        throw new Error("destinationChain, token, and amount are all required.");
      }

      // Resolve source chain (optional — defaults to current chain)
      const srcChainId = srcChainArg
        ? resolveChainArg(srcChainArg.trim()).id
        : ctx.chainId;
      const srcName = resolveChainName(srcChainId);

      // Resolve destination chain
      const destMatch = resolveChainArg(destChainArg.trim());

      if (srcChainId === destMatch.id) {
        throw new Error(
          `Source and destination are both ${destMatch.name}. Cross-chain transfer requires different chains.`,
        );
      }

      const result = await buildCrosschainTransfer({
        vaultAddress: ctx.vaultAddress as Address,
        srcChainId,
        dstChainId: destMatch.id,
        tokenSymbol,
        amount,
        useNativeEth,
        // If vault wraps native ETH→WETH for bridging, unwrap on destination too.
        // If user is sending actual WETH tokens, they want WETH on destination.
        shouldUnwrapOnDestination: shouldUnwrapOnDestination || useNativeEth,
        alchemyKey: env.ALCHEMY_API_KEY,
        operatorAddress: ctx.operatorAddress,
      });

      const gas = await estimateGas(
        srcChainId, ctx.vaultAddress as Address,
        result.calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "bridge",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: srcChainId,
        gas,
        description: result.description,
      };

      const message = [
        `✅ Cross-chain transfer ready`,
        `Route: ${srcName} → ${destMatch.name}`,
        `Send: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
        `Receive: ~${parseFloat(result.quote.outputAmount).toFixed(6)} ${result.quote.outputToken.symbol}`,
        `Bridge fee: ${result.quote.feePct}`,
        `Estimated time: ${result.quote.estimatedTime}`,
        "",
        "Sign this transaction to initiate the cross-chain transfer.",
      ].join("\n");

      return {
        message,
        transaction,
        suggestions: ["Check vault balance", "Bridge more", "Get vault info"],
      };
    }

    case "crosschain_sync": {
      const srcChainArg = args.sourceChain as string | undefined;
      const destChainArg = args.destinationChain as string;
      const navToleranceBps = args.navToleranceBps as number | undefined;
      const equalizeNav = args.equalizeNav as boolean | undefined;

      // When equalizeNav=true, IGNORE LLM-provided amount and token.
      // These are computed DETERMINISTICALLY by the equalization algorithm.
      // The LLM's only job is to pass the two chain names + equalizeNav=true.
      const tokenSymbol = equalizeNav ? undefined : (args.token as string | undefined);
      const amount = equalizeNav ? undefined : (args.amount as string | undefined);

      if (!destChainArg) {
        throw new Error("destinationChain is required for crosschain_sync.");
      }

      const userSrcChainId = srcChainArg
        ? resolveChainArg(srcChainArg.trim()).id
        : ctx.chainId;
      const destMatch = resolveChainArg(destChainArg.trim());

      if (userSrcChainId === destMatch.id) {
        throw new Error(
          `Source and destination are both ${destMatch.name}. Cross-chain sync requires different chains.`,
        );
      }

      const result = await buildCrosschainSync({
        vaultAddress: ctx.vaultAddress as Address,
        srcChainId: userSrcChainId,
        dstChainId: destMatch.id,
        tokenSymbol,
        amount,
        navToleranceBps,
        equalizeNav,
        alchemyKey: env.ALCHEMY_API_KEY,
        operatorAddress: ctx.operatorAddress,
      });

      // CRITICAL: Use the EFFECTIVE chain IDs from the quote, NOT the user's
      // original args. When NAV equalization auto-swaps direction (bridges
      // FROM higher-NAV chain), the effective source differs from user input.
      // Using the original srcChainId for estimateGas would simulate on the
      // WRONG chain → SameChainTransfer revert (the calldata targets the
      // swapped source but simulation runs on the original source).
      const effectiveSrcChainId = result.quote.srcChainId;
      const effectiveDstChainId = result.quote.dstChainId;
      const effectiveSrcName = resolveChainName(effectiveSrcChainId);
      const effectiveDstName = resolveChainName(effectiveDstChainId);

      // Build context summary BEFORE estimateGas — so we can include it in errors.
      const eq = result.navEqualization;
      const navEqContext = eq
        ? [
            `NAV equalization${eq.directionAutoSwapped ? ' (direction auto-corrected)' : ''}:`,
            `  ${effectiveSrcName} NAV: ${eq.srcNavFormatted} (${eq.srcDecimals}-dec pool)`,
            `  ${effectiveDstName} NAV: ${eq.dstNavFormatted} (${eq.dstDecimals}-dec pool)`,
            `  Pre-bridge divergence: ${(eq.divergenceBps / 100).toFixed(2)}%`,
            `  Bridge: ${eq.bridgeAmountFormatted} ${eq.bridgeToken.symbol}`,
            `  Post-bridge projected NAV: ${effectiveSrcName}=${eq.postSrcNav}, ${effectiveDstName}=${eq.postDstNav}`,
            `  Target NAV: ${eq.targetNav}`,
            `  Post-bridge divergence: ${(eq.postDivergenceBps / 100).toFixed(2)}%`,
            ...(eq.capped ? [`  ⚠ ${eq.capReason}`] : []),
          ].join('\n')
        : '';

      let syncGas: string;
      try {
        syncGas = await estimateGas(
          effectiveSrcChainId, ctx.vaultAddress as Address,
          result.calldata as Hex, "0x0",
          ctx.operatorAddress, env.ALCHEMY_API_KEY, "bridge",
        );
      } catch (err) {
        let revertReason: string;
        if (err instanceof Error) {
          let revertData: string | undefined;
          let bestMessage: string | undefined;
          let e: any = err;
          while (e) {
            if (e.data && typeof e.data === 'string' && e.data.startsWith('0x')) {
              revertData = e.data;
              break;
            }
            if (e.shortMessage && !e.shortMessage.includes('unknown reason')) {
              bestMessage = e.shortMessage;
            } else if (e.details && !e.details.includes('unknown reason')) {
              bestMessage = e.details;
            }
            e = e.cause;
          }
          if (revertData) {
            revertReason = friendlyError(`execution reverted: ${revertData}`);
          } else if (bestMessage) {
            revertReason = friendlyError(sanitizeError(bestMessage));
          } else {
            revertReason = friendlyError(sanitizeError(err.message));
          }
        } else {
          revertReason = friendlyError(sanitizeError(String(err)));
        }

        const errorLines = [
          `❌ NAV sync failed — transaction would revert on-chain`,
          ``,
          `Proposed action:`,
          `  Route: ${effectiveSrcName} → ${effectiveDstName}`,
          `  Token: ${result.quote.inputToken.symbol}`,
          `  Amount: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
          `  Bridge fee: ${result.quote.feePct}`,
        ];
        if (navEqContext) {
          errorLines.push(``, navEqContext);
        }
        errorLines.push(``, `Revert reason: ${revertReason}`);
        throw new Error(errorLines.join('\n'));
      }

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: effectiveSrcChainId,
        gas: syncGas,
        description: result.description,
      };

      const toleranceDisplay = navToleranceBps
        ? `${(navToleranceBps / 100).toFixed(2)}%`
        : "1.00% (default)";

      const message = [
        `✅ NAV sync ready`,
        `Route: ${effectiveSrcName} → ${effectiveDstName}`,
        `Sync amount: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
        `NAV tolerance: ${toleranceDisplay}`,
        `Bridge fee: ${result.quote.feePct}`,
        `Estimated time: ${result.quote.estimatedTime}`,
        ...(navEqContext ? ['', navEqContext] : []),
        "",
        "Sign this transaction to synchronise NAV across chains.",
      ].join("\n");

      return {
        message,
        transaction,
        suggestions: ["Check vault info", "Bridge tokens", "Get NAV data"],
      };
    }

    case "get_crosschain_quote": {
      const srcChainArg = args.sourceChain as string | undefined;
      const destChainArg = args.destinationChain as string;
      const tokenSymbol = args.token as string;
      const amount = args.amount as string;

      if (!destChainArg || !tokenSymbol || !amount) {
        throw new Error("destinationChain, token, and amount are all required.");
      }

      const srcChainId = srcChainArg
        ? resolveChainArg(srcChainArg.trim()).id
        : ctx.chainId;
      const srcName = resolveChainName(srcChainId);
      const destMatch = resolveChainArg(destChainArg.trim());

      const quote = await getCrosschainQuote(
        srcChainId,
        destMatch.id,
        tokenSymbol,
        amount,
      );

      const message = [
        `📊 Cross-chain bridge quote`,
        `Route: ${srcName} → ${destMatch.name}`,
        `Send: ${quote.inputAmount} ${quote.inputToken.symbol}`,
        `Receive: ~${parseFloat(quote.outputAmount).toFixed(6)} ${quote.outputToken.symbol}`,
        `Bridge fee: ${quote.feePct}`,
        `Estimated fill time: ${quote.estimatedTime}`,
        "",
        "To execute, ask me to bridge/transfer the tokens.",
      ].join("\n");

      return {
        message,
        suggestions: [`Bridge ${amount} ${tokenSymbol} to ${destMatch.name}`, "Check vault balance"],
      };
    }

    // ── Aggregated NAV & Rebalancing ────────────────────────────────

    case "get_aggregated_nav": {
      const nav = await getAggregatedNav(
        ctx.vaultAddress as Address,
        env.ALCHEMY_API_KEY,
        env.KV,
      );

      // Build per-chain summary
      const chainLines: string[] = [];
      for (const snap of nav.chains) {
        if (snap.error) {
          chainLines.push(`  ${snap.chainName}: ⚠️ ${snap.error}`);
          continue;
        }
        if (snap.totalValue === 0n && snap.tokenBalances.every((b) => b.balance === 0n)
            && snap.baseTokenSymbol === "N/A") {
          continue; // skip chains where the pool doesn't exist
        }
        const delegation = snap.delegationActive ? "✅" : "❌";
        const divisor = 10 ** snap.baseTokenDecimals;
        const unitaryStr = (Number(snap.unitaryValue) / divisor).toFixed(6);
        const supplyStr = (Number(snap.totalSupply) / divisor).toFixed(4);
        const tokenLines = snap.tokenBalances
          .filter((b) => b.balance > 0n)
          .map((b) => `    ${b.token.symbol}: ${b.balanceFormatted}`)
          .join("\n");

        chainLines.push(
          `  **${snap.chainName}** (delegation: ${delegation})` +
          `\n    Base token: ${snap.baseTokenSymbol} | Supply: ${supplyStr} | Unitary value: ${unitaryStr}` +
          (tokenLines ? `\n${tokenLines}` : ""),
        );
      }

      // Token totals
      const totalLines: string[] = [];
      for (const [tokenType, data] of Object.entries(nav.tokenTotals)) {
        if (data.total === "0" || data.total === "0.000000") continue;
        totalLines.push(`  ${tokenType}: ${data.total}`);
      }

      // Missing delegation
      const missingNames = nav.missingDelegationChains.map(
        (id) => crosschainChainName(id),
      );

      const message = [
        `📊 **Aggregated NAV — ${ctx.vaultAddress}**`,
        "",
        chainLines.length > 0 ? chainLines.join("\n\n") : "  No vault data found on any chain.",
        "",
        totalLines.length > 0
          ? `**Bridgeable token totals:**\n${totalLines.join("\n")}`
          : "",
        missingNames.length > 0
          ? `\n⚠️ **Missing delegation on:** ${missingNames.join(", ")}\nSet up agent delegation on these chains to enable cross-chain operations.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        message,
        selfContained: true,
        suggestions: [
          "Bridge USDT to Arbitrum",
          "Create a TWAP order",
          "Check LP positions",
          "Sync NAV across chains",
        ],
      };
    }

    case "get_rebalance_plan": {
      const targetChainArg = args.targetChain as string | undefined;
      const targetChainId = targetChainArg
        ? resolveChainArg(targetChainArg.trim()).id
        : undefined;

      const plan = await buildRebalancePlan({
        vaultAddress: ctx.vaultAddress as Address,
        targetChainId,
        alchemyKey: env.ALCHEMY_API_KEY,
        kv: env.KV,
      });

      if (plan.operations.length === 0) {
        return {
          message: plan.summary,
          suggestions: ["Get aggregated NAV", "Check vault info"],
        };
      }

      // List each operation
      const opLines = plan.operations.map((op, i) => {
        const fee = op.estimatedFeePct || "N/A";
        const time = op.estimatedTime || "N/A";
        const cappedNote = op.capped ? " ⚠️ capped to stay within 10% NAV shield" : "";
        return `  ${i + 1}. ${op.srcChainName} → ${plan.targetChainName}: ${op.amount} ${op.tokenType} (fee: ${fee}, ~${time})${cappedNote}`;
      });

      // Check for missing delegation on source chains
      const missingDelegation = plan.nav.missingDelegationChains;
      const opSourceChains = new Set(plan.operations.map((o) => o.srcChainId));
      const blockedSources = [...opSourceChains].filter((id) =>
        missingDelegation.includes(id),
      );
      const blockedNames = blockedSources.map((id) => crosschainChainName(id));

      const message = [
        `📋 **Rebalance Plan → ${plan.targetChainName}**`,
        "",
        `${plan.operations.length} operation${plan.operations.length > 1 ? "s" : ""} recommended:`,
        "",
        opLines.join("\n"),
        blockedNames.length > 0
          ? `\n⚠️ **Delegation missing on:** ${blockedNames.join(", ")}\nSet up agent delegation on these chains first.`
          : "",
        "",
        "Which operations would you like to execute? (e.g., 'all', '1 and 3', 'skip')",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        message,
        suggestions: [
          "Execute all operations",
          "Show aggregated NAV",
          "Skip rebalancing",
        ],
      };
    }

    // ── Strategy Skills (TWAP only) ──────────────────────────────────

    case "list_strategies": {
      const { getTwapOrders } = await import("../skills/twap.js");
      const twapOrders = (await getTwapOrders(env.KV, ctx.vaultAddress)).filter((o) => o.active);

      if (twapOrders.length === 0) {
        return {
          message: "No active TWAP strategies configured for this vault.",
          suggestions: ["Create a TWAP order"],
        };
      }

      const twapLines = twapOrders.map((o) => {
        const side = o.side || "sell";
        const direction = side === "buy"
          ? `Buy ${o.totalAmount} ${o.buyToken} with ${o.sellToken}`
          : `Sell ${o.totalAmount} ${o.sellToken} for ${o.buyToken}`;
        return (
          `  **TWAP #${o.id}** [🔄 Active] every ${o.intervalMinutes}m\n` +
          `    "${direction}"\n` +
          `    Progress: ${o.slicesExecuted}/${o.sliceCount} slices | DEX: ${o.dex}`
        );
      });

      return {
        message:
          `📋 **Active Strategies (TWAP only)** (${twapOrders.length} total):\n\n` +
          twapLines.join("\n\n"),
        suggestions: [
          "Create a TWAP order",
          twapOrders.length > 0 ? `Cancel TWAP order ${twapOrders[0].id}` : "",
        ].filter(Boolean),
      };
    }

    // ── Strategy Skills (TWAP, etc.) — delegated to skill registry ────

    case "create_twap_order":
    case "cancel_twap_order":
    case "list_twap_orders": {
      const { handleSkillToolCall } = await import("../skills/index.js");
      const result = await handleSkillToolCall(name, args, env, ctx);
      if (!result) throw new Error(`Skill handler not found for ${name}`);
      return result;
    }

    // ── Uniswap v4 LP ──────────────────────────────────────────────────

    case "get_pool_info": {
      let chainId = ctx.chainId;
      if (args.chain) {
        chainId = resolveChainArg((args.chain as string).trim()).id;
      }

      const poolId = (args.poolId as string).trim() as `0x${string}`;
      const info = await getPoolInfoById(poolId, chainId, env.ALCHEMY_API_KEY);

      const message = [
        `ℹ️ Uniswap v4 Pool Info`,
        `Pool ID: ${info.poolId}`,
        `Initialized: ${info.initialized ? "Yes" : "No"}`,
        `Fee: ${info.fee} (${info.fee / 10000}%)`,
        `Tick Spacing: ${info.tickSpacing}`,
        `Hooks: ${info.hooks}`,
        `Currency 0: ${info.currency0}`,
        `Currency 1: ${info.currency1}`,
        `Current Tick: ${info.currentTick}`,
        ``,
        `To add liquidity: use fee=${info.fee}, tickSpacing=${info.tickSpacing}, hooks=${info.hooks}`,
      ].join("\n");

      return { message };
    }

    case "add_liquidity": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const result = await buildAddLiquidityTx(env, {
        tokenA: args.tokenA as string,
        tokenB: args.tokenB as string,
        amountA: args.amountA as string | undefined,
        amountB: args.amountB as string | undefined,
        fee: args.fee as number,
        tickSpacing: args.tickSpacing as number | undefined,
        tickRange: (args.tickRange as string) || "full",
        hooks: args.hooks as Address | undefined,
      }, ctx.chainId, ctx.vaultAddress as Address);

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        result.calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "lp",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      const message = [
        `✅ Add Liquidity ready`,
        `${result.description}`,
        `Tick range: [${result.tickLower}, ${result.tickUpper}]`,
        `Chain: ${chainName}`,
      ].join("\n");

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "remove_liquidity": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      // Auto-fetch liquidityAmount if not provided or non-numeric (e.g. LLM passes "all", "100%").
      // The LLM knows the tokenId but not raw liquidity units, so we resolve it here.
      let liquidityAmount = args.liquidityAmount as string | undefined;
      const tokenId = args.tokenId as string;
      if ((!liquidityAmount || !/^\d+$/.test(liquidityAmount.trim())) && tokenId) {
        const positions = await getVaultLPPositions(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
        const pos = positions.find(p => p.tokenId === tokenId);
        if (!pos) throw new Error(`LP position #${tokenId} not found. Use get_lp_positions to list your current positions.`);
        if (pos.liquidity === "0") throw new Error(`Position #${tokenId} has zero liquidity — it may already be closed.`);
        liquidityAmount = pos.liquidity;
      }
      if (!liquidityAmount) throw new Error("liquidityAmount is required when position cannot be looked up.");

      const result = await buildRemoveLiquidityTx(env, {
        tokenA: args.tokenA as string,
        tokenB: args.tokenB as string,
        tokenId,
        liquidityAmount,
        burn: args.burn as boolean | undefined,
      }, ctx.chainId, ctx.vaultAddress as Address);

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        result.calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "lp",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      const wasBurned = (args.burn as boolean | undefined) === true;
      const burnNote = wasBurned
        ? `ℹ️ The position NFT #${tokenId} was burned (permanent). If fees remain uncollected they were forfeited.`
        : `ℹ️ Position NFT #${tokenId} persists with 0 liquidity. ` +
          `Use collect_lp_fees to harvest any accrued fees, then burn_position to permanently delete it.`;
      return {
        message: `✅ Remove Liquidity ready\n${result.description}\nChain: ${chainName}\n\n💡 Review and sign to remove the LP position.\n${burnNote}`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    // ── LP Position Reading & Fee Collection ────────────────────────────

    case "get_lp_positions": {
      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const chainName = resolveChainName(ctx.chainId);
      const positions = await getVaultLPPositions(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);

      if (positions.length === 0) {
        return {
          message: `No Uniswap v4 LP positions found for this vault on ${chainName} (0 token IDs returned by vault).\nIf you believe positions exist, verify the vault address and chain, then try again.`,
          chainSwitch: chainSwitched,
          selfContained: true,
        };
      }

      // Format amounts: trim trailing zeros, cap at 6 decimal places
      const fmtAmt = (raw: string): string => {
        const n = parseFloat(raw);
        if (n === 0) return "0";
        if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
        if (n >= 1) return n.toFixed(4);
        return n.toFixed(6);
      };

      // Block explorer base URLs for address links
      const explorerBase: Record<number, string> = {
        1: "https://etherscan.io/address/",
        10: "https://optimistic.etherscan.io/address/",
        56: "https://bscscan.com/address/",
        137: "https://polygonscan.com/address/",
        8453: "https://basescan.org/address/",
        42161: "https://arbiscan.io/address/",
      };
      const explorer = explorerBase[ctx.chainId] || "";

      // Sort: active positions first, closed (zero liquidity) last
      const sorted = [...positions].sort((a, b) => {
        const aZero = a.liquidity === "0" ? 1 : 0;
        const bZero = b.liquidity === "0" ? 1 : 0;
        return aZero - bZero;
      });

      const active = positions.filter((p) => p.liquidity !== "0").length;
      const closedCount = positions.length - active;
      const subtitle = closedCount > 0 ? ` (${active} active, ${closedCount} closed)` : "";

      // Build markdown table
      const header = `| # | Pair | Fee | ${positions[0]?.symbol0 ?? "Token0"} | ${positions[0]?.symbol1 ?? "Token1"} | Hook | Status |`;
      const sep = "|---|------|-----|------|------|------|--------|";
      const rows = sorted.map((p) => {
        const status = p.liquidity === "0" ? "Closed" : "Active";
        const hookCell = p.hooks.toLowerCase() !== "0x0000000000000000000000000000000000000000"
          ? (explorer ? `[${p.hooks.slice(0, 6)}…${p.hooks.slice(-4)}](${explorer}${p.hooks})` : `${p.hooks.slice(0, 6)}…${p.hooks.slice(-4)}`)
          : "—";
        return `| ${p.tokenId} | ${p.symbol0}/${p.symbol1} | ${p.fee / 10000}% | ${fmtAmt(p.amount0)} | ${fmtAmt(p.amount1)} | ${hookCell} | ${status} |`;
      });

      const message = [
        `📊 **Uniswap v4 LP Positions — ${chainName}** (${positions.length}${subtitle})`,
        "",
        header,
        sep,
        ...rows,
      ].join("\n");

      return {
        message,
        chainSwitch: chainSwitched,
        selfContained: true,
      };
    }

    case "collect_lp_fees": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const tokenId = args.tokenId as string;
      const addrA = await resolveTokenAddress(ctx.chainId, args.tokenA as string);
      const addrB = await resolveTokenAddress(ctx.chainId, args.tokenB as string);

      // Sort currency0 < currency1 as required by v4
      const isALower = addrA.toLowerCase() < addrB.toLowerCase();
      const currency0 = (isALower ? addrA : addrB) as Address;
      const currency1 = (isALower ? addrB : addrA) as Address;

      const result = buildCollectFeesTx(tokenId, currency0, currency1, ctx.vaultAddress as Address);

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        result.calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "lp",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      return {
        message: `✅ Fee Collection ready\n${result.description}\nChain: ${chainName}\n\n💡 Sign to collect accrued trading fees from this LP position.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "burn_position": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const tokenId = args.tokenId as string;

      // The vault's getUniV4TokenIds() tracks ALL positions (active and closed) until
      // explicitly burned. A closed position appears in getVaultLPPositions() with
      // liquidity = "0" and status = "closed". Use it to validate and get pool key.
      const positions = await getVaultLPPositions(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
      let pos = positions.find(p => p.tokenId === tokenId);

      // Fallback: if getVaultLPPositions didn't return this position (e.g. transient
      // RPC failure in the batch multicall), query the POSM directly for just this one.
      let currency0: Address;
      let currency1: Address;

      if (pos) {
        if (pos.liquidity !== "0") {
          throw new Error(
            `Position #${tokenId} still has ${pos.liquidity} liquidity units. ` +
            `Remove liquidity first using remove_liquidity, then collect any remaining fees with collect_lp_fees before burning.`,
          );
        }
        // Sort currency0 < currency1 — required for TAKE_PAIR
        const isC0Lower = pos.currency0.toLowerCase() < pos.currency1.toLowerCase();
        currency0 = (isC0Lower ? pos.currency0 : pos.currency1) as Address;
        currency1 = (isC0Lower ? pos.currency1 : pos.currency0) as Address;
      } else {
        // Position not in batch results — query POSM directly
        const directPos = await getPositionDirect(ctx.chainId, tokenId, env.ALCHEMY_API_KEY);
        if (!directPos) {
          throw new Error(
            `Position #${tokenId} not found — the NFT has already been burned in the PositionManager. ` +
            `If the vault's getUniV4TokenIds() still lists it, the tracking array is stale.`,
          );
        }
        if (directPos.liquidity > 0n) {
          throw new Error(
            `Position #${tokenId} still has ${directPos.liquidity} liquidity units. ` +
            `Remove liquidity first using remove_liquidity, then collect any remaining fees with collect_lp_fees before burning.`,
          );
        }
        const isC0Lower = directPos.currency0.toLowerCase() < directPos.currency1.toLowerCase();
        currency0 = (isC0Lower ? directPos.currency0 : directPos.currency1) as Address;
        currency1 = (isC0Lower ? directPos.currency1 : directPos.currency0) as Address;
      }

      const result = buildBurnPositionTx(tokenId, currency0, currency1, ctx.vaultAddress as Address);

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        result.calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "lp",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      return {
        message: [
          `✅ Burn Position ready`,
          result.description,
          `Chain: ${chainName}`,
          ``,
          `⚠️ This is PERMANENT and IRREVERSIBLE. The position NFT #${tokenId} will be deleted.`,
          `Make sure you have collected all fees first (collect_lp_fees) — uncollected fees will be lost.`,
          `Sign to confirm.`,
        ].join("\n"),
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    // ── GRG Staking ─────────────────────────────────────────────────────

    case "grg_stake": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      // Staking is Ethereum mainnet only
      let chainSwitched: number | undefined;
      if (ctx.chainId !== 1) {
        ctx.chainId = 1;
        chainSwitched = 1;
      }

      const amount = args.amount as string;
      const calldata = buildStakeCalldata(amount);

      const gas = await estimateGas(
        1, ctx.vaultAddress as Address,
        calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas,
        description: `[GRG Staking] Stake ${amount} GRG`,
      };

      return {
        message: `✅ GRG Stake ready\nAmount: ${amount} GRG\nChain: Ethereum\n\n💡 Staking earns operator rewards (30%+ share) and attracts third-party delegated stake.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "grg_unstake": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== 1) {
        ctx.chainId = 1;
        chainSwitched = 1;
      }

      const amount = args.amount as string;
      const calldata = buildUnstakeCalldata(amount);

      const gas = await estimateGas(
        1, ctx.vaultAddress as Address,
        calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas,
        description: `[GRG Staking] Unstake ${amount} GRG`,
      };

      return {
        message: `✅ GRG Unstake ready\nAmount: ${amount} GRG\nChain: Ethereum\n\n⚠️ Make sure you called undelegate first and waited for the epoch to end before unstaking.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "grg_undelegate_stake": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== 1) {
        ctx.chainId = 1;
        chainSwitched = 1;
      }

      const amount = args.amount as string;
      const calldata = buildUndelegateStakeCalldata(amount);

      const gas = await estimateGas(
        1, ctx.vaultAddress as Address,
        calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas,
        description: `[GRG Staking] Undelegate ${amount} GRG`,
      };

      return {
        message: `✅ GRG Undelegate ready\nAmount: ${amount} GRG\nChain: Ethereum\n\n💡 After undelegation, wait for the current epoch to end, then call unstake to withdraw.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "grg_end_epoch": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== 1) {
        ctx.chainId = 1;
        chainSwitched = 1;
      }

      const stakingProxy = STAKING_PROXY[1];
      if (!stakingProxy) {
        throw new Error("Staking proxy address not configured for Ethereum mainnet.");
      }

      const calldata = buildEndEpochCalldata();

      const gas = await estimateGas(
        1, stakingProxy,
        calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
      );

      const transaction: UnsignedTransaction = {
        to: stakingProxy,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas,
        description: `[GRG Staking] Finalize epoch on staking proxy`,
      };

      return {
        message: `✅ End Epoch ready\nTarget: Staking Proxy (${stakingProxy})\nChain: Ethereum\n\n⚠️ This targets the staking proxy directly — sign from your wallet (cannot use delegation).`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    case "grg_claim_rewards": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (ctx.chainId !== 1) {
        ctx.chainId = 1;
        chainSwitched = 1;
      }

      const calldata = buildWithdrawDelegatorRewardsCalldata();

      const gas = await estimateGas(
        1, ctx.vaultAddress as Address,
        calldata, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas,
        description: `[GRG Staking] Claim delegator rewards`,
      };

      return {
        message: `✅ Claim Rewards ready\nChain: Ethereum\n\n💡 This claims accumulated delegator staking rewards back to the vault.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    // ── Selective Delegation Revocation ──────────────────────────────────

    case "revoke_selectors": {
      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected. Connect your wallet first.");
      }

      let chainSwitched: number | undefined;
      if (args.chain) {
        const match = resolveChainArg((args.chain as string).trim());
        if (match.id !== ctx.chainId) {
          ctx.chainId = match.id;
          chainSwitched = match.id;
        }
      }

      const walletInfo = await getAgentWalletInfo(env.KV, ctx.vaultAddress as string);
      if (!walletInfo?.address) {
        throw new Error("No agent wallet found for this vault. Nothing to revoke.");
      }

      const selectorsToRevoke = (args.selectors as string[]).map((s) => s as Hex);
      const chainName = resolveChainName(ctx.chainId);

      const result = await prepareSelectiveRevocation(
        env,
        ctx.vaultAddress as Address,
        walletInfo.address,
        selectorsToRevoke,
        ctx.chainId,
      );

      const gas = await estimateGas(
        ctx.chainId, ctx.vaultAddress as Address,
        result.transaction.data as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "delegation",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.transaction.data,
        value: "0x0",
        chainId: ctx.chainId,
        gas,
        description: result.transaction.description,
      };

      return {
        message: `✅ Selective Revocation ready\nRevoking ${selectorsToRevoke.length} selector(s) on ${chainName}\nSelectors: ${selectorsToRevoke.join(", ")}\n\n💡 Sign to revoke these specific delegated functions.`,
        transaction,
        chainSwitch: chainSwitched,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Resolve a chain name/shortName/ID to a supported chain entry. Throws if not found. */
function resolveChainArg(chainArg: string): { id: number; name: string; shortName: string } {
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

/** Simple Levenshtein distance for short strings (chain names). */
function levenshtein(a: string, b: string): number {
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
function resolveChainName(chainId: number): string {
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
async function resolveSlippage(env: Env, ctx: RequestContext): Promise<number> {
  // 1. Per-request override from body (ONLY for verified operators)
  // Unverified callers must not be able to weaken per-request safety controls.
  if (
    ctx.operatorVerified &&
    ctx.slippageBps != null &&
    typeof ctx.slippageBps === "number" &&
    Number.isFinite(ctx.slippageBps) &&
    Number.isInteger(ctx.slippageBps)
  ) {
    const clamped = Math.max(MIN_SLIPPAGE_BPS, Math.min(MAX_SLIPPAGE_BPS, ctx.slippageBps));
    return clamped;
  }

  // 2. Stored operator preference (ONLY for verified operators)
  if (ctx.operatorVerified && ctx.operatorAddress && env.KV) {
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
 * Skipped when the operator has temporarily disabled the shield.
 */
async function runSwapShield(
  env: Env,
  ctx: RequestContext,
  intent: SwapIntent,
  sellAmountRaw: string,
  sellDecimals: number,
  buyAmountRaw: string,
): Promise<void> {
  // Check opt-out
  if (ctx.operatorAddress && env.KV) {
    const disabled = await isSwapShieldDisabled(
      env.KV,
      ctx.operatorAddress,
      ctx.vaultAddress as string,
    );
    if (disabled) {
      console.log("[SwapShield] Temporarily disabled by operator — skipping");
      return;
    }
  }

  // Resolve token addresses
  let tokenInAddr: Address;
  let tokenOutAddr: Address;
  try {
    tokenInAddr = await resolveTokenAddress(ctx.chainId, intent.tokenIn) as Address;
    tokenOutAddr = await resolveTokenAddress(ctx.chainId, intent.tokenOut) as Address;
  } catch {
    console.warn("[SwapShield] Token address resolution failed — skipping oracle check");
    return;
  }

  const result = await checkSwapPrice(
    ctx.vaultAddress as Address,
    ctx.chainId,
    tokenInAddr,
    tokenOutAddr,
    BigInt(sellAmountRaw),
    BigInt(buyAmountRaw),
    intent.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    env.ALCHEMY_API_KEY,
  );

  if (!result.allowed) {
    // Build a context-specific error with guidance
    const sellSymbol = intent.tokenIn;
    const buySymbol = intent.tokenOut;
    const sellAmt = intent.amountIn || formatUnits(BigInt(sellAmountRaw), sellDecimals);
    const divergence = parseFloat(result.divergencePct);
    const isFavorable = Number.isFinite(divergence) && divergence < 0;
    const thresholdText = isFavorable
      ? "10% better-than-oracle safety threshold"
      : "5% safety threshold";
    const explanation = isFavorable
      ? `This can indicate a stale oracle or a manipulated routing path producing an implausibly favorable quote.`
      : `This usually indicates significant price impact from the trade size.`;
    const options = isFavorable
      ? `Options:\n` +
        `1. **Retry later** — wait for pricing to normalize and request a fresh quote\n` +
        `2. **Verify route** — compare venues or try a different swap path\n` +
        `3. **Disable shield** — say "disable swap shield" for 10 minutes ` +
        `(use with caution — you accept oracle/route integrity risk)\n`
      : `Options:\n` +
        `1. **Split with TWAP** — create a TWAP order to execute ${sellAmt} ${sellSymbol} → ${buySymbol} ` +
        `in smaller slices over time, reducing price impact\n` +
        `2. **Reduce amount** — try a smaller trade\n` +
        `3. **Disable shield** — say "disable swap shield" for 10 minutes ` +
        `(use with caution — you accept full price impact risk)\n`;
    throw new Error(
      `⚠️ Swap Shield blocked this trade.\n\n` +
      `The DEX quote diverges ${result.divergencePct}% from the on-chain oracle price, ` +
      `exceeding the ${thresholdText}.\n\n` +
      `${explanation}\n\n` +
      `${options}`,
    );
  }

  // Log non-blocking results
  if (result.code === "NO_PRICE_FEED" || result.code === "ORACLE_ERROR") {
    console.warn(`[SwapShield] Non-blocking: ${result.reason}`);
  }
}

/**
 * Format a raw token amount (in smallest units) to human-readable.
 */
function formatRawAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${frac}`;
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

  // ── 1. Default DEX to Uniswap (reliable vault adapter) ──
  // 0x AllowanceHolder flow requires an on-chain A0xRouter adapter that is
  // not yet deployed on most vaults. Uniswap routes through the proven
  // AUniswapRouter adapter and has longer deadlines (30 min vs ~2 min for 0x),
  // which is critical for Telegram where users press Execute after a delay.
  if (!corrected.dex) {
    corrected.dex = "uniswap";
  }

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

      // The LLM MUST set amountOut for "buy" — correct if wrong
      const currentAmountOut = corrected.amountOut as string | undefined;

      if (!currentAmountOut || Math.abs(parseFloat(currentAmountOut) - parseFloat(amount)) > parseFloat(amount) * 0.01) {
        console.log(`[sanitize] Correcting buy amount: amountOut=${currentAmountOut} → ${amount} (user said "buy ${amount} ${token}")`);
        corrected.amountOut = amount;
        delete corrected.amountIn; // buy = amountOut, never amountIn
      }

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
        delete corrected.amountOut;
      }

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
 * Detect swap shield enable/disable commands, including the frontend
 * magic strings __enable_swap_shield__ / __disable_swap_shield__.
 */
function tryFastPathSwapShieldToggle(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  if (m === "__enable_swap_shield__" || /^(?:re-?)?enable\s+swap\s+shield$/i.test(m)) {
    return { name: "enable_swap_shield", args: {} };
  }
  if (m === "__disable_swap_shield__" || /^disable\s+swap\s+shield$/i.test(m)) {
    return { name: "disable_swap_shield", args: {} };
  }

  return null;
}

// ── Fast-path: Cross-chain NAV sync ─────────────────────────────────

/**
 * Detect deterministic NAV sync commands and map to crosschain_sync.
 *
 * Examples:
 * - "sync nav from arbitrum to base"
 * - "sync nav between arbitrum and base"
 * - "sync my pool nav across optimism and arbitrum"
 */
function tryFastPathCrosschainSync(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  // Must mention sync (crosschain sync, sync nav, nav sync, etc.)
  if (!/\bsync\b/.test(m)) return null;

  // Detect equalizeNav intent — user wants automatic NAV/price equalization
  const wantsEqualize = /\b(calculat|equaliz|match.*price|same.*price|price.*(?:equal|same|parity|converg)|unitary.*(?:same|equal|match)|so that|in order to)\b/i.test(m);

  // Extract chain pair: "from X to Y" pattern
  const fromTo = m.match(
    /(?:sync|crosschain\s+sync)(?:\s+(?:my|the))?(?:\s+(?:pool|nav))?\s*(?:nav\s*)?(?:of\s+[a-z0-9 ]+?)?\s*from\s+([a-z0-9 ]+?)\s+to\s+([a-z0-9 ]+?)(?:\s*[.,;!]|\s+(?:calculat|so\b|in\b|and\b|with\b)|$)/i,
  );
  if (fromTo) {
    return {
      name: "crosschain_sync",
      args: {
        sourceChain: fromTo[1].trim(),
        destinationChain: fromTo[2].trim(),
        ...(wantsEqualize ? { equalizeNav: true } : {}),
      },
    };
  }

  // Extract chain pair: "between X and Y" or "across X and Y"
  const between = m.match(
    /(?:sync|crosschain\s+sync)(?:\s+(?:my|the))?(?:\s+(?:pool|nav))?\s*(?:nav\s*)?(?:of\s+[a-z0-9 ]+?)?\s*(?:between|across)\s+([a-z0-9 ]+?)\s+(?:and|to)\s+([a-z0-9 ]+?)(?:\s*[.,;!]|\s+(?:calculat|so\b|in\b|and\b|with\b)|$)/i,
  );
  if (between) {
    return {
      name: "crosschain_sync",
      args: {
        sourceChain: between[1].trim(),
        destinationChain: between[2].trim(),
        ...(wantsEqualize ? { equalizeNav: true } : {}),
      },
    };
  }

  // Extract chain pair for loose patterns: "crosschain sync arbitrum bsc"
  // Only if we have "sync" + two recognizable chain names
  const CHAIN_NAMES = /\b(ethereum|eth|mainnet|arbitrum|arb|optimism|op|base|polygon|matic|bsc|bnb|unichain)\b/gi;
  const chains = [...m.matchAll(CHAIN_NAMES)].map(match => match[1]);
  if (chains.length >= 2) {
    return {
      name: "crosschain_sync",
      args: {
        sourceChain: chains[0],
        destinationChain: chains[1],
        ...(wantsEqualize ? { equalizeNav: true } : {}),
      },
    };
  }

  return null;
}

// ── Fast-path: TWAP order creation ───────────────────────────────────
// Detects: "sell 100 GRG for ETH, 25 at a time every 5 min [using 0x]"
//          "buy 50 ETH with USDC 10 at a time every 10 minutes"
//
// The "N at a time every M minutes" pattern is unambiguous — only create_twap_order
// handles it. Bypassing the LLM avoids Llama hallucinating non-existent tool names
// like "sell_token" or "schedule_swap".

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
function tryFastPathSwap(msg: string): FastPathResult | null {
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

  // Extract chain modifier first ("on base", "on arbitrum") — always appears last
  let chain: string | undefined;
  const chainMatch = m.match(/\s+on\s+([a-z0-9 ]+?)$/i);
  if (chainMatch) {
    const possibleChain = chainMatch[1].trim().toLowerCase();
    // Only match known chain names to avoid eating "on uniswap" or "on 0x"
    if (/^(ethereum|base|arbitrum|optimism|polygon|bsc|bnb|unichain)$/i.test(possibleChain)) {
      chain = possibleChain;
      m = m.slice(0, chainMatch.index!).trim();
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

  return null;
}

// ── Fast-path: GMX commands ──────────────────────────────────────────
// Regex-matches well-structured GMX commands to bypass the LLM entirely.

/**
 * Attempt to parse a GMX command directly from the user message.
 * Returns tool name + args if matched, null otherwise.
 *
 * Supported patterns:
 *   "long 100 XAUTUSD 5x"        → gmx_open_position, notionalUsd=100, leverage=5
 *   "short 500 ethusdc 10x"       → gmx_open_position, notionalUsd=500, leverage=10
 *   "close my ETH long"           → gmx_close_position
 *   "show positions" / "my perps" → gmx_get_positions
 *   "gmx markets"                 → gmx_get_markets
 */
function tryFastPathGmx(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  // ── Open position: "long/short <amount> <market> <leverage>x" ──
  const openMatch = m.match(
    /^(long|short)\s+([\d.,]+)\s+([a-z0-9.]+?)(?:usd[ct]?|perp)?\s+(\d+(?:\.\d+)?)x$/i,
  );
  if (openMatch) {
    const isLong = openMatch[1].toLowerCase() === "long";
    const notional = openMatch[2].replace(/,/g, "");
    const market = openMatch[3].toUpperCase();
    const leverage = openMatch[4];
    return {
      name: "gmx_open_position",
      args: { market, isLong, notionalUsd: notional, leverage, collateral: "USDC" },
    };
  }

  // ── Open position with explicit collateral: "long ETH 5x with 200 USDC" ──
  const openCollateralMatch = m.match(
    /^(long|short)\s+([a-z0-9.]+?)(?:usd[ct]?|perp)?\s+(\d+(?:\.\d+)?)x\s+(?:with|using)\s+([\d.,]+)\s+([a-z0-9.]+)$/i,
  );
  if (openCollateralMatch) {
    const isLong = openCollateralMatch[1].toLowerCase() === "long";
    const market = openCollateralMatch[2].toUpperCase();
    const leverage = openCollateralMatch[3];
    const collateralAmount = openCollateralMatch[4].replace(/,/g, "");
    const collateral = openCollateralMatch[5].toUpperCase();
    return {
      name: "gmx_open_position",
      args: { market, isLong, collateralAmount, collateral, leverage },
    };
  }

  // ── Close position: "close [my] ETH long/short" ──
  const closeMatch = m.match(
    /^close\s+(?:my\s+)?([a-z0-9.]+?)(?:usd[ct]?|perp)?\s+(long|short)$/i,
  );
  if (closeMatch) {
    return {
      name: "gmx_close_position",
      args: {
        market: closeMatch[1].toUpperCase(),
        isLong: closeMatch[2].toLowerCase() === "long",
        sizeDeltaUsd: "all",
        collateral: "USDC",
      },
    };
  }

  // ── Show positions ──
  if (
    /^(?:show\s+)?(?:my\s+)?(?:perps?|positions?|gmx\s+positions?)$/i.test(m) ||
    /^what(?:'s|\s+is)?\s+(?:my\s+)?(?:gmx\s+)?(?:perps?|positions?)\??$/i.test(m) ||
    /^what\s+are\s+(?:my\s+)?(?:gmx\s+)?(?:perps?|positions?)\??$/i.test(m)
  ) {
    return { name: "gmx_get_positions", args: {} };
  }

  // ── List markets ──
  if (/^(?:gmx\s+)?markets?$|^(?:list|show|available)\s+(?:gmx\s+)?markets?$/i.test(m)) {
    return { name: "gmx_get_markets", args: {} };
  }

  return null;
}

// ── Fast-path: Uniswap LP commands ───────────────────────────────────

/**
 * Detect LP position queries:
 *   "what are my uniswap liquidity positions?"
 *   "show my lp positions"
 *   "list uniswap positions on arbitrum"
 */
function tryFastPathUniswapLP(msg: string): FastPathResult | null {
  const m = msg.toLowerCase().trim();

  // ── Burn closed position NFT: "burn uniswap liquidity position 152709 token" ──
  const burnMatch = m.match(
    /^(?:burn|delete|cleanup|clean\s*up)\s+(?:my\s+)?(?:uniswap\s+)?(?:v4\s+)?(?:liquidity\s+)?position\s+#?(\d+)(?:\s+token|\s+nft)?(?:\s+on\s+([a-z0-9 ]+))?\??$/i,
  );
  if (burnMatch) {
    const args: Record<string, unknown> = { tokenId: burnMatch[1] };
    if (burnMatch[2]) args.chain = burnMatch[2].trim();
    return { name: "burn_position", args };
  }

  // ── Closed positions queries map to get_lp_positions (it already labels Active/Closed) ──
  const closedWithChain = m.match(
    /^(?:show|list|what(?:'s|\s+is|\s+are)?)\s+(?:my\s+)?(?:closed\s+)?(?:uniswap\s+)?(?:v4\s+)?(?:liquidity\s+)?(?:lp\s+)?positions?\s+on\s+([a-z0-9 ]+)\??$/i,
  );
  if (closedWithChain) {
    return { name: "get_lp_positions", args: { chain: closedWithChain[1].trim() } };
  }

  if (/^(?:show|list|what(?:'s|\s+is|\s+are)?)\s+(?:my\s+)?closed\s+(?:uniswap\s+)?(?:v4\s+)?(?:liquidity\s+)?(?:lp\s+)?positions?\??$/i.test(m)) {
    return { name: "get_lp_positions", args: {} };
  }

  const lpWithChain = m.match(
    /^(?:what(?:'s|\s+is|\s+are)?\s+)?(?:show|list)?\s*(?:my\s+)?(?:uniswap\s+)?(?:v4\s+)?(?:liquidity\s+)?(?:lp\s+)?positions?\s+on\s+([a-z0-9 ]+)\??$/i,
  );
  if (lpWithChain) {
    return { name: "get_lp_positions", args: { chain: lpWithChain[1].trim() } };
  }

  if (
    /^(?:what(?:'s|\s+is|\s+are)?\s+)?(?:show|list)?\s*(?:my\s+)?(?:uniswap\s+)?(?:v4\s+)?(?:liquidity\s+)?(?:lp\s+)?positions?\??$/i.test(m)
  ) {
    return { name: "get_lp_positions", args: {} };
  }

  return null;
}
