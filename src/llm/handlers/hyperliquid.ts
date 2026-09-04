/**
 * Hyperliquid Tool Handlers
 *
 * Hyperliquid runs on HyperEVM (chain 999). The smart pool trades on HyperCore
 * through the AHyperliquid vault adapter:
 *
 * - Deposits bridge EVM USDC (6 decimals) into the Core perp account (USDC, 6
 *   decimals) and ACTIVATE the account if it doesn't exist yet.
 * - Withdrawals are two steps (atomic one-op-per-request model):
 *     1. hyperliquid_usd_class_transfer — perp margin → Core spot (perp USDC, 6 dp)
 *     2. hyperliquid_spot_send          — Core spot → HyperEVM (spot USDC, 8 dp core wei)
 * - Position open/increase/decrease/close are all LIMIT_ORDER actions. A
 *   marketable IOC limit order behaves like a market order; reduceOnly sells/buys
 *   decrease or close a position. Hyperliquid uses cross margin by default:
 *   collateral is global to the perp account, not pledged per position — declared
 *   leverage per position is shown in the report, account-wide leverage is global.
 */

import type { Env, RequestContext, TransactionDraft } from "../../types.js";
import type { ToolResult } from "../client.js";
import { formatUnits, type Address } from "viem";
import { HYPEREVM_CHAIN_ID, HYPEREVM_USDC, type HlTifName } from "../../abi/hyperliquid.js";
import {
  getHyperliquidAccountSummary,
  getHyperliquidMeta,
  getHyperliquidMids,
  getHyperliquidPrecompileBalances,
  resolveHlAssetIndex,
  fetchClearinghouseState,
  fetchOpenOrders,
  fetchUserFills,
  type HlApiPosition,
  type HlOpenOrder,
  type HlUserFill,
} from "../../services/hyperliquid.js";
import {
  buildHlDepositCalldata,
  buildHlLimitOrderCalldata,
  buildHlSpotSendCalldata,
  buildHlUsdClassTransferCalldata,
  buildHlCancelByOidCalldata,
  buildHlCancelByCloidCalldata,
  toHlPx,
  toHlSz,
  randomCloid,
} from "../../services/hyperliquidTrading.js";
import { getVaultTokenBalance } from "../../services/vault.js";
import { txActionLine } from "../client.js";

const SLIPPAGE_BPS = 100n; // 1% — bounds marketable IOC orders, mirrors GMX_SLIPPAGE_BPS

/** Force the context onto HyperEVM and return the chainSwitch flag. */
function switchToHyperEVM(ctx: RequestContext): number | undefined {
  if (ctx.chainId !== HYPEREVM_CHAIN_ID) {
    ctx.chainId = HYPEREVM_CHAIN_ID;
    return HYPEREVM_CHAIN_ID;
  }
  return undefined;
}

function draft(ctx: RequestContext, data: `0x${string}`, description: string): TransactionDraft {
  return {
    to: ctx.vaultAddress as Address,
    data,
    value: "0x0",
    chainId: HYPEREVM_CHAIN_ID,
    description,
  };
}

// ── Account / positions dashboard ──────────────────────────────────────

export async function handle_hyperliquid_get_positions(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const chainSwitched = switchToHyperEVM(ctx);
  const summary = await getHyperliquidAccountSummary(ctx.vaultAddress as Address);

  const suggestions: string[] = [];
  if (!summary.activated) {
    suggestions.push("Deposit USDC to Hyperliquid");
  }
  if (summary.positions.length > 0) {
    suggestions.push("Refresh Hyperliquid positions", "Show Hyperliquid markets");
  } else {
    suggestions.push("Show Hyperliquid markets", "Deposit USDC to Hyperliquid");
  }
  if (summary.openOrders.length > 0) {
    suggestions.push("Cancel Hyperliquid order");
  }

  return {
    message: summary.formattedReport,
    chainSwitch: chainSwitched,
    suggestions,
    metadata: {
      hyperliquidPositions: summary.positions,
      hyperliquidAccount: {
        activated: summary.activated,
        perpAccountValueUsd: summary.perpAccountValueUsd,
        spotUsdcUsd: summary.spotUsdcUsd,
        totalAccountValueUsd: summary.totalAccountValueUsd,
        globalLeverage: summary.globalLeverage,
      },
    },
  };
}

// ── Markets ────────────────────────────────────────────────────────────

