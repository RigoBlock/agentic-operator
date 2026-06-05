/**
 * Gmx Tool Handlers
 *
 * Critical GMX v2 pricing facts (from docs.gmx.io):
 * - Opening / increasing a position incurs NO price impact at entry.
 *   Entry price = oracle price (max for longs, min for shorts).
 * - Price impact is ONLY applied on close / decrease ("net price impact").
 *   It affects collateral received, not the mark price.
 * - Slippage (1% default) protects against oracle price movement between
 *   order submission and keeper execution.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import { getVaultTokenBalance } from "../../services/vault.js";
import { parseUnits, formatUnits, type Address, type Hex } from "viem";
import {
  findGmxMarket, getGmxMarkets, getGmxTickers, getGmxTokenPrice,
  getGmxExecutionPrice,
  resolveGmxCollateral, getGmxTokenDecimals, warmTokenDecimalsCache, warmDecimalsForAddresses,
  buildCreateIncreaseOrderCalldata, buildCreateDecreaseOrderCalldata,
  buildUpdateOrderCalldata, buildCancelOrderCalldata, buildClaimFundingFeesCalldata,
} from "../../services/gmxTrading.js";
import { getGmxPositionsSummary, getGmxPositions, type GmxPosition } from "../../services/gmxPositions.js";
import { ARBITRUM_CHAIN_ID, GmxOrderType } from "../../abi/gmx.js";
import { estimateGas, executeToolCall, txActionLine } from "../client.js";

/** Parse a formatted USD string like "$12,345.67" or "$12.34K" back to number */
function parseUsdString(s: string): number {
  return parseFloat(s.replace(/[+$,]/g, "").replace(/K/, "e3").replace(/M/, "e6")) || 0;
}

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
  await warmDecimalsForAddresses([collateralAddr, market.indexToken], env.ALCHEMY_API_KEY);
  const [collateralPrice, indexTokenPrice] = await Promise.all([
    getGmxTokenPrice(collateralAddr),
    getGmxTokenPrice(market.indexToken),
  ]);

  // ── Fetch existing position (for leverage continuity) ─────────────
  let existingPos: GmxPosition | undefined;
  let existingSizeUsd = 0;
  let existingCollateralValueUsd = 0;
  try {
    const positions = await getGmxPositions(ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
    existingPos = positions.find(
      (p) => p.indexTokenSymbol.toUpperCase() === marketSymbol && p.isLong === isLong,
    );
    if (existingPos) {
      existingSizeUsd = parseUsdString(existingPos.sizeInUsd);
      const collateralNum = parseFloat(existingPos.collateralAmount);
      // Use current collateral price for accurate USD valuation
      const colPriceForPos = collateralSymbol === existingPos.collateralSymbol
        ? collateralPrice.mid
        : collateralPrice.mid; // same collateral expected; fallback safe
      existingCollateralValueUsd = collateralNum * colPriceForPos;
    }
  } catch {
    // ignore RPC failures — proceed with defaults
  }

  // ── Resolve collateralAmount and sizeDeltaUsd ─────────────────────
  let collateralAmount: string;
  let sizeDeltaUsd: string;

  const hasSizeDelta = args.sizeDeltaUsd !== undefined && (args.sizeDeltaUsd as string) !== "";
  const hasNotional = args.notionalUsd !== undefined && (args.notionalUsd as string) !== "";
  const hasCollateral = args.collateralAmount !== undefined && (args.collateralAmount as string) !== "";
  const hasLeverage = args.leverage !== undefined && (args.leverage as string) !== "";

  if (hasSizeDelta && (args.sizeDeltaUsd as string) === "0") {
    // Pure collateral add
    if (!hasCollateral) {
      throw new Error("Specify collateralAmount when adding collateral only (sizeDeltaUsd='0').");
    }
    collateralAmount = args.collateralAmount as string;
    sizeDeltaUsd = "0";
  } else if (hasNotional && hasLeverage) {
    // Mode A: notional + leverage
    const notional = parseFloat(args.notionalUsd as string);
    const leverageNum = parseFloat(args.leverage as string);
    sizeDeltaUsd = notional.toFixed(2);
    const collateralValueUsd = notional / leverageNum;
    collateralAmount = (collateralValueUsd / collateralPrice.mid).toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
  } else if (hasCollateral && hasLeverage) {
    // Mode B: collateral + leverage
    collateralAmount = args.collateralAmount as string;
    const leverageNum = parseFloat(args.leverage as string);
    const collateralValueUsd = parseFloat(collateralAmount) * collateralPrice.mid;
    sizeDeltaUsd = (collateralValueUsd * leverageNum).toFixed(2);
  } else if (hasCollateral && hasSizeDelta) {
    // Mode C: explicit collateral + size
    collateralAmount = args.collateralAmount as string;
    sizeDeltaUsd = args.sizeDeltaUsd as string;
  } else if (hasNotional) {
    // notional without leverage → preserve current leverage, or default 2x for new positions
    const notional = parseFloat(args.notionalUsd as string);
    sizeDeltaUsd = notional.toFixed(2);
    let targetLeverage = existingPos ? parseFloat(existingPos.leverage) : 2;
    if (!targetLeverage || targetLeverage <= 0) targetLeverage = 2;
    const collateralValueUsd = notional / targetLeverage;
    collateralAmount = (collateralValueUsd / collateralPrice.mid).toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
  } else if (hasSizeDelta) {
    // size without collateral → pure size increase (leverage goes up)
    sizeDeltaUsd = args.sizeDeltaUsd as string;
    collateralAmount = hasCollateral ? (args.collateralAmount as string) : "0";
  } else if (hasCollateral) {
    // collateral only → pure collateral add
    collateralAmount = args.collateralAmount as string;
    sizeDeltaUsd = "0";
  } else {
    throw new Error("Please specify notionalUsd, sizeDeltaUsd, or collateralAmount.");
  }

  const isPureCollateralAdd = sizeDeltaUsd === "0" || parseFloat(sizeDeltaUsd) === 0;
  const isPureSizeIncrease = parseFloat(collateralAmount) === 0 && !isPureCollateralAdd;

  // ── Pre-checks ────────────────────────────────────────────────────

  // 1. Check vault native ETH balance for GMX keeper fee.
  const NATIVE_ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const MIN_KEEPER_ETH = 1_000_000_000_000_000n; // 0.001 ETH
  const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
  const USDT_ARBITRUM = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as Address;
  try {
    const { balance: ethBal } = await getVaultTokenBalance(
      ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, NATIVE_ZERO, env.ALCHEMY_API_KEY,
    );
    if (ethBal < MIN_KEEPER_ETH) {
      const ethBalFmt = formatUnits(ethBal, 18);
      const [usdcBal, usdtBal] = await Promise.all([
        getVaultTokenBalance(ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, USDC_ARBITRUM, env.ALCHEMY_API_KEY)
          .catch(() => ({ balance: 0n })),
        getVaultTokenBalance(ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, USDT_ARBITRUM, env.ALCHEMY_API_KEY)
          .catch(() => ({ balance: 0n })),
      ]);
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
      try {
        const savedChainId = ctx.chainId;
        ctx.chainId = ARBITRUM_CHAIN_ID;
        const ethSwapResult = await executeToolCall(env, ctx, "build_vault_swap", {
          tokenIn: stableIn,
          tokenOut: "ETH",
          amountOut: "0.002",
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
      } catch {
        throw new Error(
          `The vault needs ETH to pay the GMX keeper execution fee. ` +
          `Current balance: ${ethBalFmt} ETH. ` +
          `Swap ${stableIn} → ETH first: build_vault_swap(tokenIn="${stableIn}", tokenOut="ETH", amountOut="0.002", chain="arbitrum"), ` +
          `then retry the GMX position.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && (
      err.message.includes("keeper execution fee") ||
      err.message.includes("ETH required")
    )) throw err;
  }

  // 2. Balance pre-check: cap collateral to available vault balance.
  let cappedNote = "";
  if (!isPureSizeIncrease) {
    try {
      const { balance: colBal } = await getVaultTokenBalance(
        ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, collateralAddr, env.ALCHEMY_API_KEY,
      );
      const requestedRaw = parseUnits(collateralAmount, collateralDecimals);
      if (requestedRaw > colBal) {
        const availableNum = parseFloat(formatUnits(colBal, collateralDecimals));
        if (availableNum < 0.5) {
          throw new Error(
            `Insufficient ${collateralSymbol} balance for GMX collateral. ` +
            `Requested: ${collateralAmount} ${collateralSymbol}, ` +
            `Available: ${availableNum.toFixed(6)} ${collateralSymbol} on Arbitrum. ` +
            `Swap more ${collateralSymbol} first.`,
          );
        }
        const prevCollateral = parseFloat(collateralAmount);
        const scaleFactor = availableNum / prevCollateral;
        collateralAmount = availableNum.toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
        if (!isPureCollateralAdd) {
          sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * scaleFactor).toFixed(2);
        }
        cappedNote = `\n⚠️ Collateral capped to available balance: ${collateralAmount} ${collateralSymbol}` +
          (isPureCollateralAdd ? "" : ` (position size scaled proportionally to $${sizeDeltaUsd})`);
      }
    } catch (err) {
      if (err instanceof Error && (
        err.message.includes("Insufficient") ||
        err.message.includes("keeper")
      )) throw err;
    }
  }

  const oraclePrice = indexTokenPrice.mid;

  // GMX v2: NO price impact on entry for opens/increases.
  // Entry price is simply the oracle price (max for longs, min for shorts).
  // Slippage protection (1%) bounds the keeper execution price.
  const acceptablePriceUsd = isLong
    ? (oraclePrice * 1.01).toFixed(4)
    : (oraclePrice * 0.99).toFixed(4);

  const calldata = buildCreateIncreaseOrderCalldata({
    market: market.marketToken as Address,
    collateralToken: collateralAddr,
    collateralAmount,
    collateralDecimals,
    sizeDeltaUsd,
    isLong,
    indexTokenPriceUsd: oraclePrice.toString(),
    acceptablePriceUsd,
  });

  // Compute leverage display
  const addedCollateralValueUsd = parseFloat(collateralAmount) * collateralPrice.mid;
  const newSizeUsd = existingSizeUsd + parseFloat(sizeDeltaUsd);
  const newCollateralValueUsd = existingCollateralValueUsd + addedCollateralValueUsd;
  const newLeverage = newCollateralValueUsd > 0 ? newSizeUsd / newCollateralValueUsd : 0;
  const currentLeverage = existingCollateralValueUsd > 0 ? existingSizeUsd / existingCollateralValueUsd : 0;

  const gmxGas = await estimateGas(
    ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
    calldata as Hex, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
  );

  const actionLabel = isPureCollateralAdd
    ? "Add Collateral"
    : (toolName === "gmx_increase_position" ? "Increase" : "Open");
  const txDescription = isPureCollateralAdd
    ? `[GMX] Add ${collateralAmount} ${collateralSymbol} collateral to ${isLong ? "Long" : "Short"} ${marketSymbol}`
    : `[GMX] ${isLong ? "Long" : "Short"} ${marketSymbol} ${newLeverage.toFixed(1)}x — ${collateralAmount} ${collateralSymbol} collateral (~$${addedCollateralValueUsd.toFixed(2)}), $${sizeDeltaUsd} size`;

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: ARBITRUM_CHAIN_ID,
    gas: gmxGas,
    description: txDescription,
  };

  const messageLines = [
    `✅ GMX ${actionLabel} ready`,
    `Direction: ${isLong ? "🟢 LONG" : "🔴 SHORT"} ${marketSymbol}/USD`,
    `Oracle price: $${oraclePrice.toFixed(4)}`,
  ];

  if (!isPureCollateralAdd) {
    messageLines.push(
      `Size (notional): $${parseFloat(sizeDeltaUsd).toLocaleString()}`,
    );
    if (currentLeverage > 0) {
      messageLines.push(`Current leverage: ${currentLeverage.toFixed(1)}x`);
    }
    messageLines.push(`Leverage after tx: ~${newLeverage.toFixed(1)}x`);
  }

  messageLines.push(
    `Collateral: ${collateralAmount} ${collateralSymbol} (~$${addedCollateralValueUsd.toFixed(2)})`,
    `Market: ${market.marketToken}`,
    `Chain: Arbitrum`,
    ``,
  );

  if (isPureCollateralAdd) {
    messageLines.push(`💡 Adding collateral reduces liquidation risk without increasing position size.`);
  } else if (isPureSizeIncrease) {
    messageLines.push(
      `⚠️ **Leverage increase**: You are adding $${parseFloat(sizeDeltaUsd).toLocaleString()} of size without new collateral. ` +
      `Leverage will rise from ${currentLeverage.toFixed(1)}x to ${newLeverage.toFixed(1)}x.`
    );
  } else {
    messageLines.push(`💡 GMX executes at the oracle price when the keeper picks up the order. The acceptable price is the worst-case execution bound.`);
  }

  if (cappedNote) messageLines.push(cappedNote);
  const actionLine = txActionLine(ctx);
  if (actionLine) messageLines.push(actionLine);

  return { message: messageLines.join("\n"), transaction, chainSwitch: chainSwitched };
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
  const oraclePrice = indexTokenPrice.mid;

  // sizeDeltaUsd: "all" means close full position — find position size
  let sizeDeltaUsd = (args.sizeDeltaUsd as string) || "all";
  let matchedPos: GmxPosition | undefined;
  let isFullClose = false;

  // Always fetch positions so we can (a) resolve "all", (b) match collateral, (c) get execution price
  const positions = await getGmxPositions(ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);

  if (sizeDeltaUsd.toLowerCase() === "all") {
    // Match by market + direction + collateral (if user specified collateral)
    const candidates = positions.filter(
      (p) =>
        p.indexTokenSymbol.toUpperCase() === marketSymbol &&
        p.isLong === isLong,
    );
    if (candidates.length === 1) {
      matchedPos = candidates[0];
    } else if (candidates.length > 1) {
      // Disambiguate by collateral token if user provided one
      const byCollateral = candidates.find(
        (p) => p.collateralSymbol.toUpperCase() === collateralSymbol.toUpperCase(),
      );
      if (byCollateral) {
        matchedPos = byCollateral;
      } else {
        const list = candidates.map(
          (p) => `${p.collateralSymbol} ${p.isLong ? "long" : "short"} ${p.sizeInUsd}`
        ).join(", ");
        throw new Error(
          `Multiple ${isLong ? "long" : "short"} ${marketSymbol} positions found: ${list}. ` +
          `Specify collateral token (e.g., collateral="WETH") to disambiguate.`,
        );
      }
    }
    if (matchedPos) {
      sizeDeltaUsd = matchedPos.sizeInUsd.replace(/[\$,KM]/g, "");
      if (matchedPos.sizeInUsd.includes("K")) sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * 1000).toString();
      if (matchedPos.sizeInUsd.includes("M")) sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * 1000000).toString();
      collateralSymbol = matchedPos.collateralSymbol;
      isFullClose = true;
    } else {
      throw new Error(`No open ${isLong ? "long" : "short"} ${marketSymbol} position found.`);
    }
  } else {
    // Partial close — still try to match position for context
    matchedPos = positions.find(
      (p) =>
        p.indexTokenSymbol.toUpperCase() === marketSymbol &&
        p.isLong === isLong,
    );
    if (!matchedPos) {
      throw new Error(`No open ${isLong ? "long" : "short"} ${marketSymbol} position found.`);
    }
    const posSizeNum = parseUsdString(matchedPos.sizeInUsd);
    const closeSizeNum = parseFloat(sizeDeltaUsd);
    isFullClose = closeSizeNum >= posSizeNum;
  }

  const collateralDelta = (args.collateralDeltaAmount as string) || "0";
  const isPureCollateralWithdraw = parseFloat(sizeDeltaUsd) === 0 && parseFloat(collateralDelta) > 0;

  // Resolve order type
  let orderType = GmxOrderType.MarketDecrease;
  const orderTypeStr = ((args.orderType as string) || "market").toLowerCase();
  if (orderTypeStr === "limit") orderType = GmxOrderType.LimitDecrease;
  else if (orderTypeStr === "stop_loss" || orderTypeStr === "stoploss") orderType = GmxOrderType.StopLossDecrease;

  // Get execution price + price impact for CLOSE/DECREASE.
  // Price impact is ONLY applied on close in GMX v2.
  let executionPrice = oraclePrice;
  let priceImpactUsd = 0;
  try {
    const execResult = await getGmxExecutionPrice(market, sizeDeltaUsd, isLong, env.ALCHEMY_API_KEY);
    executionPrice = execResult.executionPrice;
    priceImpactUsd = execResult.priceImpactUsd;
  } catch {
    // Fallback to oracle price if RPC fails
  }

  // Acceptable price for decreases:
  // Longs closing (selling): accept down to price * 0.99
  // Shorts closing (buying back): accept up to price * 1.01
  const acceptablePriceUsd = isLong
    ? (oraclePrice * 0.99).toFixed(4)
    : (oraclePrice * 1.01).toFixed(4);

  const calldata = buildCreateDecreaseOrderCalldata({
    market: market.marketToken as Address,
    collateralToken: collateralAddr,
    collateralDeltaAmount: collateralDelta,
    collateralDecimals,
    sizeDeltaUsd,
    isLong,
    orderType,
    triggerPriceUsd: args.triggerPrice as string | undefined,
    indexTokenPriceUsd: oraclePrice.toString(),
    acceptablePriceUsd: args.acceptablePrice as string | undefined,
  });

  const orderLabel = orderTypeStr === "limit"
    ? "Limit Decrease"
    : orderTypeStr.includes("stop")
      ? "Stop-Loss"
      : isPureCollateralWithdraw
        ? "Collateral Withdraw"
        : "Market Close";

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

  const priceImpactLabel = priceImpactUsd >= 0 ? "🟢 Favorable" : "🔴 Adverse";
  const priceImpactDisplay = Math.abs(priceImpactUsd).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const acceptableLabel = isLong ? "min" : "max";

  const messageLines = [
    `✅ GMX ${orderLabel} ready`,
    `Direction: ${isLong ? "LONG" : "SHORT"} ${marketSymbol}/USD`,
    `Oracle price: $${oraclePrice.toFixed(4)}`,
    `Execution price: $${executionPrice.toFixed(4)} (${priceImpactLabel} $${priceImpactDisplay})`,
    `Acceptable ${acceptableLabel}: $${acceptablePriceUsd} (1% bound)`,
  ];

  if (isPureCollateralWithdraw) {
    messageLines.push(
      `Collateral to withdraw: ${collateralDelta} ${collateralSymbol}`,
      `Position size: unchanged`,
    );
  } else {
    messageLines.push(`Size to ${isFullClose ? "close" : "decrease"}: $${parseFloat(sizeDeltaUsd).toLocaleString()}`);
    if (isFullClose) {
      messageLines.push(`Collateral return: ALL remaining collateral (~${matchedPos?.collateralAmount} ${collateralSymbol}) will be freed automatically`);
    } else {
      messageLines.push(`Collateral withdraw: ${collateralDelta} ${collateralSymbol}`);
    }
  }

  if (args.triggerPrice) {
    messageLines.push(`Trigger: $${args.triggerPrice}`);
  }

  messageLines.push(
    `Order type: ${orderLabel}`,
    `Chain: Arbitrum`,
    ``,
    `💡 GMX price impact is applied on close/decrease and affects collateral received. ` +
    `The mark price remains $${oraclePrice.toFixed(4)}; the impact adjusts your payout.`,
  );

  const actionLine = txActionLine(ctx);
  if (actionLine) messageLines.push(actionLine);

  return { message: messageLines.join("\n"), transaction, chainSwitch: chainSwitched };
}

export async function handle_gmx_get_positions(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  let chainSwitched: number | undefined;
  if (ctx.chainId !== ARBITRUM_CHAIN_ID) {
    ctx.chainId = ARBITRUM_CHAIN_ID;
    chainSwitched = ARBITRUM_CHAIN_ID;
  }

  const summary = await getGmxPositionsSummary(
    ctx.vaultAddress as Address,
    env.ALCHEMY_API_KEY,
  );

  // Generic suggestions only — per-position actions are rendered inline by the frontend.
  const suggestions: string[] = [];
  if (summary.positions.length > 0) {
    suggestions.push("Open new position", "Show GMX markets");
  } else {
    suggestions.push("Open a long", "Open a short", "Show GMX markets");
  }
  if (summary.pendingOrders.length > 0) {
    suggestions.push("Cancel order");
  }

  return {
    message: summary.formattedReport,
    chainSwitch: chainSwitched,
    suggestions,
    metadata: { gmxPositions: summary.positions },
  };
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
