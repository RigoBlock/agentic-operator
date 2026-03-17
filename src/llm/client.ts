/**
 * LLM Client — OpenAI-compatible chat completion with tool calling.
 *
 * Supports two execution modes:
 *   - Manual: Agent builds unsigned transactions, operator signs from their wallet.
 *   - Delegated: Agent wallet executes via EIP-7702 delegation after operator
 *     confirms trade details (no manual signing required).
 */

import OpenAI from "openai";
import type { Env, ChatMessage, ChatResponse, ToolCallResult, SwapIntent, UnsignedTransaction, RequestContext } from "../types.js";
import { TOOL_DEFINITIONS, SYSTEM_PROMPT } from "./tools.js";
import { getUniswapQuote, getUniswapSwapCalldata, formatUniswapQuoteForDisplay } from "../services/uniswapTrading.js";
import { getZeroXQuote, formatZeroXQuoteForDisplay } from "../services/zeroXTrading.js";
import { getVaultInfo, getVaultTokenBalance, encodeVaultExecute, getTokenDecimals, getPoolData, getNavData, encodeMint, getClient } from "../services/vault.js";
import { resolveTokenAddress, SUPPORTED_CHAINS, TESTNET_CHAINS, sanitizeError, STAKING_PROXY } from "../config.js";
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
  computeLeverage,
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
import { CROSSCHAIN_TOKENS, getSupportedDestinations, findBridgeableToken } from "../services/crosschainConfig.js";
import { addStrategy, removeStrategy, removeAllStrategies, getStrategies, MIN_INTERVAL_MINUTES, MAX_STRATEGIES_PER_VAULT } from "../services/strategy.js";
import { getTelegramUserIdByAddress } from "../services/telegramPairing.js";
import { buildAddLiquidityTx, buildRemoveLiquidityTx, getVaultLPPositions, buildCollectFeesTx } from "../services/uniswapLP.js";
import {
  buildStakeCalldata,
  buildUndelegateStakeCalldata,
  buildUnstakeCalldata,
  buildEndEpochCalldata,
  buildWithdrawDelegatorRewardsCalldata,
} from "../services/grgStaking.js";

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
): Promise<ChatResponse> {
  const openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: 25_000, // 25s — stay well within Cloudflare's 30s subrequest limit
  });

  // Build system prompt with vault context
  const executionModeNote = ctx.executionMode === "delegated"
    ? "The operator has enabled DELEGATED mode. After you build a transaction, the agent wallet will execute it automatically once the operator confirms the trade details. The operator does NOT need to sign the transaction manually."
    : "The operator will sign and broadcast transactions from their own wallet.\nYou build the transaction; they approve it.";

  const contextualPrompt = `${SYSTEM_PROMPT}

CURRENT SESSION CONTEXT:
- Vault address: ${ctx.vaultAddress}
- Chain ID: ${ctx.chainId}
- Operator wallet: ${ctx.operatorAddress || "not connected"}
- Execution mode: ${ctx.executionMode || "manual"}

${executionModeNote}`;

  // Prepend system prompt
  const fullMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: contextualPrompt },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  // ── Fast-path: regex-match common commands to skip the LLM call ──
  const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content?.trim() || "";

  // Try chain switch first (cheapest — no tool execution)
  const fastChainSwitch = tryFastPathChainSwitch(lastUserMsg);
  if (fastChainSwitch) {
    console.log(`[LLM] Fast-path chain switch: ${fastChainSwitch.args.chain}`);
    try {
      const toolResult = await executeToolCall(env, ctx, fastChainSwitch.name, fastChainSwitch.args);
      return {
        reply: toolResult.message,
        toolCalls: [{ name: fastChainSwitch.name, arguments: fastChainSwitch.args, result: toolResult.message, error: false }],
        chainSwitch: toolResult.chainSwitch,
      };
    } catch (err) {
      console.log(`[LLM] Fast-path chain switch error, falling back to LLM: ${err}`);
    }
  }

  // Try swap fast-path
  const fastSwap = tryFastPathSwap(lastUserMsg);
  if (fastSwap) {
    console.log(`[LLM] Fast-path swap: ${fastSwap.name}(${JSON.stringify(fastSwap.args)})`);
    try {
      const toolResult = await executeToolCall(env, ctx, fastSwap.name, fastSwap.args);
      return {
        reply: "",
        toolCalls: [{ name: fastSwap.name, arguments: fastSwap.args, result: toolResult.message, error: false }],
        transaction: toolResult.transaction,
        chainSwitch: toolResult.chainSwitch,
        suggestions: toolResult.suggestions,
      };
    } catch (err) {
      console.log(`[LLM] Fast-path swap error, falling back to LLM: ${err}`);
    }
  }

  // Try GMX fast-path
  const fastPath = tryFastPathGmx(lastUserMsg);
  if (fastPath) {
    console.log(`[LLM] Fast-path GMX: ${fastPath.name}(${JSON.stringify(fastPath.args)})`);
    try {
      const toolResult = await executeToolCall(env, ctx, fastPath.name, fastPath.args);
      return {
        reply: "",
        toolCalls: [{ name: fastPath.name, arguments: fastPath.args, result: toolResult.message, error: false }],
        transaction: toolResult.transaction,
        chainSwitch: toolResult.chainSwitch,
        suggestions: toolResult.suggestions,
        dexProvider: "GMX",
      };
    } catch (err) {
      console.log(`[LLM] Fast-path GMX error, falling back to LLM: ${err}`);
    }
  }

  // First LLM call
  console.log(`[LLM] Calling OpenAI gpt-5-mini with ${fullMessages.length} messages, ${TOOL_DEFINITIONS.length} tools`);
  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: fullMessages,
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
  });
  console.log(`[LLM] Response: finish_reason=${response.choices[0]?.finish_reason}, tool_calls=${response.choices[0]?.message?.tool_calls?.length ?? 0}`);

  const choice = response.choices[0];
  if (!choice) throw new Error("No response from LLM");

  const toolCallResults: ToolCallResult[] = [];
  const pendingTransactions: UnsignedTransaction[] = [];
  let pendingChainSwitch: number | undefined;
  let detectedDex: string | undefined;
  let pendingSuggestions: string[] | undefined;
  let pendingSelfContained = false;

  // If the LLM wants to call tools
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    const toolMessages: OpenAI.ChatCompletionMessageParam[] = [
      ...fullMessages,
      choice.message,
    ];

    for (const toolCall of choice.message.tool_calls) {
      const { name, arguments: argsStr } = toolCall.function;
      let args = JSON.parse(argsStr);
      console.log(`[LLM] Tool call: ${name}(${argsStr})`);

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
          pendingTransactions.push(toolResult.transaction);
        }
        if (toolResult.chainSwitch) {
          pendingChainSwitch = toolResult.chainSwitch;
          // Update context for subsequent tool calls in this turn
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
          const dexArg = (args.dex as string).toLowerCase();
          detectedDex = (dexArg === "uniswap") ? "Uniswap" : "0x";
        } else if ((name === "get_swap_quote" || name === "build_vault_swap") && !args.dex) {
          detectedDex = "Uniswap"; // default
        } else if (name.startsWith("gmx_")) {
          detectedDex = "GMX";
        }
      } catch (err) {
        result = `Error: ${sanitizeError(err instanceof Error ? err.message : String(err))}`;
        isError = true;
      }

      toolCallResults.push({
        name,
        arguments: args,
        result,
        error: isError,
      });

      // Notify caller of intermediate results (e.g. Telegram sends progress message)
      if (onToolResult) await onToolResult(name, result, isError).catch(() => {});

      toolMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // If we already have transaction(s), skip the follow-up LLM call entirely.
    // The tool result messages already contain all the details the user needs.
    // This saves ~1-2 seconds of latency and avoids Cloudflare timeout for multi-swap.
    if (pendingTransactions.length > 0) {
      console.log(`[processChat] Skipping follow-up LLM call — ${pendingTransactions.length} transaction(s) ready`);
      // Surface errors from failed tool calls so the user sees them prominently
      const failedCalls = toolCallResults.filter(tc => tc.error);
      const errorReply = failedCalls.length > 0
        ? failedCalls.map(e => `⚠️ ${e.result}`).join('\n')
        : "";
      return {
        reply: errorReply,
        toolCalls: toolCallResults,
        transaction: pendingTransactions[pendingTransactions.length - 1],
        transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
        chainSwitch: pendingChainSwitch,
        dexProvider: detectedDex,
        suggestions: pendingSuggestions,
      };
    }

    // If we have suggestions (e.g., positions dashboard), the report is self-contained.
    // Skip follow-up LLM call to return verbatim instead of wrapping.
    if (pendingSuggestions?.length) {
      console.log("[processChat] Skipping follow-up LLM call — self-contained report with suggestions");
      const report = toolCallResults
        .filter(tc => !tc.error && tc.result)
        .map(tc => tc.result)
        .join("\n");
      return {
        reply: report,
        toolCalls: [],
        chainSwitch: pendingChainSwitch,
        suggestions: pendingSuggestions,
      };
    }

    // Self-contained reports (e.g., LP positions table) — skip follow-up LLM call
    // to prevent the LLM from paraphrasing the already-formatted result.
    if (pendingSelfContained) {
      console.log("[processChat] Skipping follow-up LLM call — self-contained report");
      const report = toolCallResults
        .filter(tc => !tc.error && tc.result)
        .map(tc => tc.result)
        .join("\n");
      return {
        reply: report,
        toolCalls: [],
        chainSwitch: pendingChainSwitch,
      };
    }

    // Second LLM call with tool results — only needed for non-transaction results
    // (e.g., quotes, vault info, balance checks, chain switches)
    console.log(`[LLM] Follow-up call with ${toolMessages.length} messages (incl. ${toolCallResults.length} tool results)`);
    const followUp = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: toolMessages,
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    });
    console.log(`[LLM] Follow-up: finish_reason=${followUp.choices[0]?.finish_reason}, tool_calls=${followUp.choices[0]?.message?.tool_calls?.length ?? 0}`);

    const followUpChoice = followUp.choices[0];

    // Handle chained tool calls from the follow-up
    if (followUpChoice?.finish_reason === "tool_calls" && followUpChoice.message.tool_calls) {
      const chainMessages: OpenAI.ChatCompletionMessageParam[] = [
        ...toolMessages,
        followUpChoice.message,
      ];

      for (const toolCall of followUpChoice.message.tool_calls) {
        const { name, arguments: argsStr } = toolCall.function;
        let args = JSON.parse(argsStr);
        let result: string;
        let isError = false;

        // Sanitize swap tool arguments in chained calls too
        if (name === "get_swap_quote" || name === "build_vault_swap") {
          const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content || "";
          args = sanitizeSwapArgs(args, lastUserMsg);
          console.log(`[LLM] Sanitized chained args: ${JSON.stringify(args)}`);
        }

        try {
          const toolResult = await executeToolCall(env, ctx, name, args);
          result = toolResult.message;
          if (toolResult.transaction) pendingTransactions.push(toolResult.transaction);
          if (toolResult.chainSwitch) {
            pendingChainSwitch = toolResult.chainSwitch;
            ctx.chainId = toolResult.chainSwitch;
          }
          // Detect DEX from chained tool call args
          if ((name === "get_swap_quote" || name === "build_vault_swap") && args.dex) {
            const dexArg = (args.dex as string).toLowerCase();
            detectedDex = (dexArg === "uniswap") ? "Uniswap" : "0x";
          } else if ((name === "get_swap_quote" || name === "build_vault_swap") && !args.dex) {
            detectedDex = "Uniswap";
          } else if (name.startsWith("gmx_")) {
            detectedDex = "GMX";
          }
        } catch (err) {
          result = `Error: ${sanitizeError(err instanceof Error ? err.message : String(err))}`;
          isError = true;
        }
        toolCallResults.push({ name, arguments: args, result, error: isError });
        if (onToolResult) await onToolResult(name, result, isError).catch(() => {});
        chainMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }

      // Skip third LLM call if transaction is ready
      if (pendingTransactions.length > 0) {
        console.log(`[processChat] Skipping chain follow-up LLM call — ${pendingTransactions.length} transaction(s) ready`);
        return {
          reply: "",
          toolCalls: toolCallResults,
          transaction: pendingTransactions[pendingTransactions.length - 1],
          transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
          chainSwitch: pendingChainSwitch,
          dexProvider: detectedDex,
        };
      }

      console.log(`[LLM] Chain follow-up with ${chainMessages.length} messages`);
      const chainFollowUp = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: chainMessages,
      });

      return {
        reply: chainFollowUp.choices[0]?.message?.content || "Done.",
        toolCalls: toolCallResults,
        transaction: pendingTransactions[pendingTransactions.length - 1],
        transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
        chainSwitch: pendingChainSwitch,
        dexProvider: detectedDex,
      };
    }

    return {
      reply: followUpChoice?.message?.content || "Done.",
      toolCalls: toolCallResults,
      transaction: pendingTransactions[pendingTransactions.length - 1],
      transactions: pendingTransactions.length > 0 ? pendingTransactions : undefined,
      chainSwitch: pendingChainSwitch,
      dexProvider: detectedDex,
    };
  }

  // No tool calls — direct response
  return {
    reply: choice.message.content || "",
    toolCalls: [],
  };
}

