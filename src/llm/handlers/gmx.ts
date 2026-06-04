/**
 * Gmx Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import { getVaultTokenBalance } from "../../services/vault.js";
import { parseUnits, formatUnits, type Address, type Hex } from "viem";
import {
  findGmxMarket, getGmxMarkets, getGmxTickers, getGmxTokenPrice,
  resolveGmxCollateral, getGmxTokenDecimals, warmTokenDecimalsCache, warmDecimalsForAddresses,
  buildCreateIncreaseOrderCalldata, buildCreateDecreaseOrderCalldata,
  buildUpdateOrderCalldata, buildCancelOrderCalldata, buildClaimFundingFeesCalldata,
} from "../../services/gmxTrading.js";
import { getGmxPositionsSummary, getGmxPositions } from "../../services/gmxPositions.js";
import { ARBITRUM_CHAIN_ID, GmxOrderType } from "../../abi/gmx.js";
import { estimateGas, executeToolCall, txActionLine } from "../client.js";

export async function handle_gmx_increase_position(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
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
  // One multicall for both tokens before price lookup — no per-token RPC calls inside getGmxTokenPrice
  await warmDecimalsForAddresses([collateralAddr, market.indexToken], env.ALCHEMY_API_KEY);
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
    `✅ GMX ${toolName === "gmx_increase_position" ? "Increase" : "Open"} Position ready`,
    `Direction: ${isLong ? "🟢 LONG" : "🔴 SHORT"} ${marketSymbol}/USD`,
    `Size (notional): $${parseFloat(sizeDeltaUsd).toLocaleString()}`,
    `Collateral: ${collateralAmount} ${collateralSymbol} (~$${collateralValueUsdDisplay})`,
    `Leverage: ~${leverage}x`,
    `Market: ${market.marketToken}`,
    `Chain: Arbitrum`,
    ``,
    `💡 Collateral is the amount deposited into the position. Size is the leveraged notional exposure.`,
    ...(cappedNote ? [cappedNote] : []),
    ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_gmx_close_position(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
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
    ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_gmx_get_positions(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
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

export async function handle_gmx_cancel_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
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

  const cancelLine = txActionLine(ctx);
  return {
    message: [`✅ Cancel order ready`, `Order: ${orderKey}`, `Note: GMX enforces a 300-second delay before cancellation.`, ...(cancelLine ? [cancelLine] : [])].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_gmx_update_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
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
      ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
    ].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_gmx_claim_funding_fees(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
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

  const claimLine = txActionLine(ctx);
  return {
    message: [`✅ Claim funding fees ready`, `Markets: ${claimMarkets.length}`, `Tokens are sent to the vault.`, ...(claimLine ? [claimLine] : [])].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_gmx_get_markets(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const [markets, tickers] = await Promise.all([
    getGmxMarkets(),
    getGmxTickers(),
  ]);

  // Warm decimals cache for all ticker tokens before building the price map.
  // This fetches ERC20 decimals on-chain for unknown tokens (e.g. synthetic BTC = 8 dec, not 18).
  await warmTokenDecimalsCache(tickers, env.ALCHEMY_API_KEY);

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