export async function handle_hyperliquid_get_markets(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const chainSwitched = switchToHyperEVM(ctx);
  const [meta, mids] = await Promise.all([getHyperliquidMeta(), getHyperliquidMids()]);

  const lines: string[] = ["📈 Hyperliquid Perp Markets", ""];
  lines.push("| Market | Index | Price | Max Lev |");
  lines.push("|--------|-------|-------|---------|");
  meta.universe.forEach((u, i) => {
    const px = parseFloat(mids[u.name]);
    const pxStr = Number.isFinite(px)
      ? `$${px.toLocaleString("en-US", { maximumFractionDigits: px >= 1000 ? 1 : 4 })}`
      : "—";
    lines.push(`| ${u.name} | ${i} | ${pxStr} | ${u.maxLeverage}x |`);
  });

  return {
    message: lines.join("\n"),
    chainSwitch: chainSwitched,
    suggestions: ["Show my Hyperliquid positions"],
  };
}

// ── Deposit (bridges EVM USDC into Core; activates the account) ────────

export async function handle_hyperliquid_deposit(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  const chainSwitched = switchToHyperEVM(ctx);

  let amount = String(args.amount ?? "").trim();
  if (!amount) throw new Error("Specify the USDC amount to deposit, e.g. amount=\"500\".");

  // Cap to the vault's EVM USDC balance on HyperEVM.
  const { balance, decimals } = await getVaultTokenBalance(HYPEREVM_CHAIN_ID, ctx.vaultAddress as Address, HYPEREVM_USDC);
  const available = Number(balance) / 10 ** decimals;
  let cappedNote = "";
  const requested = parseFloat(amount.replace(/[$,]/g, ""));
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`Invalid deposit amount: ${amount}`);
  }
  if (requested > available) {
    if (available < 1) {
      throw new Error(
        `Insufficient USDC on HyperEVM. Requested: ${requested} USDC, available: ${available.toFixed(4)} USDC. ` +
        `Bridge USDC to the vault on HyperEVM first.`,
      );
    }
    amount = available.toFixed(6);
    cappedNote = `\n⚠️ Amount capped to the vault's available balance: ${amount} USDC`;
  }

  const calldata = buildHlDepositCalldata(amount);
  const transaction = draft(ctx, calldata, `[Hyperliquid] Deposit ${amount} USDC into Core perp account`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Hyperliquid deposit ready`,
      `Amount: ${amount} USDC (from HyperEVM → Core perp account)`,
      `This activates the Core account if it isn't active yet.`,
      `Note: NAV-sensitive vault operations pause for ~128s after the deposit while HyperCore settles.`,
      cappedNote,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };
}

// ── Limit order (open / increase / decrease / close) ───────────────────

function findOpenPosition(positions: HlApiPosition[], coin: string): HlApiPosition | undefined {
  return positions.find((p) => p.coin.toUpperCase() === coin.toUpperCase() && Math.abs(parseFloat(p.szi) || 0) > 0);
}