// ── Gas estimation helper ─────────────────────────────────────────────

const DEFAULT_GAS: Record<string, bigint> = {
  approve:    65_000n,
  delegation: 250_000n,
  deploy:     600_000n,
  swap:     1_000_000n,
  gmx:      1_500_000n,
  bridge:   1_500_000n,
  default:  1_000_000n,
};

/**
 * Estimate gas for an unsigned transaction via eth_estimateGas.
 * Returns a hex string gas limit with 30% buffer, or falls back to a
 * category-based default if estimation fails (e.g. caller not owner).
 *
 * This is for the unsigned transactions returned to the frontend/operator.
 * The delegated execution path in execution.ts runs its own eth_estimateGas
 * before broadcasting — this estimate is for display and MetaMask hints.
 */
async function estimateGas(
  chainId: number,
  to: Address,
  data: Hex,
  value: string,
  from: Address | undefined,
  alchemyKey?: string,
  category: keyof typeof DEFAULT_GAS = "default",
): Promise<string> {
  if (!from) {
    // No sender address — can't estimate; use category default
    const fallback = DEFAULT_GAS[category] ?? DEFAULT_GAS.default;
    return `0x${fallback.toString(16)}`;
  }
  try {
    const client = getClient(chainId, alchemyKey);
    const txValue = BigInt(value);
    const estimated = await client.estimateGas({
      account: from,
      to,
      data,
      value: txValue,
    });
    // 30% buffer for execution variance
    const buffered = estimated + (estimated * 30n) / 100n;
    return `0x${buffered.toString(16)}`;
  } catch (err) {
    // Estimation can fail if the tx would revert (e.g. insufficient balance,
    // delegation required). Fall back to category default for display.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[estimateGas] Failed for chain ${chainId} (${category}): ${msg.slice(0, 120)}`);
    const fallback = DEFAULT_GAS[category] ?? DEFAULT_GAS.default;
    return `0x${fallback.toString(16)}`;
  }
}

