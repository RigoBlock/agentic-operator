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
  checkVaultEthForGmxKeeper,
} from "../../services/gmxTrading.js";
import { getGmxPositionsSummary, getGmxPositions, findGmxPosition, computeGmxLeverage, computeEffectiveCollateral, type GmxPosition } from "../../services/gmxPositions.js";
import { ARBITRUM_CHAIN_ID, GmxOrderType } from "../../abi/gmx.js";
import { estimateGas, executeToolCall, txActionLine } from "../client.js";

/** Parse a formatted USD string like "$12,345.67" or "$12.34K" back to number */
function parseUsdString(s: string): number {
  return parseFloat(s.replace(/[+$,]/g, "").replace(/K/, "e3").replace(/M/, "e6")) || 0;
}

// ── Shared helpers ─────────────────────────────────────────────────────

/**
 * Check vault has enough native ETH for GMX keeper fee.
 * Throws a clear error if insufficient. Returns nothing if OK.
 */
async function checkKeeperFee(
  env: Env,
  ctx: RequestContext,
): Promise<void> {
  const feeStatus = await checkVaultEthForGmxKeeper(
    ctx.vaultAddress as Address,
    env.ALCHEMY_API_KEY,
  );
  if (!feeStatus.sufficient) {
    throw new Error(
      `The vault needs ETH to pay the GMX keeper execution fee. ` +
      `Current balance: ${feeStatus.ethBalance} ETH (need ≥ 0.001 ETH). ` +
      `Send at least 0.005 ETH to the vault (${ctx.vaultAddress}) and retry.`,
    );
  }
}

/**
 * Cap collateral to available vault balance. Returns the (possibly capped)
 * collateralAmount and sizeDeltaUsd, plus an optional warning note.
 */
async function capCollateralToBalance(
  env: Env,
  ctx: RequestContext,
  collateralAddr: Address,
  collateralDecimals: number,
  collateralSymbol: string,
  collateralAmount: string,
  sizeDeltaUsd: string,
  isPureCollateralAdd: boolean,
): Promise<{ collateralAmount: string; sizeDeltaUsd: string; cappedNote: string }> {
  const { balance: colBal } = await getVaultTokenBalance(
    ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address, collateralAddr, env.ALCHEMY_API_KEY,
  );
  const requestedRaw = parseUnits(collateralAmount, collateralDecimals);
  if (requestedRaw <= colBal) {
    return { collateralAmount, sizeDeltaUsd, cappedNote: "" };
  }

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
  const newCollateral = availableNum.toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
  let newSize = sizeDeltaUsd;
  if (!isPureCollateralAdd) {
    newSize = (parseFloat(sizeDeltaUsd) * scaleFactor).toFixed(2);
  }
  const note = `\n⚠️ Collateral capped to available balance: ${newCollateral} ${collateralSymbol}` +
    (isPureCollateralAdd ? "" : ` (position size scaled proportionally to $${newSize})`);

  return { collateralAmount: newCollateral, sizeDeltaUsd: newSize, cappedNote: note };
}

// ── Open / Increase (unified) ──────────────────────────────────────────

/**
 * Unified handler for both opening a NEW position and increasing an EXISTING one.
 * GMX v2 uses the same `createIncreaseOrder` for both — the only difference is:
 *   - NEW: collateral MUST be specified, leverage MUST be specified (no defaults)
 *   - EXISTING: collateral auto-resolved from position, leverage preserved when omitted
 */
