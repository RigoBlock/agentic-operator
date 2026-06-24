/**
 * Swap Tool Handlers
 *
 * Single unified assembly pipeline for both 0x and Uniswap swaps.
 * The two DEX integrations only differ in how they fetch a quote and produce
 * vault-targeted calldata; everything else (oracle enrichment, Swap Shield,
 * NAV Shield, message formatting, gas estimation) is shared.
 */

import type { Address, Hex } from "viem";
import type { Env, RequestContext, SwapIntent, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import {
  getUniswapQuote, getUniswapSwapCalldata,
} from "../../services/uniswapTrading.js";
import { getZeroXQuote, formatZeroXQuoteForDisplay, type ZeroXQuote } from "../../services/zeroXTrading.js";
import { getVaultTokenBalance, encodeVaultExecute } from "../../services/vault.js";
import { resolveTokenAddress, getWrappedNativeAddress, getNativeTokenSymbol } from "../../config.js";
import { encodeFunctionData, decodeFunctionData, parseUnits, formatUnits } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../../abi/rigoblockVault.js";
import {
  estimateGas, preCheckNavImpact, resolveChainName, resolveSlippage, runSwapShield, switchChainIfNeeded, txActionLine,
} from "../client.js";
import { enrichQuoteWithOracle } from "../../services/quoteEnrichment.js";

const AUNISWAP_ABI = [
  { name: "wrapETH",     type: "function", stateMutability: "nonpayable", inputs: [{ name: "value",         type: "uint256" }], outputs: [] },
  { name: "unwrapWETH9", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amountMinimum", type: "uint256" }], outputs: [] },
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Detect 0x errors that indicate missing/unsupported liquidity — candidates for Uniswap fallback. */
function isZeroXLiquidityError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no liquidity found on 0x") ||
    lower.includes("token pair may not be supported by 0x") ||
    lower.includes("token pair may not be fully supported by 0x") ||
    lower.includes("0x returned empty transaction data") ||
    lower.includes("0x quote response is missing a valid") ||
    lower.includes("0x api timed out")
  );
}

/** Format a raw wei amount to a human-readable decimal string (6 places). */
function formatRawAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

/** Normalised swap quote + calldata produced by either DEX integration. */
interface SwapAssembly {
  dexLabel: string;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string; // raw base units
  buyAmount: string;  // raw base units
  decimalsIn: number;
  decimalsOut: number;
  /** Slippage-adjusted worst-case sell amount for exact-output balance checks. */
  maxSellAmount?: string;
  calldata: Hex;
  fallbackNote?: string;
}

export async function handle_get_swap_quote(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const chainSwitched = switchChainIfNeeded(args.chain, ctx);
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
  const requestedDex = ((args.dex as string) || "0x").toLowerCase();
  let dex = requestedDex;
  let fallbackNote = "";

  if (dex === "0x" || dex === "zerox") {
    try {
      const quote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress, ctx);
      return { message: formatZeroXQuoteForDisplay(intent, quote), chainSwitch: chainSwitched };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isZeroXLiquidityError(msg)) {
        console.warn(`[get_swap_quote] 0x liquidity error, falling back to Uniswap: ${msg}`);
        dex = "uniswap";
        fallbackNote = `0x had no liquidity for ${intent.tokenIn} → ${intent.tokenOut}; showing Uniswap quote instead.`;
      } else {
        throw err;
      }
    }
  }

  const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);
  const { formatUniswapQuoteForDisplay } = await import("../../services/uniswapTrading.js");
  const message = fallbackNote
    ? `${fallbackNote}\n\n${formatUniswapQuoteForDisplay(intent, quote)}`
    : formatUniswapQuoteForDisplay(intent, quote);
  return { message, chainSwitch: chainSwitched };
}

/**
 * Balance pre-check for exact-input swaps.
 * Run before calling any DEX so we fail fast without wasting API/RPC time.
 */
async function checkExactInputBalance(
  env: Env,
  ctx: RequestContext,
  intent: SwapIntent,
  chainName: string,
): Promise<void> {
  if (!intent.amountIn) return;
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
    if (err instanceof Error && err.message.includes("Insufficient")) throw err;
  }
}