export async function handle_hyperliquid_limit_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  const chainSwitched = switchToHyperEVM(ctx);

  const coin = String(args.coin ?? "").trim().toUpperCase();
  if (!coin) throw new Error("Specify the market, e.g. coin=\"BTC\".");
  const assetIndex = await resolveHlAssetIndex(coin);
  const meta = await getHyperliquidMeta();
  const assetMeta = meta.universe[assetIndex];
  const szDecimals = assetMeta?.szDecimals ?? 6;

  const closeRequested = args.close === true || args.close === "true";
  let sizeArg = String(args.size ?? "").trim();
  let reduceOnly = args.reduceOnly === true || args.reduceOnly === "true";
  let side = String(args.side ?? "").trim().toLowerCase(); // "buy" | "sell"

  // ── Resolve against the open position for close/decrease flows ──────
  let position: HlApiPosition | undefined;
  const isAll = /^(all|100%)$/i.test(sizeArg);
  const pctMatch = sizeArg.match(/^(\d+(?:\.\d+)?)%$/);
  if (closeRequested || isAll || pctMatch || (!sizeArg && String(args.notionalUsd ?? "") === "")) {
    const state = await fetchClearinghouseState(ctx.vaultAddress as Address).catch(() => null);
    position = state ? findOpenPosition(
      state.assetPositions.map((ap) => ap.position),
      coin,
    ) : undefined;
    if (closeRequested || isAll) {
      if (!position) {
        throw new Error(`No open ${coin} position to close.`);
      }
      reduceOnly = true;
      side = (parseFloat(position.szi) || 0) >= 0 ? "sell" : "buy";
      sizeArg = String(Math.abs(parseFloat(position.szi) || 0));
    } else if (pctMatch) {
      if (!position) {
        throw new Error(`No open ${coin} position to size the percentage against.`);
      }
      reduceOnly = true;
      side = (parseFloat(position.szi) || 0) >= 0 ? "sell" : "buy";
      const pct = parseFloat(pctMatch[1]) / 100;
      sizeArg = String(Math.abs(parseFloat(position.szi) || 0) * pct);
    }
  }

  const isBuy = side ? side === "buy" : !reduceOnly;
  if (side && side !== "buy" && side !== "sell") {
    throw new Error(`Invalid side: ${side} (use "buy" or "sell").`);
  }

  // ── Price: explicit limit price, or a marketable IOC bounded by 1% slippage ──
  const mids = await getHyperliquidMids();
  const midPx = parseFloat(mids[coin]);
  let priceStr = String(args.price ?? "").trim();
  let tif: HlTifName = (String(args.tif ?? "").trim().toLowerCase() as HlTifName) || "gtc";
  if (priceStr) {
    if (!Number.isFinite(parseFloat(priceStr))) throw new Error(`Invalid limit price: ${priceStr}`);
    if (args.tif) tif = String(args.tif).trim().toLowerCase() as HlTifName;
  } else {
    if (!Number.isFinite(midPx) || midPx <= 0) {
      throw new Error(`No live price available for ${coin} — provide an explicit limit price.`);
    }
    const bounded = (midPx * Number(10_000n + (isBuy ? SLIPPAGE_BPS : -SLIPPAGE_BPS))) / 10_000;
    priceStr = bounded.toFixed(8);
    tif = "ioc"; // marketable: fill immediately up to the 1% bound or fail
  }

  // ── Size: base units, percentage of position, or USD notional ───────
  let sizeHuman: number;
  const notionalUsd = String(args.notionalUsd ?? "").trim();
  if (notionalUsd) {
    const notional = parseFloat(notionalUsd.replace(/[$,]/g, ""));
    const px = parseFloat(priceStr);
    if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(px) || px <= 0) {
      throw new Error(`Invalid notionalUsd: ${notionalUsd}`);
    }
    sizeHuman = notional / px;
  } else if (sizeArg) {
    sizeHuman = parseFloat(sizeArg.replace(/[$,]/g, ""));
    if (!Number.isFinite(sizeHuman) || sizeHuman <= 0) {
      throw new Error(`Invalid order size: ${sizeArg}`);
    }
  } else {
    throw new Error(`Specify the order size: size (in ${coin}), size="50%", size="all", or notionalUsd.`);
  }

  const limitPx = toHlPx(priceStr);
  const sz = toHlSz(sizeHuman.toFixed(10), szDecimals);
  const cloidArg = args.cloid ? BigInt(String(args.cloid)) : randomCloid();

  // Hyperliquid rejects orders below a $10 minimum value ("Order must have
  // minimum value of 10 USD"), with an exception only for exact position
  // closes. The engine computes value on the quantized (szDecimals) size, so
  // do the same here — reject before building a transaction whose order can
  // never fill.
  const pxHuman = parseFloat(priceStr);
  const sizeSubmitted = Number(formatUnits(sz, 8));
  const notionalUsdValue = sizeSubmitted * pxHuman;
  const exactClose = reduceOnly && (closeRequested || isAll);
  if (notionalUsdValue < 10 && !exactClose) {
    throw new Error(
      `$${notionalUsdValue.toFixed(2)} is below Hyperliquid's $10 minimum order value. ` +
      `Increase the amount (e.g. notionalUsd=10 or size accordingly).`,
    );
  }

  const calldata = buildHlLimitOrderCalldata({
    asset: assetIndex,
    isBuy,
    limitPx,
    sz,
    reduceOnly,
    tif,
    cloid: cloidArg,
  });

  const sizeDisplayed = sizeSubmitted;
  const verb = reduceOnly
    ? closeRequested || isAll ? "Close position" : "Decrease position"
    : position && !closeRequested ? "Increase position" : "Open position";
  const transaction = draft(
    ctx,
    calldata,
    `[Hyperliquid] ${verb}: ${isBuy ? "BUY" : "SELL"} ${sizeDisplayed} ${coin} @ ${pxHuman} (${tif.toUpperCase()})`,
  );

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Hyperliquid limit order ready`,
      `${verb}: ${isBuy ? "BUY" : "SELL"} ${sizeDisplayed} ${coin} (~$${notionalUsdValue.toLocaleString("en-US", { maximumFractionDigits: 2 })})`,
      `Limit price: $${pxHuman}   |   TIF: ${tif.toUpperCase()}${reduceOnly ? "   |   reduce-only" : ""}`,
      `Leverage: ${position?.leverage?.value ? `${position.leverage.value}x (existing position)` : `not set — Hyperliquid defaults to cross margin; account leverage is shown in the positions report`}`,
      `Client order id (cloid): 0x${cloidArg.toString(16)} — quote it to cancel this order`,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };
}

// ── Cancel order ───────────────────────────────────────────────────────

export async function handle_hyperliquid_cancel_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  const chainSwitched = switchToHyperEVM(ctx);

  const coin = String(args.coin ?? "").trim().toUpperCase();
  if (!coin) throw new Error("Specify the market, e.g. coin=\"BTC\".");
  const assetIndex = await resolveHlAssetIndex(coin);

  let oid = args.orderId != null ? Number(args.orderId) : undefined;
  let cloid: bigint | undefined = args.cloid != null ? BigInt(String(args.cloid)) : undefined;

  if (oid == null && cloid == null) {
    // Disambiguate from open orders on this market.
    const orders = (await fetchOpenOrders(ctx.vaultAddress as Address).catch(() => [])).filter(
      (o) => o.coin.toUpperCase() === coin,
    );
    if (orders.length === 1) {
      oid = orders[0].oid;
    } else if (orders.length === 0) {
      throw new Error(`No open ${coin} orders to cancel.`);
    } else {
      throw new Error(
        `Multiple open ${coin} orders: ${orders.map((o) => `oid ${o.oid}`).join(", ")}. Specify orderId or cloid.`,
      );
    }
  }

  const calldata = oid != null
    ? buildHlCancelByOidCalldata(assetIndex, oid)
    : buildHlCancelByCloidCalldata(assetIndex, cloid!);
  const transaction = draft(
    ctx,
    calldata,
    `[Hyperliquid] Cancel ${coin} order ${oid != null ? `#${oid}` : `cloid 0x${cloid!.toString(16).slice(0, 12)}…`}`,
  );

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Hyperliquid cancel order ready`,
      `Market: ${coin}   |   ${oid != null ? `Order id: ${oid}` : `Cloid: 0x${cloid!.toString(16)}`}`,
      ...(actionLine ? [actionLine] : []),
    ].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };
}