interface ToolResult {
  message: string;
  transaction?: UnsignedTransaction;
  chainSwitch?: number;
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
  /** When true, the message is a complete report — skip the follow-up LLM call */
  selfContained?: boolean;
}

/**
 * Execute a single tool call. Returns a message and optionally an unsigned transaction.
 */
async function executeToolCall(
  env: Env,
  ctx: RequestContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
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

      const intent: SwapIntent = {
        tokenIn: args.tokenIn as string,
        tokenOut: args.tokenOut as string,
        amountIn: args.amountIn as string | undefined,
        amountOut: args.amountOut as string | undefined,
        // SECURITY: Slippage is hardcoded server-side at 1% (100 bps).
        // Not exposed to the LLM to prevent a compromised agent from
        // setting arbitrary slippage and enabling sandwich attacks.
        slippageBps: 100,
      };
      if (!intent.amountIn && !intent.amountOut) {
        throw new Error("Either amountIn or amountOut must be specified.");
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

      const intent: SwapIntent = {
        tokenIn: args.tokenIn as string,
        tokenOut: args.tokenOut as string,
        amountIn: args.amountIn as string | undefined,
        amountOut: args.amountOut as string | undefined,
        // SECURITY: Slippage hardcoded at 1% — not controllable by the LLM.
        slippageBps: 100,
      };
      if (!intent.amountIn && !intent.amountOut) {
        throw new Error("Either amountIn or amountOut must be specified.");
      }

      // Ownership already verified by auth layer (verifyOperatorAuth checks
      // all supported chains). Skipping redundant on-chain owner() call here
      // avoids an extra RPC round-trip and prevents errors when the vault
      // contract doesn't exist on the currently-selected chain.

      // Resolve chain name for display
      const chainName = resolveChainName(ctx.chainId);

      // Determine which DEX to use
      const dex = ((args.dex as string) || "0x").toLowerCase();

      if (dex === "0x" || dex === "zerox") {
        // ── 0x AllowanceHolder flow ──
        const zxQuote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress);

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

        return { message, transaction, chainSwitch: chainSwitched };
      }

      // ── Uniswap flow (default) ──

      // 2. Get quote from Uniswap Trading API
      const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);

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

      return { message, transaction, chainSwitch: chainSwitched };
    }

    case "get_vault_info": {
      const info = await getVaultInfo(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
      return {
        message: [
          `Vault: ${info.name} (${info.symbol})`,
          `Address: ${info.address}`,
          `Owner: ${info.owner}`,
          `Total Supply: ${info.totalSupply}`,
        ].join("\n"),
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
      return { message: `Vault holds ${formatted.toFixed(6)} ${symbol}` };
    }

    case "switch_chain": {
      const match = resolveChainArg((args.chain as string).trim());
      return {
        message: `Switched to ${match.name} (chain ${match.id}). All subsequent operations will use this chain.`,
        chainSwitch: match.id,
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
      const collateralAddr = resolveGmxCollateral(collateralSymbol);
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
      const collateralAddr = resolveGmxCollateral(collateralSymbol);
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
      const result = await prepareDelegation(
        env,
        ctx.operatorAddress,
        ctx.vaultAddress as Address,
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

      const message = [
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
      const useNativeEth = args.useNativeEth as boolean | undefined;
      const shouldUnwrapOnDestination = args.shouldUnwrapOnDestination as boolean | undefined;

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
        useNativeEth: useNativeEth ?? false,
        // If vault wraps native ETH→WETH for bridging, unwrap on destination too.
        // If user is sending actual WETH tokens, they want WETH on destination.
        shouldUnwrapOnDestination: shouldUnwrapOnDestination ?? (useNativeEth ?? false),
        alchemyKey: env.ALCHEMY_API_KEY,
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
      const tokenSymbol = args.token as string | undefined;
      const amount = args.amount as string | undefined;
      const navToleranceBps = args.navToleranceBps as number | undefined;

      if (!destChainArg) {
        throw new Error("destinationChain is required for crosschain_sync.");
      }

      const srcChainId = srcChainArg
        ? resolveChainArg(srcChainArg.trim()).id
        : ctx.chainId;
      const srcName = resolveChainName(srcChainId);
      const destMatch = resolveChainArg(destChainArg.trim());

      if (srcChainId === destMatch.id) {
        throw new Error(
          `Source and destination are both ${destMatch.name}. Cross-chain sync requires different chains.`,
        );
      }

      const result = await buildCrosschainSync({
        vaultAddress: ctx.vaultAddress as Address,
        srcChainId,
        dstChainId: destMatch.id,
        tokenSymbol,
        amount,
        navToleranceBps,
        alchemyKey: env.ALCHEMY_API_KEY,
      });

      const syncGas = await estimateGas(
        srcChainId, ctx.vaultAddress as Address,
        result.calldata as Hex, "0x0",
        ctx.operatorAddress, env.ALCHEMY_API_KEY, "bridge",
      );

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: srcChainId,
        gas: syncGas,
        description: result.description,
      };

      const toleranceDisplay = navToleranceBps
        ? `${(navToleranceBps / 100).toFixed(2)}%`
        : "1.00% (default)";

      const message = [
        `✅ NAV sync ready`,
        `Route: ${srcName} → ${destMatch.name}`,
        `Sync amount: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
        `NAV tolerance: ${toleranceDisplay}`,
        `Bridge fee: ${result.quote.feePct}`,
        `Estimated time: ${result.quote.estimatedTime}`,
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
        if (snap.totalValue === 0n && snap.tokenBalances.every((b) => b.balance === 0n)) {
          continue; // skip chains with no data
        }
        const delegation = snap.delegationActive ? "✅" : "❌";
        const unitaryStr = (Number(snap.unitaryValue) / 1e18).toFixed(6);
        const tokenLines = snap.tokenBalances
          .filter((b) => b.balance > 0n)
          .map((b) => `    ${b.token.symbol}: ${b.balanceFormatted}`)
          .join("\n");

        chainLines.push(
          `  **${snap.chainName}** (delegation: ${delegation})` +
          `\n    Base token: ${snap.baseTokenSymbol} | Unitary value: ${unitaryStr}` +
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
        suggestions: [
          "Rebalance to Base",
          "Rebalance to Arbitrum",
          "Bridge USDC to Base",
          "Sync NAV to Arbitrum",
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

    // ── Automated strategies ──────────────────────────────────────────

    case "create_strategy": {
      const instruction = args.instruction as string;
      const intervalMinutes = Math.max(
        MIN_INTERVAL_MINUTES,
        Math.round(Number(args.intervalMinutes) || 480),
      );

      if (!ctx.operatorAddress) {
        throw new Error("Wallet not connected — cannot create strategy.");
      }

      // Check Telegram pairing
      const tgUserId = await getTelegramUserIdByAddress(
        env.KV,
        ctx.operatorAddress,
      );
      if (!tgUserId) {
        return {
          message:
            "⚠️ Telegram not paired. Strategies send notifications via Telegram.\n\n" +
            "Please pair your Telegram first using the 'Pair Telegram' button, then try again.",
          suggestions: ["Pair Telegram"],
        };
      }

      const strategy = await addStrategy(env.KV, {
        instruction,
        intervalMinutes,
        vaultAddress: ctx.vaultAddress,
        chainId: ctx.chainId,
        operatorAddress: ctx.operatorAddress,
      });

      const intervalStr = intervalMinutes >= 60
        ? `${(intervalMinutes / 60).toFixed(intervalMinutes % 60 ? 1 : 0)} hour${intervalMinutes >= 120 ? "s" : ""}`
        : `${intervalMinutes} minutes`;

      return {
        message:
          `✅ Strategy #${strategy.id} created!\n\n` +
          `• Instruction: "${instruction}"\n` +
          `• Check interval: every ${intervalStr}\n` +
          `• Notifications: via Telegram\n\n` +
          `I'll evaluate this instruction periodically and notify you with recommendations. ` +
          `You'll need to confirm via Telegram before any execution.`,
        suggestions: ["List strategies", "Create another strategy", "Remove strategy"],
      };
    }

    case "remove_strategy": {
      const id = Number(args.id);

      if (id === 0) {
        const count = await removeAllStrategies(env.KV, ctx.vaultAddress);
        return {
          message: count > 0
            ? `✅ Removed all ${count} strategies for this vault.`
            : "No strategies found for this vault.",
          suggestions: ["Create a strategy"],
        };
      }

      const removed = await removeStrategy(env.KV, ctx.vaultAddress, id);
      return {
        message: removed
          ? `✅ Strategy #${id} removed.`
          : `Strategy #${id} not found. Use "list strategies" to see active ones.`,
        suggestions: ["List strategies", "Create a strategy"],
      };
    }

    case "list_strategies": {
      const strategies = await getStrategies(env.KV, ctx.vaultAddress);

      if (strategies.length === 0) {
        return {
          message: "No automated strategies configured for this vault.",
          suggestions: ["Create a strategy"],
        };
      }

      const lines = strategies.map((s) => {
        const status = s.active ? "✅ Active" : "⏸️ Paused";
        const intervalStr = s.intervalMinutes >= 60
          ? `${(s.intervalMinutes / 60).toFixed(s.intervalMinutes % 60 ? 1 : 0)}h`
          : `${s.intervalMinutes}m`;
        const lastRun = s.lastRun
          ? new Date(s.lastRun).toISOString().slice(0, 16).replace("T", " ")
          : "never";
        const errors = s.consecutiveFailures > 0
          ? ` | ⚠️ ${s.consecutiveFailures} failure${s.consecutiveFailures > 1 ? "s" : ""}`
          : "";
        return (
          `  **#${s.id}** [${status}] every ${intervalStr}\n` +
          `    "${s.instruction}"\n` +
          `    Last run: ${lastRun}${errors}`
        );
      });

      return {
        message:
          `📋 **Strategies for this vault** (${strategies.length}/${MAX_STRATEGIES_PER_VAULT}):\n\n` +
          lines.join("\n\n"),
        suggestions: [
          "Create a strategy",
          strategies.length > 0 ? `Remove strategy ${strategies[0].id}` : "",
        ].filter(Boolean),
      };
    }

    // ── Uniswap v4 LP ──────────────────────────────────────────────────

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
        amountA: args.amountA as string,
        amountB: args.amountB as string,
        fee: args.fee as number | undefined,
        tickSpacing: args.tickSpacing as number | undefined,
        tickRange: (args.tickRange as string) || "full",
      }, ctx.chainId, ctx.vaultAddress as Address);

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas: "0x7A120",  // 500k gas estimate — wallet re-estimates on sign
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      const message = [
        `✅ Add Liquidity ready`,
        `${result.description}`,
        `Tick range: [${result.tickLower}, ${result.tickUpper}]`,
        `Pool ID: \`${result.poolId}\``,
        `Chain: ${chainName}`,
        ``,
        `💡 The vault must hold sufficient balances of both tokens. Review and sign to create the LP position.`,
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

      const result = await buildRemoveLiquidityTx(env, {
        tokenA: args.tokenA as string,
        tokenB: args.tokenB as string,
        tokenId: args.tokenId as string,
        liquidityAmount: args.liquidityAmount as string,
        burn: args.burn as boolean | undefined,
      }, ctx.chainId, ctx.vaultAddress as Address);

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas: "0x7A120",  // 500k gas estimate — wallet re-estimates on sign
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      return {
        message: `✅ Remove Liquidity ready\n${result.description}\nChain: ${chainName}\n\n💡 Review and sign to remove the LP position.`,
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
          message: `No active Uniswap v4 LP positions found for this vault on ${chainName}.`,
          chainSwitch: chainSwitched,
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

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas: "0x7A120",
        description: result.description,
      };

      const chainName = resolveChainName(ctx.chainId);
      return {
        message: `✅ Fee Collection ready\n${result.description}\nChain: ${chainName}\n\n💡 Sign to collect accrued trading fees from this LP position.`,
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

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas: "0x493E0",  // 300k gas
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

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas: "0x493E0",
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

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas: "0x493E0",  // 300k gas
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

      const transaction: UnsignedTransaction = {
        to: stakingProxy,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas: "0x7A120",  // 500k — epoch finalization can be gas-intensive
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

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: 1,
        gas: "0x493E0",
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
  const m = msg.trim();

  // ── "sell <amount> <tokenIn> for <tokenOut> [on <chain>]" ──
  const sellMatch = m.match(
    /^sell\s+([\d.,]+)\s+([a-z0-9]+)\s+(?:for|to|into)\s+([a-z0-9]+)(?:\s+on\s+([a-z0-9 ]+))?$/i,
  );
  if (sellMatch) {
    const args: Record<string, unknown> = {
      tokenIn: sellMatch[2].toUpperCase(),
      tokenOut: sellMatch[3].toUpperCase(),
      amountIn: sellMatch[1].replace(/,/g, ""),
    };
    if (sellMatch[4]) args.chain = sellMatch[4].trim();
    return { name: "build_vault_swap", args };
  }

  // ── "buy <amount> <tokenOut> [with <tokenIn>] [on <chain>]" ──
  const buyMatch = m.match(
    /^buy\s+([\d.,]+)\s+([a-z0-9]+)(?:\s+(?:with|using|for)\s+([a-z0-9]+))?(?:\s+on\s+([a-z0-9 ]+))?$/i,
  );
  if (buyMatch) {
    const args: Record<string, unknown> = {
      tokenOut: buyMatch[2].toUpperCase(),
      amountOut: buyMatch[1].replace(/,/g, ""),
    };
    // Default tokenIn to USDC if not specified
    args.tokenIn = buyMatch[3] ? buyMatch[3].toUpperCase() : "USDC";
    if (buyMatch[4]) args.chain = buyMatch[4].trim();
    return { name: "build_vault_swap", args };
  }

  // ── "swap <amount> <tokenIn> for/to <tokenOut> [on <chain>]" ──
  const swapMatch = m.match(
    /^swap\s+([\d.,]+)\s+([a-z0-9]+)\s+(?:for|to|into)\s+([a-z0-9]+)(?:\s+on\s+([a-z0-9 ]+))?$/i,
  );
  if (swapMatch) {
    const args: Record<string, unknown> = {
      tokenIn: swapMatch[2].toUpperCase(),
      tokenOut: swapMatch[3].toUpperCase(),
      amountIn: swapMatch[1].replace(/,/g, ""),
    };
    if (swapMatch[4]) args.chain = swapMatch[4].trim();
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
  if (/^(?:show\s+)?(?:my\s+)?(?:perps?|positions?|gmx\s+positions?)$/i.test(m)) {
    return { name: "gmx_get_positions", args: {} };
  }

  // ── List markets ──
  if (/^(?:gmx\s+)?markets?$|^(?:list|show|available)\s+(?:gmx\s+)?markets?$/i.test(m)) {
    return { name: "gmx_get_markets", args: {} };
  }

  return null;
}