export async function handle_gmx_increase_position(
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
  const isLong = args.isLong === true || args.isLong === "true";
  const market = await findGmxMarket(marketSymbol);

  // ── Resolve existing position (if any) ──────────────────────────────
  let existingPos: GmxPosition | undefined;
  const userCollateral = (args.collateral as string) || "";
  try {
    existingPos = await findGmxPosition(
      ctx.vaultAddress as Address,
      marketSymbol,
      isLong,
      env.ALCHEMY_API_KEY,
      userCollateral,
    );
  } catch {
    // No existing position — will proceed as OPEN
    existingPos = undefined;
  }

  const isOpen = !existingPos;

  // ── Resolve collateral ──────────────────────────────────────────────
  let collateralSymbol: string;
  if (isOpen) {
    if (!userCollateral) {
      throw new Error(
        `Opening a new ${marketSymbol} ${isLong ? "long" : "short"} requires specifying a collateral token. ` +
        `Available collaterals depend on the market. Common choices: USDC, WETH, USDT, WBTC. ` +
        `Please specify which token to use as collateral (e.g., collateral="WETH").`,
      );
    }
    collateralSymbol = userCollateral;
  } else {
    // Increase: use existing position's collateral unless user explicitly overrides
    collateralSymbol = userCollateral || existingPos.collateralSymbol;
  }

  const collateralAddr = await resolveGmxCollateral(collateralSymbol);
  const collateralDecimals = getGmxTokenDecimals(collateralAddr);
  await warmDecimalsForAddresses([collateralAddr, market.indexToken], env.ALCHEMY_API_KEY);
  const [collateralPrice, indexTokenPrice] = await Promise.all([
    getGmxTokenPrice(collateralAddr),
    getGmxTokenPrice(market.indexToken),
  ]);

  // ── Resolve collateralAmount and sizeDeltaUsd ───────────────────────
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
    const notional = parseFloat(args.notionalUsd as string);
    const leverageNum = parseFloat(args.leverage as string);
    sizeDeltaUsd = notional.toFixed(2);
    const collateralValueUsd = notional / leverageNum;
    collateralAmount = (collateralValueUsd / collateralPrice.mid).toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
  } else if (hasCollateral && hasLeverage) {
    collateralAmount = args.collateralAmount as string;
    const leverageNum = parseFloat(args.leverage as string);
    const collateralValueUsd = parseFloat(collateralAmount) * collateralPrice.mid;
    sizeDeltaUsd = (collateralValueUsd * leverageNum).toFixed(2);
  } else if (hasCollateral && hasSizeDelta) {
    collateralAmount = args.collateralAmount as string;
    sizeDeltaUsd = args.sizeDeltaUsd as string;
  } else if (hasNotional) {
    const notional = parseFloat(args.notionalUsd as string);
    sizeDeltaUsd = notional.toFixed(2);
    let targetLeverage: number;
    if (existingPos) {
      targetLeverage = parseFloat(existingPos.leverage);
      if (!targetLeverage || targetLeverage <= 0) targetLeverage = 2; // fallback only for corrupt data
    } else {
      throw new Error(
        `Opening a new position with notionalUsd requires specifying leverage. ` +
        `Example: notionalUsd="1000", leverage="5". ` +
        `Without leverage, the system cannot compute how much collateral to deposit.`,
      );
    }
    const collateralValueUsd = notional / targetLeverage;
    collateralAmount = (collateralValueUsd / collateralPrice.mid).toFixed(collateralDecimals <= 8 ? collateralDecimals : 6);
  } else if (hasSizeDelta) {
    sizeDeltaUsd = args.sizeDeltaUsd as string;
    collateralAmount = hasCollateral ? (args.collateralAmount as string) : "0";
  } else if (hasCollateral) {
    collateralAmount = args.collateralAmount as string;
    sizeDeltaUsd = "0";
  } else {
    throw new Error("Please specify notionalUsd, sizeDeltaUsd, or collateralAmount.");
  }

  const isPureCollateralAdd = sizeDeltaUsd === "0" || parseFloat(sizeDeltaUsd) === 0;
  const isPureSizeIncrease = parseFloat(collateralAmount) === 0 && !isPureCollateralAdd;

  // ── Pre-checks ──────────────────────────────────────────────────────
  await checkKeeperFee(env, ctx);

  let cappedNote = "";
  if (!isPureSizeIncrease) {
    const capped = await capCollateralToBalance(
      env, ctx, collateralAddr, collateralDecimals, collateralSymbol,
      collateralAmount, sizeDeltaUsd, isPureCollateralAdd,
    );
    collateralAmount = capped.collateralAmount;
    sizeDeltaUsd = capped.sizeDeltaUsd;
    cappedNote = capped.cappedNote;
  }

  // ── Build transaction ───────────────────────────────────────────────
  const oraclePrice = indexTokenPrice.mid;
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

  const gmxGas = await estimateGas(
    ARBITRUM_CHAIN_ID, ctx.vaultAddress as Address,
    calldata as Hex, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "gmx",
  );

  // ── Compute display values ──────────────────────────────────────────
  // Leverage must use EFFECTIVE collateral (raw collateral + unrealized PnL),
  // matching GMX v2's on-chain formula. We derive effective collateral from
  // Leverage uses effective collateral (raw collateral + unrealized PnL).
  // Current leverage comes directly from the on-chain position data.
  // Post-tx leverage is projected using the same shared formula.
  const addedCollateralValueUsd = parseFloat(collateralAmount) * collateralPrice.mid;
  const existingSizeUsd = existingPos ? parseUsdString(existingPos.sizeInUsd) : 0;
  const currentLeverage = existingPos ? parseFloat(existingPos.leverage) : 0;
  const existingEffectiveCollateral = computeEffectiveCollateral(existingSizeUsd, currentLeverage);

  const newSizeUsd = existingSizeUsd + parseFloat(sizeDeltaUsd);
  const newEffectiveCollateral = existingEffectiveCollateral + addedCollateralValueUsd;
  const newLeverage = computeGmxLeverage(newSizeUsd, newEffectiveCollateral);

  const actionLabel = isPureCollateralAdd
    ? "Add Collateral"
    : isOpen
      ? "Open Position"
      : "Increase";

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
    `Price: $${oraclePrice.toFixed(4)}`,
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