// ── Withdrawal step 1: perp margin → Core spot ────────────────────────

export async function handle_hyperliquid_usd_class_transfer(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  const chainSwitched = switchToHyperEVM(ctx);

  let amount = String(args.amount ?? "").trim();
  if (!amount) throw new Error("Specify the USDC amount to move to Core spot, e.g. amount=\"250\".");

  // Cap to the withdrawable perp balance.
  const state = await fetchClearinghouseState(ctx.vaultAddress as Address).catch(() => null);
  let cappedNote = "";
  if (state) {
    const withdrawable = parseFloat(state.withdrawable) || 0;
    const requested = parseFloat(amount.replace(/[$,]/g, ""));
    if (requested > withdrawable) {
      if (withdrawable < 1) {
        throw new Error(
          `Only ${withdrawable.toFixed(4)} USDC is withdrawable from the perp account (open positions tie up margin).`,
        );
      }
      amount = withdrawable.toFixed(6);
      cappedNote = `\n⚠️ Amount capped to the withdrawable balance: ${amount} USDC`;
    }
  }

  const calldata = buildHlUsdClassTransferCalldata(amount);
  const transaction = draft(ctx, calldata, `[Hyperliquid] Move ${amount} USDC from perp margin to Core spot`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Hyperliquid withdrawal step 1 ready`,
      `Moves ${amount} USDC from the Core perp account to the Core spot account.`,
      `Follow up with hyperliquid_spot_send to bridge it back to HyperEVM.`,
      cappedNote,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };
}

// ── Withdrawal step 2: Core spot → HyperEVM ───────────────────────────

export async function handle_hyperliquid_spot_send(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  const chainSwitched = switchToHyperEVM(ctx);

  let amount = String(args.amount ?? "").trim();
  if (!amount) throw new Error("Specify the USDC amount to bridge back to HyperEVM, e.g. amount=\"250\".");

  // The adapter keeps a 1e7 core-wei (0.1 USDC) bridge-fee reserve in the spot account.
  const BRIDGE_RESERVE = 1e7;
  const pre = await getHyperliquidPrecompileBalances(ctx.vaultAddress as Address);
  const spotHuman = Number(pre.spotUsdcWei) / 1e8;
  let cappedNote = "";
  const requested = parseFloat(amount.replace(/[$,]/g, ""));
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const maxSendable = Number(pre.spotUsdcWei) / 1e8 - BRIDGE_RESERVE / 1e8;
  if (requested > maxSendable) {
    if (maxSendable < 1) {
      throw new Error(
        `Insufficient Core spot USDC. Available: ${spotHuman.toFixed(4)} USDC (0.1 USDC is kept as a bridge-fee reserve). ` +
        `Run hyperliquid_usd_class_transfer first to move perp margin to spot.`,
      );
    }
    amount = maxSendable.toFixed(6);
    cappedNote = `\n⚠️ Amount capped to the spot balance minus the 0.1 USDC bridge reserve: ${amount} USDC`;
  }

  const calldata = buildHlSpotSendCalldata(amount);
  const transaction = draft(ctx, calldata, `[Hyperliquid] Bridge ${amount} USDC from Core spot to HyperEVM`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Hyperliquid withdrawal step 2 ready`,
      `Bridges ${amount} USDC from the Core spot account back to the vault on HyperEVM.`,
      `Note: the bridged USDC lands in the vault wallet after HyperCore settlement (~128s).`,
      cappedNote,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };
}


