/**
 * LLM Client — OpenAI-compatible chat completion with tool calling.
 *
 * The agent builds unsigned transactions and returns them to the frontend.
 * The operator reviews and signs/broadcasts from their own wallet.
 * No agent wallet or delegation involved (Phase 1).
 */

import OpenAI from "openai";
import type { Env, ChatMessage, ChatResponse, ToolCallResult, SwapIntent, UnsignedTransaction, RequestContext } from "../types.js";
import { TOOL_DEFINITIONS, SYSTEM_PROMPT } from "./tools.js";
import { getUniswapQuote, getUniswapSwapCalldata, formatUniswapQuoteForDisplay, calculateVaultGasLimit } from "../services/uniswapTrading.js";
import { getZeroXQuote, formatZeroXQuoteForDisplay } from "../services/zeroXTrading.js";
import { getVaultInfo, getVaultTokenBalance, encodeVaultExecute, getTokenDecimals } from "../services/vault.js";
import { resolveTokenAddress, SUPPORTED_CHAINS, TESTNET_CHAINS, sanitizeError } from "../config.js";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
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
  getGmxGasLimit,
} from "../services/gmxTrading.js";
import { getGmxPositionsSummary, getGmxPositions } from "../services/gmxPositions.js";
import { ARBITRUM_CHAIN_ID, GmxOrderType } from "../abi/gmx.js";

/**
 * Process a chat request: send to LLM, handle tool calls, return response.
 * If a tool call produces an unsigned transaction, it's included in the response
 * for the frontend to prompt the operator to sign.
 */