/** Shared swap assembly pipeline: oracle, Swap Shield, NAV Shield, formatting. */
async function assembleSwapTransaction(
  env: Env,
  ctx: RequestContext,
  intent: SwapIntent,
  chainSwitched: number | undefined,
  chainName: string,
  assembly: SwapAssembly,
): Promise<ToolResult> {
  // ── Balance pre-check for exact-output swaps ──
  if (intent.amountOut) {
    try {
      const sellAddr = await resolveTokenAddress(ctx.chainId, intent.tokenIn);
      const { balance, decimals, symbol } = await getVaultTokenBalance(
        ctx.chainId, ctx.vaultAddress as Address, sellAddr as Address, env.ALCHEMY_API_KEY,
      );
      const requiredIn = BigInt(assembly.maxSellAmount || assembly.sellAmount);
      if (requiredIn > balance) {
        const available = formatUnits(balance, decimals);
        const needed = formatUnits(requiredIn, decimals);
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

  // ── Oracle enrichment (deduplicates RPC calls for Swap Shield) ──
  const oracleEnrichment = await enrichQuoteWithOracle(
    ctx.chainId,
    assembly.sellToken,
    assembly.buyToken,
    assembly.sellAmount,
    assembly.buyAmount,
    env.ALCHEMY_API_KEY,
  );

  // ── Swap Shield — oracle price check ──
  const shield = await runSwapShield(
    env, ctx, intent,
    assembly.sellAmount, assembly.decimalsIn,
    assembly.buyAmount,
    assembly.sellToken,
    assembly.buyToken,
    oracleEnrichment,
  );

  // ── Formatting ──
  const outputAmount = formatRawAmount(assembly.buyAmount, assembly.decimalsOut);
  const inputAmount = formatRawAmount(assembly.sellAmount, assembly.decimalsIn);
  const isExactOutput = !!intent.amountOut;

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
  const descParts = [`[${assembly.dexLabel}] Sell ${sellDesc} for ${buyDesc}`];
  if (priceLine) descParts.push(priceLine);

  const gas = await estimateGas(
    ctx.chainId, ctx.vaultAddress as Address,
    assembly.calldata, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "swap",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: assembly.calldata,
    value: "0x0",
    chainId: ctx.chainId,
    gas,
    description: descParts.join(" | "),
    swapMeta: {
      sellAmount: inputAmount,
      sellToken: intent.tokenIn,
      buyAmount: outputAmount,
      buyToken: intent.tokenOut,
      price: sellNum > 0 && buyNum > 0
        ? `1 ${intent.tokenIn} = ${(buyNum / sellNum).toFixed(6)} ${intent.tokenOut}`
        : "",
      dex: assembly.dexLabel,
    },
    navShieldChecked: true,
  };

  const sellLine = isExactOutput
    ? `Sell: ~${inputAmount} ${intent.tokenIn} (estimated)`
    : `Sell: ${intent.amountIn} ${intent.tokenIn}`;
  const buyLine = isExactOutput
    ? `Buy: ${intent.amountOut} ${intent.tokenOut}`
    : `Buy: ~${outputAmount} ${intent.tokenOut}`;

  const header = assembly.fallbackNote
    ? `✅ Swap ready (${assembly.dexLabel} — ${assembly.fallbackNote})`
    : `✅ Swap ready (${assembly.dexLabel})`;

  let message = [
    header,
    sellLine,
    buyLine,
    ...(priceLine ? [priceLine] : []),
    `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
    `Chain: ${chainName}`,
    `Gas limit: ${parseInt(gas, 16)}`,
    ...(shield.warning ? [shield.warning] : []),
    ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
  ].join("\n");

  // ── NAV shield pre-check ──
  const navCheck = await preCheckNavImpact(env, ctx, transaction);
  if (navCheck.warning) message += '\n' + navCheck.warning;

  const metadata: Record<string, unknown> = {};
  if (shield.metrics) metadata.swapShield = shield.metrics;
  if (navCheck.metrics) metadata.navShield = navCheck.metrics;
  if (Object.keys(metadata).length) transaction.metrics = metadata;

  return { message, transaction, chainSwitch: chainSwitched, metadata: Object.keys(metadata).length ? metadata : undefined };
}

async function buildVaultSwapWith0x(
  env: Env,
  ctx: RequestContext,
  intent: SwapIntent,
  chainSwitched: number | undefined,
  chainName: string,
  fallbackNote?: string,
): Promise<ToolResult> {
  const zxQuote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress, ctx);

  const assembly: SwapAssembly = {
    dexLabel: "0x Aggregator",
    sellToken: zxQuote.sellToken as Address,
    buyToken: zxQuote.buyToken as Address,
    sellAmount: zxQuote.sellAmount,
    buyAmount: zxQuote.buyAmount,
    decimalsIn: zxQuote.decimalsIn,
    decimalsOut: zxQuote.decimalsOut,
    maxSellAmount: zxQuote.maxSellAmount,
    calldata: zxQuote.transaction.data,
    fallbackNote,
  };

  return assembleSwapTransaction(env, ctx, intent, chainSwitched, chainName, assembly);
}

async function buildVaultSwapWithUniswap(
  env: Env,
  ctx: RequestContext,
  intent: SwapIntent,
  chainSwitched: number | undefined,
  chainName: string,
  fallbackNote?: string,
): Promise<ToolResult> {
  const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);

  if (!quote.quote.input?.amount || !quote.quote.output?.amount) {
    throw new Error(
      "Uniswap quote returned an unexpected shape — input or output amount is missing. " +
      "Cannot validate swap price. Please retry.",
    );
  }

  const swapTx = await getUniswapSwapCalldata(env, quote._raw);

  const decoded = decodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    data: swapTx.data,
  });

  if (decoded.functionName !== "execute") {
    throw new Error(
      `Unexpected function from Uniswap API: ${decoded.functionName}. Expected execute().`,
    );
  }

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

  const assembly: SwapAssembly = {
    dexLabel: "Uniswap",
    sellToken: quote.quote.input.token as Address,
    buyToken: quote.quote.output.token as Address,
    sellAmount: quote.quote.input.amount,
    buyAmount: quote.quote.output.amount,
    decimalsIn: quote.decimalsIn,
    decimalsOut: quote.decimalsOut,
    maxSellAmount: quote.quote.input.amount,
    calldata: vaultCalldata,
    fallbackNote,
  };

  return assembleSwapTransaction(env, ctx, intent, chainSwitched, chainName, assembly);
}

export async function handle_build_vault_swap(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  if (!ctx.vaultAddress || ctx.vaultAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      "No vault selected. Please select or deploy a smart pool before swapping.",
    );
  }

  const chainSwitched = switchChainIfNeeded(args.chain, ctx);
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

  const chainName = resolveChainName(ctx.chainId);

  // ── Fast-fail balance check for exact-input swaps ──
  await checkExactInputBalance(env, ctx, intent, chainName);

  // ── Wrap / Unwrap — direct AUniswap adapter call ──
  {
    const wrappedNative = getWrappedNativeAddress(ctx.chainId);
    if (wrappedNative) {
      const sellAddr = await resolveTokenAddress(ctx.chainId, intent.tokenIn).catch(() => null);
      const buyAddr  = await resolveTokenAddress(ctx.chainId, intent.tokenOut).catch(() => null);
      const nativeSym = getNativeTokenSymbol(ctx.chainId);

      const isWrap   = sellAddr?.toLowerCase() === ZERO_ADDR && buyAddr?.toLowerCase() === wrappedNative.toLowerCase();
      const isUnwrap = sellAddr?.toLowerCase() === wrappedNative.toLowerCase() && buyAddr?.toLowerCase() === ZERO_ADDR;

      if (isWrap || isUnwrap) {
        if (!intent.amountIn) throw new Error(`Amount required for ${isWrap ? "wrap" : "unwrap"}.`);
        const amountRaw = parseUnits(intent.amountIn, 18);
        const calldata = isWrap
          ? encodeFunctionData({ abi: AUNISWAP_ABI, functionName: "wrapETH",     args: [amountRaw] })
          : encodeFunctionData({ abi: AUNISWAP_ABI, functionName: "unwrapWETH9", args: [amountRaw] });

        const gas = await estimateGas(
          ctx.chainId, ctx.vaultAddress as Address,
          calldata, "0x0",
          ctx.operatorAddress, env.ALCHEMY_API_KEY, "swap",
        );

        const wrappedSym = `W${nativeSym}`;
        const [fromSym, toSym] = isWrap ? [nativeSym, wrappedSym] : [wrappedSym, nativeSym];
        const transaction: UnsignedTransaction = {
          to: ctx.vaultAddress as Address,
          data: calldata,
          value: "0x0",
          chainId: ctx.chainId,
          gas,
          description: `${isWrap ? "Wrap" : "Unwrap"} ${intent.amountIn} ${fromSym} → ${toSym}`,
          swapMeta: {
            sellAmount: intent.amountIn,
            sellToken: fromSym,
            buyAmount: intent.amountIn,
            buyToken: toSym,
            price: "1:1 (no slippage)",
            dex: "Vault Adapter",
          },
        };

        let message = [
          `✅ ${isWrap ? "Wrap" : "Unwrap"} ready`,
          `${isWrap ? "Deposit" : "Withdraw"}: ${intent.amountIn} ${fromSym} → ${intent.amountIn} ${toSym} (1:1)`,
          `Chain: ${chainName}`,
          `Gas limit: ${parseInt(gas, 16)}`,
          ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
        ].join("\n");

        const navCheckWrap = await preCheckNavImpact(env, ctx, transaction);
        if (navCheckWrap.warning) message += '\n' + navCheckWrap.warning;

        const metaWrap: Record<string, unknown> = {};
        if (navCheckWrap.metrics) metaWrap.navShield = navCheckWrap.metrics;
        if (Object.keys(metaWrap).length) transaction.metrics = metaWrap;

        return { message, transaction, chainSwitch: chainSwitched, metadata: Object.keys(metaWrap).length ? metaWrap : undefined };
      }
    }
  }

  // ── DEX selection: default 0x, fallback to Uniswap ──
  const requestedDex = ((args.dex as string) || "0x").toLowerCase();

  if (requestedDex === "0x" || requestedDex === "zerox") {
    try {
      return await buildVaultSwapWith0x(env, ctx, intent, chainSwitched, chainName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isZeroXLiquidityError(msg)) {
        console.warn(`[build_vault_swap] 0x liquidity error, falling back to Uniswap: ${msg}`);
        const fallbackNote = `0x had no liquidity for ${intent.tokenIn} → ${intent.tokenOut}; routed via Uniswap instead.`;
        return buildVaultSwapWithUniswap(env, ctx, intent, chainSwitched, chainName, fallbackNote);
      }
      throw err;
    }
  }

  return buildVaultSwapWithUniswap(env, ctx, intent, chainSwitched, chainName);
}