// ── Close / Decrease ───────────────────────────────────────────────────

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
  const isLong = args.isLong === true || args.isLong === "true";
  const market = await findGmxMarket(marketSymbol);

  // sizeDeltaUsd: "all" means close full position — find position size
  let sizeDeltaUsd = (args.sizeDeltaUsd as string) || "all";
  let matchedPos: GmxPosition | undefined;
  let isFullClose = false;

  // Use the shared helper so close and increase never disagree about which
  // position exists. This also handles string/boolean isLong mismatches.
  const userCollateral = (args.collateral as string) || "";
  matchedPos = await findGmxPosition(
    ctx.vaultAddress as Address,
    marketSymbol,
    isLong,
    env.ALCHEMY_API_KEY,
    userCollateral,
  );

  if (sizeDeltaUsd.toLowerCase() === "all") {
    sizeDeltaUsd = matchedPos.sizeInUsd.replace(/[\$,KM]/g, "");
    if (matchedPos.sizeInUsd.includes("K")) sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * 1000).toString();
    if (matchedPos.sizeInUsd.includes("M")) sizeDeltaUsd = (parseFloat(sizeDeltaUsd) * 1000000).toString();
    isFullClose = true;
  } else {
    const posSizeNum = parseUsdString(matchedPos.sizeInUsd);
    // Support percentage strings like "50%"
    if (sizeDeltaUsd.trim().endsWith("%")) {
      const pct = parseFloat(sizeDeltaUsd.replace("%", ""));
      if (Number.isNaN(pct) || pct <= 0) {
        throw new Error(`Invalid percentage for size decrease: ${sizeDeltaUsd}. Use a positive number like "50%".`);
      }
      const computed = (posSizeNum * pct) / 100;
      sizeDeltaUsd = computed.toFixed(2);
      isFullClose = computed >= posSizeNum;
    } else {
      const closeSizeNum = parseFloat(sizeDeltaUsd);
      isFullClose = closeSizeNum >= posSizeNum;
    }
  }

  // Resolve collateral from matched position
  const collateralSymbol = matchedPos.collateralSymbol;
  const collateralAddr = await resolveGmxCollateral(collateralSymbol);
  const collateralDecimals = getGmxTokenDecimals(collateralAddr);

  // Get index token price for slippage protection
  const indexTokenPrice = await getGmxTokenPrice(market.indexToken);
  const oraclePrice = indexTokenPrice.mid;

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
    `Price: $${oraclePrice.toFixed(4)}`,
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

// ── Get positions ──────────────────────────────────────────────────────

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
    suggestions.push("Refresh positions", "Open new position", "Show GMX markets");
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

// ── Cancel order ───────────────────────────────────────────────────────

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

// ── Update order ───────────────────────────────────────────────────────

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

// ── Claim funding fees ─────────────────────────────────────────────────

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

// ── Get markets ────────────────────────────────────────────────────────

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
