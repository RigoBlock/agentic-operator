/**
 * Swap Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, SwapIntent, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import {
  getUniswapQuote, getUniswapSwapCalldata, formatUniswapQuoteForDisplay,
} from "../../services/uniswapTrading.js";
import { getZeroXQuote, formatZeroXQuoteForDisplay } from "../../services/zeroXTrading.js";
import { getVaultTokenBalance, encodeVaultExecute } from "../../services/vault.js";
import { resolveTokenAddress, getWrappedNativeAddress, getNativeTokenSymbol } from "../../config.js";
import { encodeFunctionData, decodeFunctionData, parseUnits, formatUnits, type Address, type Hex } from "viem";
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

/** Format a raw wei amount to a human-readable decimal string (6 places). */
function formatRawAmount(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${frac}`;
}

export async function handle_get_swap_quote(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const chainSwitched = switchChainIfNeeded(args.chain, ctx);

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
  const dex = ((args.dex as string) || "0x").toLowerCase();
  if (dex === "0x" || dex === "zerox") {
    const quote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress);
    return { message: formatZeroXQuoteForDisplay(intent, quote), chainSwitch: chainSwitched };
  }
  const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);
  return { message: formatUniswapQuoteForDisplay(intent, quote), chainSwitch: chainSwitched };

}

export async function handle_build_vault_swap(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  // Verify operator is connected
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  // Reject the zero address — the frontend uses it as a sentinel when no
  // vault has been selected. Building calldata against 0x000...0 would
  // waste a Swap Shield oracle call and produce an unusable transaction.
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  if (!ctx.vaultAddress || ctx.vaultAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      "No vault selected. Please select or deploy a smart pool before swapping.",
    );
  }

  const chainSwitched = switchChainIfNeeded(args.chain, ctx);

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

  // ── Wrap / Unwrap — direct AUniswap adapter call ──────────────────
  // wrapETH / unwrapWETH9 are exposed directly on the vault via the AUniswap
  // adapter. DO NOT route through DEX APIs: Universal Router execute() is NOT
  // whitelisted for wrap/unwrap and reverts with PoolMethodNotAllowed (0x1f62c4e2).
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

  // Determine which DEX to use.
  // Default is 0x — it's an aggregator and generally returns better quotes.
  // Both AUniswapRouter and A0xRouter adapters are deployed on Rigoblock vaults.
  const dex = ((args.dex as string) || "0x").toLowerCase();

  if (dex === "0x" || dex === "zerox") {
    // ── 0x AllowanceHolder flow ──
    const zxQuote = await getZeroXQuote(env, intent, ctx.chainId, ctx.vaultAddress);

    // ── Oracle enrichment (deduplicates RPC calls for Swap Shield) ──
    const oracleEnrichment0x = await enrichQuoteWithOracle(
      ctx.chainId,
      zxQuote.sellToken as Address,
      zxQuote.buyToken as Address,
      zxQuote.sellAmount,
      zxQuote.buyAmount,
      env.ALCHEMY_API_KEY,
    );

    // ── Swap Shield — oracle price check ──
    const shield0x = await runSwapShield(
      env, ctx, intent,
      zxQuote.sellAmount, zxQuote.decimalsIn,
      zxQuote.buyAmount,
      zxQuote.sellToken as Address,
      zxQuote.buyToken as Address,
      oracleEnrichment0x,
    );
    const shieldWarning0x = shield0x.warning;

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
    const buyLine = isExactOutput
      ? `Buy: ~${outputAmount} ${intent.tokenOut} (target: ${intent.amountOut} ${intent.tokenOut})`
      : `Buy: ~${outputAmount} ${intent.tokenOut}`;

    let message = [
      "✅ Swap ready (0x Aggregator)",
      sellLine,
      buyLine,
      ...(priceLine ? [priceLine] : []),
      `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
      `Chain: ${chainName}`,
      `Gas limit: ${parseInt(zxGas, 16)}`,
      ...(shieldWarning0x ? [shieldWarning0x] : []),
      ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
    ].join("\n");

    // NAV shield pre-check — warn if simulation fails, block if NAV drops > threshold.
    const navCheck0x = await preCheckNavImpact(env, ctx, transaction);
    if (navCheck0x.warning) message += '\n' + navCheck0x.warning;

    const metadata: Record<string, unknown> = {};
    if (shield0x.metrics) metadata.swapShield = shield0x.metrics;
    if (navCheck0x.metrics) metadata.navShield = navCheck0x.metrics;
    if (Object.keys(metadata).length) transaction.metrics = metadata;

    return { message, transaction, chainSwitch: chainSwitched, metadata: Object.keys(metadata).length ? metadata : undefined };
  }

  // ── Uniswap flow (default) ──

  // 2. Get quote from Uniswap Trading API
  const quote = await getUniswapQuote(env, intent, ctx.chainId, ctx.vaultAddress);

  // Treat missing amounts as a hard error — an unexpected quote shape must not
  // silently bypass oracle protection.
  if (!quote.quote.input?.amount || !quote.quote.output?.amount) {
    throw new Error(
      "Uniswap quote returned an unexpected shape — input or output amount is missing. " +
      "Cannot validate swap price. Please retry.",
    );
  }

  // ── Oracle enrichment (deduplicates RPC calls for Swap Shield) ──
  const oracleEnrichmentUni = await enrichQuoteWithOracle(
    ctx.chainId,
    quote.quote.input.token as Address,
    quote.quote.output.token as Address,
    quote.quote.input.amount,
    quote.quote.output.amount,
    env.ALCHEMY_API_KEY,
  );

  // ── Swap Shield — oracle price check ──
  const shieldUni = await runSwapShield(
    env, ctx, intent,
    quote.quote.input.amount, quote.decimalsIn,
    quote.quote.output.amount,
    quote.quote.input.token as Address,
    quote.quote.output.token as Address,
    oracleEnrichmentUni,
  );
  const shieldWarningUni = shieldUni.warning;

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

  let message = [
    "✅ Swap ready (Uniswap)",
    sellLine,
    buyLine,
    ...(priceLine ? [priceLine] : []),
    `Slippage: ${intent.slippageBps ? intent.slippageBps / 100 : 1}%`,
    `Chain: ${chainName}`,
    `Gas limit: ${parseInt(uniGas, 16)}`,
    ...(shieldWarningUni ? [shieldWarningUni] : []),
    ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
  ].join("\n");

  // NAV shield pre-check — warn if simulation fails, block if NAV drops > threshold.
  const navCheckUni = await preCheckNavImpact(env, ctx, transaction);
  if (navCheckUni.warning) message += '\n' + navCheckUni.warning;

  const metadataUni: Record<string, unknown> = {};
  if (shieldUni.metrics) metadataUni.swapShield = shieldUni.metrics;
  if (navCheckUni.metrics) metadataUni.navShield = navCheckUni.metrics;
  if (Object.keys(metadataUni).length) transaction.metrics = metadataUni;

  return { message, transaction, chainSwitch: chainSwitched, metadata: Object.keys(metadataUni).length ? metadataUni : undefined };

}