export async function processChat(
  env: Env,
  messages: ChatMessage[],
  ctx: RequestContext,
): Promise<ChatResponse> {
  const openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  });

  // Build system prompt with vault context
  const contextualPrompt = `${SYSTEM_PROMPT}

CURRENT SESSION CONTEXT:
- Vault address: ${ctx.vaultAddress}
- Chain ID: ${ctx.chainId}
- Operator wallet: ${ctx.operatorAddress || "not connected"}

The operator will sign and broadcast transactions from their own wallet.
You build the transaction; they approve it.`;

  // Prepend system prompt
  const fullMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: contextualPrompt },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

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
  let pendingTransaction: UnsignedTransaction | undefined;
  let pendingChainSwitch: number | undefined;
  let detectedDex: string | undefined;
  let pendingSuggestions: string[] | undefined;

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
          pendingTransaction = toolResult.transaction;
        }
        if (toolResult.chainSwitch) {
          pendingChainSwitch = toolResult.chainSwitch;
          // Update context for subsequent tool calls in this turn
          ctx.chainId = toolResult.chainSwitch;
        }
        if (toolResult.suggestions?.length) {
          pendingSuggestions = toolResult.suggestions;
        }
        // Detect DEX from tool call args
        if ((name === "get_swap_quote" || name === "build_vault_swap") && args.dex) {
          const dexArg = (args.dex as string).toLowerCase();
          detectedDex = (dexArg === "uniswap") ? "Uniswap" : "0x";
        } else if ((name === "get_swap_quote" || name === "build_vault_swap") && !args.dex) {
          detectedDex = "0x"; // default
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

      toolMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // If we already have a transaction, skip the follow-up LLM call entirely.
    // The tool result message already contains all the details the user needs.
    // This saves ~1-2 seconds of latency.
    // reply is empty to avoid duplicating the tool result in the chat.
    if (pendingTransaction) {
      console.log("[processChat] Skipping follow-up LLM call — transaction ready");
      return {
        reply: "",
        toolCalls: toolCallResults,
        transaction: pendingTransaction,
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
          if (toolResult.transaction) pendingTransaction = toolResult.transaction;
          if (toolResult.chainSwitch) {
            pendingChainSwitch = toolResult.chainSwitch;
            ctx.chainId = toolResult.chainSwitch;
          }
          // Detect DEX from chained tool call args
          if ((name === "get_swap_quote" || name === "build_vault_swap") && args.dex) {
            const dexArg = (args.dex as string).toLowerCase();
            detectedDex = (dexArg === "uniswap") ? "Uniswap" : "0x";
          } else if ((name === "get_swap_quote" || name === "build_vault_swap") && !args.dex) {
            detectedDex = "0x";
          }
        } catch (err) {
          result = `Error: ${sanitizeError(err instanceof Error ? err.message : String(err))}`;
          isError = true;
        }
        toolCallResults.push({ name, arguments: args, result, error: isError });
        chainMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }

      // Skip third LLM call if transaction is ready (same optimization as above)
      if (pendingTransaction) {
        console.log("[processChat] Skipping chain follow-up LLM call — transaction ready");
        return {
          reply: "",
          toolCalls: toolCallResults,
          transaction: pendingTransaction,
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
        transaction: pendingTransaction,
        chainSwitch: pendingChainSwitch,
        dexProvider: detectedDex,
      };
    }

    return {
      reply: followUpChoice?.message?.content || "Done.",
      toolCalls: toolCallResults,
      transaction: pendingTransaction,
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

interface ToolResult {
  message: string;
  transaction?: UnsignedTransaction;
  chainSwitch?: number;
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
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
        slippageBps: (args.slippageBps as number) || 100,
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
        slippageBps: (args.slippageBps as number) || 100,
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
        // Gas = 0x estimate + 200k vault adapter overhead
        const gasEstimate = BigInt(zxQuote.gas || "300000");
        const gasLimit = gasEstimate + 200_000n;

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

        const transaction: UnsignedTransaction = {
          to: ctx.vaultAddress as Address,
          data: zxQuote.transaction.data,
          value: "0x0", // vault uses its own ETH, never pass value
          chainId: ctx.chainId,
          gas: `0x${gasLimit.toString(16)}`,
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
          `Gas limit: ${gasLimit.toString()}`,
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

      // 6. Calculate gas: Uniswap estimate + 200k vault overhead
      const gasLimit = calculateVaultGasLimit(quote.quote.gasUseEstimate);

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
      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: vaultCalldata,
        value: "0x0",
        chainId: ctx.chainId,
        gas: `0x${gasLimit.toString(16)}`,
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
        `Gas limit: ${gasLimit.toString()}`,
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

      // Find market and get price
      const market = await findGmxMarket(marketSymbol);
      const collateralAddr = resolveGmxCollateral(collateralSymbol);
      const collateralDecimals = getGmxTokenDecimals(collateralAddr);
      const collateralPrice = await getGmxTokenPrice(collateralAddr);

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
      });

      const leverage = args.leverage || (parseFloat(sizeDeltaUsd) / (parseFloat(collateralAmount) * collateralPrice.mid)).toFixed(1);
      const gasLimit = getGmxGasLimit();
      const collateralValueUsdDisplay = (parseFloat(collateralAmount) * collateralPrice.mid).toFixed(2);

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: `0x${gasLimit.toString(16)}`,
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
        acceptablePriceUsd: args.acceptablePrice as string | undefined,
      });

      const gasLimit = getGmxGasLimit();
      const orderLabel = orderTypeStr === "limit" ? "Limit Decrease" : orderTypeStr.includes("stop") ? "Stop-Loss" : "Market Close";

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: `0x${gasLimit.toString(16)}`,
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
      const gasLimit = getGmxGasLimit();

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: `0x${gasLimit.toString(16)}`,
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

      const gasLimit = getGmxGasLimit();

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: `0x${gasLimit.toString(16)}`,
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

      const gasLimit = getGmxGasLimit();

      const transaction: UnsignedTransaction = {
        to: ctx.vaultAddress as Address,
        data: calldata,
        value: "0x0",
        chainId: ARBITRUM_CHAIN_ID,
        gas: `0x${gasLimit.toString(16)}`,
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
        lines.push(`  ${idx.symbol}/USD — $${idx.price.toFixed(2)}`);
      }
      lines.push("─".repeat(40));
      lines.push(`Total: ${seen.size} markets`);

      return { message: lines.join("\n") };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Resolve a chain name/shortName/ID to a supported chain entry. Throws if not found. */
function resolveChainArg(chainArg: string): { id: number; name: string; shortName: string } {
  const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS];
  const match = allChains.find(
    (c) =>
      c.name.toLowerCase() === chainArg.toLowerCase() ||
      c.shortName.toLowerCase() === chainArg.toLowerCase() ||
      c.id.toString() === chainArg,
  );
  if (!match) {
    throw new Error(
      `Unknown chain: ${chainArg}. Supported: ${allChains.map((c) => c.name).join(", ")}`,
    );
  }
  return match;
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
 * Sanitize and correct LLM-generated swap tool arguments.
 * Extracts intent directly from the user's message and overrides bad args.
 */
function sanitizeSwapArgs(
  args: Record<string, unknown>,
  userMessage: string,
): Record<string, unknown> {
  const msg = userMessage.toLowerCase().trim();
  const corrected = { ...args };

  // ── 1. Force default DEX to 0x if LLM didn't set it or set it wrong ──
  if (!corrected.dex) {
    corrected.dex = "0x";
  }

  // ── 2. Extract amount and direction from user message ──
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
    const currentAmountIn = corrected.amountIn as string | undefined;

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

  // ── 3. Extract chain from user message ──
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