// ── Fills + open orders (post-execution tracking) ─────────────────────

const MAX_FILLS_SHOWN = 10;

function formatFillTime(timeMs: number): string {
  return new Date(timeMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export async function handle_hyperliquid_get_fills(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
  if (!ctx.vaultAddress) {
    throw new Error("Set a vault address first.");
  }
  const chainSwitched = switchToHyperEVM(ctx);
  const vault = ctx.vaultAddress as Address;

  const [fills, orders] = await Promise.all([
    fetchUserFills(vault).catch(() => [] as HlUserFill[]),
    fetchOpenOrders(vault).catch(() => [] as HlOpenOrder[]),
  ]);

  const lines: string[] = [];
  if (fills.length === 0) {
    lines.push("No fills recorded yet for this vault's Core account.");
  } else {
    lines.push(`✅ Last ${Math.min(fills.length, MAX_FILLS_SHOWN)} Hyperliquid fills (newest first)`);
    for (const f of fills.slice(0, MAX_FILLS_SHOWN)) {
      const px = parseFloat(f.px) || 0;
      const sz = parseFloat(f.sz) || 0;
      const pnl = parseFloat(f.closedPnl) || 0;
      const pnlPart = Math.abs(pnl) > 1e-9
        ? `   |   PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
        : "";
      lines.push(
        `${formatFillTime(f.time)}   |   ${f.side === "B" ? "BUY" : "SELL"} ${sz} ${f.coin} @ $${px.toLocaleString("en-US", { maximumFractionDigits: 2 })} ` +
        `(~$${(px * sz).toLocaleString("en-US", { maximumFractionDigits: 2 })})   |   ${f.dir}${pnlPart}`,
      );
    }
  }

  lines.push("");
  if (orders.length === 0) {
    lines.push("Open orders: none. An order that is neither open nor filled expired or was cancelled (IOC orders that don't fill expire immediately).");
  } else {
    lines.push(`⏳ Open Orders (${orders.length})`);
    for (const o of orders) {
      lines.push(
        `${o.side === "B" ? "BUY" : "SELL"} ${o.sz} ${o.coin} @ $${o.limitPx}` +
        `   |   oid ${o.oid}${o.cloid ? `   |   cloid ${o.cloid}` : ""}` +
        `${o.reduceOnly ? "   |   reduce-only" : ""}${o.tif ? `   |   ${String(o.tif).toUpperCase()}` : ""}`,
      );
    }
  }

  return {
    message: lines.join("\n"),
    chainSwitch: chainSwitched,
    suggestions: ["refresh fills"],
  };
}
