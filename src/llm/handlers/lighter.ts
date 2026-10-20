/**
 * Lighter Tool Handlers
 *
 * Lighter runs on Lighter EVM devnet (chain 19529). The smart pool trades on
 * Lighter Core through the ALighter vault adapter:
 *
 * - Deposits bridge EVM USDC (6 decimals) into the Core perps margin and
 *   auto-create the vault's EVM-controlled Core master account on the FIRST
 *   deposit — there is no separate activation step.
 * - Withdrawals are a single sendToEvm step (USDC Core tickSize is 1, so base
 *   units are already 6-dec USDC) and revert AccountNotActivated with no account.
 * - Orders require the market tracked by the pool (lighter_track_market) and
 *   marketId < 2048. Tracked markets and their decimals are read from the
 *   pool's own on-chain view (EApps.getLighterTrackedMarkets, 0x5239dd83) —
 *   the same LighterConstants table the adapter prices NAV with, so the
 *   operator can never disagree with the contract. No KV ledger, no Core API,
 *   and market decimals are never user input.
 *
 * ASYNC SEMANTICS: every Lighter Core write is asynchronous. A successful EVM
 * transaction only means Core ACCEPTED the request — the tx emits
 * OrderSent(reqId) (or returns a reqId for transfers). The final outcome is
 * read with lighter_get_request_status (READ_CORE 0x0000). An accepted
 * createOrder can still leave NO position: an IOC/market order against an
 * empty book is cancelled, and the devnet ships with no market makers. User-
 * facing text must NEVER claim an order filled.
 *
 * All tools are gated to chain 19529 — calling them on any other chain rejects
 * with a clear message (unlike Hyperliquid there is no auto-switch: Lighter
 * Devnet is a testnet and must be chosen explicitly).
 */

import type { Env, RequestContext, TransactionDraft } from "../../types.js";
import type { ToolResult } from "../client.js";
import type { Address } from "viem";
import {
  LIGHTER_CHAIN_ID,
  LIGHTER_USDC,
  LIGHTER_TX_STATUS,
  LIGHTER_MARGIN_MODE_ISOLATED,
  LIGHTER_MARKET_SYMBOLS,
} from "../../abi/lighter.js";
import {
  readLighterMarketInfo,
  readLighterAccount,
  readLighterTxStatus,
  getLighterAccountActivation,
  getLighterPortfolio,
  getLighterTrackedMarkets,
  getLighterOpenOrderCounts,
  type TrackedMarket,
} from "../../services/lighter.js";
import {
  buildLighterDepositCalldata,
  buildLighterWithdrawCalldata,
  buildLighterOrderCalldata,
  buildLighterCancelOrderCalldata,
  buildLighterCancelAllOrdersCalldata,
  buildLighterTrackMarketCalldata,
  buildLighterUntrackMarketCalldata,
  LIGHTER_DEFAULT_EXPIRY_MS,
} from "../../services/lighterTrading.js";
import { getVaultTokenBalance } from "../../services/vault.js";
import { txActionLine } from "../client.js";

/**
 * Devnet perp ids 0..3 labeled per Lighter devnet docs — shared with the
 * portfolio report (LIGHTER_MARKET_SYMBOLS in abi/lighter.ts). Users pass
 * either the symbol ("ETH") or the numeric id (0); both resolve here.
 */
const DEVNET_PERP_LABELS: Record<number, string> = Object.fromEntries(
  Object.entries(LIGHTER_MARKET_SYMBOLS).filter(([id]) => Number(id) < 2048),
);
const DEVNET_PERP_IDS: Record<string, number> = Object.fromEntries(
  Object.entries(DEVNET_PERP_LABELS).map(([id, sym]) => [sym, Number(id)]),
);
const KNOWN_DEVNET_PERP_IDS = Object.keys(DEVNET_PERP_LABELS).map(Number);

/** Display label for a market id: "BTC (market 1)" when the symbol is known. */
function marketLabel(marketId: number): string {
  const symbol = LIGHTER_MARKET_SYMBOLS[marketId];
  return symbol ? `${symbol} (market ${marketId})` : `market ${marketId}`;
}

/** Resolve a Lighter perp market given as a numeric id (0) or symbol ("ETH"). */
export function resolveLighterMarketId(arg: unknown): number {
  const raw = String(arg ?? "").trim();
  const fail = (): never => {
    throw new Error(
      `Invalid Lighter market: ${String(arg)} — use a perp market id (integer < 2048, e.g. 0) or a ` +
      `known devnet symbol (${Object.keys(DEVNET_PERP_IDS).join(", ")}).`,
    );
  };
  if (!raw) fail();
  const bySymbol = DEVNET_PERP_IDS[raw.toUpperCase()];
  if (bySymbol !== undefined) return bySymbol;
  if (!/^\d+$/.test(raw)) fail();
  const marketId = Number(raw);
  if (!Number.isSafeInteger(marketId) || marketId < 0) fail();
  return marketId;
}

/** Lighter tools are gated to Lighter Devnet — reject other chains with a clear message. */
function assertLighterChain(ctx: RequestContext): void {
  if (ctx.chainId !== LIGHTER_CHAIN_ID) {
    throw new Error(
      `Lighter tools operate on Lighter Devnet (chain ${LIGHTER_CHAIN_ID}); the current chain is ${ctx.chainId}. ` +
      `Switch first: switch_chain chain="Lighter Devnet".`,
    );
  }
}

function draft(ctx: RequestContext, data: `0x${string}`, description: string): TransactionDraft {
  return {
    to: ctx.vaultAddress as Address,
    data,
    value: "0x0",
    chainId: LIGHTER_CHAIN_ID,
    description,
  };
}

function requireOperator(ctx: RequestContext): void {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }
}

function requireVault(ctx: RequestContext): Address {
  if (!ctx.vaultAddress) {
    throw new Error("Set a vault address first.");
  }
  return ctx.vaultAddress as Address;
}

function parseAmount(arg: unknown, what: string): string {
  const amount = String(arg ?? "").trim();
  if (!amount) throw new Error(`Specify the USDC amount to ${what}, e.g. amount="500".`);
  const n = parseFloat(amount.replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid USDC amount: ${amount}`);
  return amount;
}

function parseMarketId(arg: unknown): number {
  return resolveLighterMarketId(arg);
}

function parseSide(arg: unknown): "buy" | "sell" {
  const side = String(arg ?? "").trim().toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new Error(`Invalid side: ${side} (use "buy" or "sell").`);
  }
  return side;
}

/** Standard async-acceptance footer for every Lighter Core write. */
const ASYNC_NOTE =
  "Lighter Core writes are asynchronous: a successful transaction only means Core accepted the request. " +
  "Check the final outcome with lighter_get_request_status using the reqId from the transaction (OrderSent event).";

// ── Markets ────────────────────────────────────────────────────────────

export async function handle_lighter_get_markets(
  env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  assertLighterChain(ctx);
  const vault = requireVault(ctx);
  const tracked = await getLighterTrackedMarkets(LIGHTER_CHAIN_ID, vault);

  const ids = [...new Set([...tracked.map((m) => m.marketId), ...KNOWN_DEVNET_PERP_IDS])].sort((a, b) => a - b);

  const rows: string[] = [];
  const known: number[] = [];
  for (const id of ids) {
    const info = await readLighterMarketInfo(LIGHTER_CHAIN_ID, id);
    if (!info) continue;
    known.push(id);
    const t = tracked.find((m) => m.marketId === id);
    const label = DEVNET_PERP_LABELS[id] ? `${DEVNET_PERP_LABELS[id]} (docs-derived, unverified)` : "—";
    const typeLabel = info.marketType === 0 ? "perp" : `type ${info.marketType}`;
    const fmtPx = (raw: bigint) =>
      t ? (Number(raw) / 10 ** t.priceDecimals).toLocaleString("en-US", { maximumFractionDigits: t.priceDecimals }) : `${raw} (raw)`;
    const fmtBase = (raw: bigint) =>
      t ? (Number(raw) / 10 ** t.sizeDecimals).toLocaleString("en-US", { maximumFractionDigits: t.sizeDecimals }) : `${raw} (raw)`;
    rows.push(
      `| ${id} | ${label} | ${typeLabel} | ${info.takerFee} | ${info.makerFee} | ${fmtBase(info.minBaseAmount)} | ${fmtPx(info.indexPrice)} | ${fmtPx(info.markPrice)} |`,
    );
  }

  const lines: string[] = ["📈 Lighter Core Perp Markets (Lighter Devnet)", ""];
  if (rows.length === 0) {
    lines.push("No Lighter perp markets could be read from Core state.");
  } else {
    lines.push("| Id | Market | Type | Taker fee | Maker fee | Min size | Index price | Mark price |");
    lines.push("|----|--------|------|-----------|-----------|----------|-------------|------------|");
    lines.push(...rows);
  }
  lines.push("");
  lines.push(
    "Prices/sizes for tracked markets use the decimals from the pool's on-chain tracked-markets view; " +
    "untracked markets show raw market units (no decimals are available for them). Symbols for ids 0..3 are per the Lighter devnet docs.",
  );
  if (tracked.length > 0) {
    lines.push(`Tracked by this pool: ${tracked.map((m) => marketLabel(m.marketId)).join(", ")}.`);
  }

  return {
    message: lines.join("\n"),
    suggestions: ["Show my Lighter positions"],
  };
}

// ── Positions ──────────────────────────────────────────────────────────

export async function handle_lighter_get_positions(
  env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  assertLighterChain(ctx);
  const vault = requireVault(ctx);
  const tracked = await getLighterTrackedMarkets(LIGHTER_CHAIN_ID, vault);
  const [portfolio, activation] = await Promise.all([
    getLighterPortfolio(LIGHTER_CHAIN_ID, vault, tracked),
    getLighterAccountActivation(LIGHTER_CHAIN_ID, vault),
  ]);

  const suggestions: string[] = [];
  if (activation === false) {
    suggestions.push("Deposit USDC to Lighter");
  }
  suggestions.push("Show Lighter markets");
  if (portfolio.positions.length > 0) {
    suggestions.push("Refresh Lighter positions");
  } else {
    suggestions.push("Deposit USDC to Lighter");
  }

  return {
    message: [
      activation === false
        ? "⏳ No Lighter Core account yet — run lighter_deposit to bridge USDC into Lighter Core; the first deposit creates the account automatically."
        : null,
      portfolio.formattedReport,
    ].filter(Boolean).join("\n\n"),
    suggestions,
    metadata: {
      lighterPositions: portfolio.positions.map((p) => ({
        marketId: p.marketId,
        size: p.size.toString(),
        sizeHuman: p.sizeHuman,
        valueUsd: (Number(p.value) / 1e6).toString(),
        marginMode: p.marginMode === LIGHTER_MARGIN_MODE_ISOLATED ? "isolated" : "cross",
      })),
      lighterAccount: {
        accountExists: portfolio.accountExists,
        collateralUsd: (Number(portfolio.collateralBase) / 1e6).toString(),
        totalValueUsd: (Number(portfolio.totalValue) / 1e6).toString(),
      },
    },
  };
}

// ── Open orders ─────────────────────────────────────────────────────────

export async function handle_lighter_get_orders(
  _env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  assertLighterChain(ctx);
  const vault = requireVault(ctx);
  const tracked = await getLighterTrackedMarkets(LIGHTER_CHAIN_ID, vault);

  if (tracked.length === 0) {
    return {
      message: [
        "📋 Lighter Open Orders (Lighter Devnet)",
        "",
        "This pool tracks no markets yet — track one with lighter_track_market first.",
      ].join("\n"),
      suggestions: ["Show Lighter markets"],
    };
  }

  const counts = await getLighterOpenOrderCounts(LIGHTER_CHAIN_ID, vault, tracked);
  const lines: string[] = ["📋 Lighter Open Orders (Lighter Devnet)", ""];
  let anyOpen = false;
  for (const c of counts) {
    anyOpen = anyOpen || c.totalOrderCount > 0n;
    const tied =
      c.totalPositionTiedOrderCount > 0n
        ? `, plus ${c.totalPositionTiedOrderCount} SL/TP order(s) tied to a position`
        : "";
    lines.push(`- ${marketLabel(c.marketId)}: ${c.totalOrderCount} open order(s)${tied}`);
  }
  if (counts.length < tracked.length) {
    lines.push(
      `- Order state for ${tracked.length - counts.length} tracked market(s) could not be read from Core — try again in a moment.`,
    );
  }
  if (counts.length > 0 && !anyOpen) {
    lines.push("", "No open orders on the tracked markets.");
  }
  lines.push(
    "",
    "Lighter's on-chain reads expose order COUNTS only: READ_CORE has no order-listing query, so individual order prices and sizes are not readable on-chain.",
    "A full order list exists only on Lighter's Core API — but its account/order endpoints require an API key registered on the Core account (Schnorr auth), which the pool cannot register through the adapter.",
    "A limit order stays open until it fills, reaches its expiry, or is cancelled — quote its client order index (shown when the order was placed) with lighter_cancel_order.",
    "Market orders are IOC: they never rest on the book, so an unfilled market order leaves no open order.",
  );

  return {
    message: lines.join("\n"),
    suggestions: anyOpen ? ["Cancel a Lighter order", "Show my Lighter positions"] : ["Show Lighter markets"],
  };
}

// ── Deposit ────────────────────────────────────────────────────────────

export async function handle_lighter_deposit(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  const vault = requireVault(ctx);

  const amount = parseAmount(args.amount, "deposit into Lighter Core");

  // Cap to the vault's EVM USDC balance on Lighter Devnet.
  const { balance, decimals } = await getVaultTokenBalance(LIGHTER_CHAIN_ID, vault, LIGHTER_USDC);
  const available = Number(balance) / 10 ** decimals;
  let cappedNote = "";
  let finalAmount = amount;
  const requested = parseFloat(amount.replace(/[$,]/g, ""));
  if (requested > available) {
    if (available < 1) {
      throw new Error(
        `Insufficient USDC on Lighter Devnet. Requested: ${requested} USDC, available: ${available.toFixed(4)} USDC. ` +
        `Bridge USDC to the vault on Lighter Devnet first.`,
      );
    }
    finalAmount = available.toFixed(6);
    cappedNote = `\n⚠️ Amount capped to the vault's available balance: ${finalAmount} USDC`;
  }

  const calldata = buildLighterDepositCalldata(vault, finalAmount);
  const transaction = draft(ctx, calldata, `[Lighter] Deposit ${finalAmount} USDC into Core perps margin`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter deposit ready`,
      `Amount: ${finalAmount} USDC (Lighter Devnet → Lighter Core perps margin)`,
      `The first deposit also creates the vault's Lighter Core account automatically — no separate activation step.`,
      cappedNote,
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
  };
}

// ── Withdraw ───────────────────────────────────────────────────────────

export async function handle_lighter_withdraw(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  const vault = requireVault(ctx);

  const amount = parseAmount(args.amount, "withdraw from Lighter Core");

  // Cap to the Core perps collateral when it is readable.
  const account = await readLighterAccount(LIGHTER_CHAIN_ID, vault).catch(() => null);
  let cappedNote = "";
  let finalAmount = amount;
  if (account) {
    const collateral = Number(account.collateralBaseAmount) / 1e6;
    const requested = parseFloat(amount.replace(/[$,]/g, ""));
    if (requested > collateral) {
      if (collateral < 1) {
        throw new Error(
          `Only ${collateral.toFixed(4)} USDC of Core perps collateral is available (open positions tie up margin).`,
        );
      }
      finalAmount = collateral.toFixed(6);
      cappedNote = `\n⚠️ Amount capped to the Core collateral balance: ${finalAmount} USDC`;
    }
  }

  const calldata = buildLighterWithdrawCalldata(vault, finalAmount);
  const transaction = draft(ctx, calldata, `[Lighter] Withdraw ${finalAmount} USDC from Core perps margin`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter withdrawal ready`,
      `Amount: ${finalAmount} USDC (Lighter Core perps margin → the pool on Lighter Devnet)`,
      account ? "" : "Core account state could not be read — the amount was not capped on-chain; the transaction reverts if it exceeds the collateral.",
      cappedNote,
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
  };
}

// ── Orders ─────────────────────────────────────────────────────────────

interface OrderArgs {
  market: number;
  side: "buy" | "sell";
  size: string;
  price?: string;
  reduceOnly: boolean;
}

function parseOrderArgs(args: Record<string, unknown>, isMarket: boolean): OrderArgs {
  const market = parseMarketId(args.market);
  const side = parseSide(args.side);
  const size = String(args.size ?? "").trim();
  if (!size) throw new Error(`Specify the order size, e.g. size="0.15".`);
  if (!Number.isFinite(parseFloat(size.replace(/[$,]/g, ""))) || parseFloat(size.replace(/[$,]/g, "")) <= 0) {
    throw new Error(`Invalid order size: ${size}`);
  }
  const reduceOnly = args.reduceOnly === true || args.reduceOnly === "true";
  let price: string | undefined;
  if (!isMarket) {
    price = String(args.price ?? "").trim();
    if (!price) throw new Error('A Lighter limit order requires an explicit price, e.g. price="67234.5".');
  } else if (args.price != null && String(args.price).trim() !== "") {
    throw new Error('A Lighter market order must not include a price — use lighter_limit_order for a resting price.');
  }
  return { market, side, size, price, reduceOnly };
}

function orderVerb(reduceOnly: boolean): string {
  return reduceOnly ? "Decrease/close position" : "Open/increase position";
}

async function draftOrder(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  isMarket: boolean,
  tif?: "gtt" | "postOnly",
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  const vault = requireVault(ctx);
  const parsed = parseOrderArgs(args, isMarket);
  const tracked = await getLighterTrackedMarkets(LIGHTER_CHAIN_ID, vault);

  const expiryArg = args.expiry != null ? Number(args.expiry) : undefined;
  if (expiryArg != null && !Number.isFinite(expiryArg)) {
    throw new Error(`Invalid expiry: ${String(args.expiry)} (ms since epoch).`);
  }

  const built = await buildLighterOrderCalldata({
    chainId: LIGHTER_CHAIN_ID,
    vault,
    marketId: parsed.market,
    side: parsed.side,
    sizeHuman: parsed.size,
    priceHuman: parsed.price,
    isMarket,
    tif,
    expiryMs: expiryArg,
    reduceOnly: parsed.reduceOnly,
    trackedMarkets: tracked,
  });

  const trackedMarket = tracked.find((m) => m.marketId === parsed.market);
  const expiryNote =
    !isMarket
      ? `Expiry: ${new Date(Number(built.expiry)).toISOString().replace("T", " ").slice(0, 16)} UTC ` +
        `(${tif === "postOnly" ? "post-only, " : ""}${expiryArg != null ? "clamped to the 5min…30d window" : "default 24h"})`
      : "";

  const verb = orderVerb(parsed.reduceOnly);
  const transaction = draft(
    ctx,
    built.calldata,
    `[Lighter] ${verb}: ${parsed.side.toUpperCase()} ${parsed.size} ${marketLabel(parsed.market)} @ ${built.priceHuman}`,
  );

  // Factual margin context: order notional vs Core collateral. Core does not
  // margin-reject at request time (it accepts and cancels at matching), so
  // surfacing both numbers is the honest protection — no guessed leverage caps.
  const account = await readLighterAccount(LIGHTER_CHAIN_ID, vault).catch(() => null);
  const notionalUsd = trackedMarket
    ? Number((built.amount * built.price * 1_000_000n) / 10n ** BigInt(trackedMarket.sizeDecimals + trackedMarket.priceDecimals)) / 1e6
    : null;
  const collateralUsd = account ? Number(account.collateralBaseAmount) / 1e6 : null;
  const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const marginContextLine =
    notionalUsd != null && collateralUsd != null
      ? `Notional ≈ $${money(notionalUsd)}   |   Core collateral: $${money(collateralUsd)}`
      : "";
  // Conservative margin warning. The market-default initial margin fraction is
  // NOT readable on-chain, so estimate at 20% (≈5x leverage) — an upper bound
  // for typical perp markets. Reduce-only orders need no margin.
  const marginWarning =
    notionalUsd != null && collateralUsd != null && !parsed.reduceOnly && notionalUsd * 0.2 > collateralUsd
      ? `⚠️ Estimated initial margin (≈20% of notional ≈ $${money(notionalUsd * 0.2)}) exceeds the Core collateral of $${money(collateralUsd)}. ` +
        `Core accepts the order but will likely cancel it at matching without a fill — reduce the size or deposit more USDC first.`
      : "";

  // Activation is prompt-only: a known-missing account gets a warning, but the
  // order is still drafted — an accidental stale read must never block trading.
  const activation = await getLighterAccountActivation(LIGHTER_CHAIN_ID, vault);
  const activationNote =
    activation === false
      ? "⚠️ No Lighter Core account yet — this order will revert until you run lighter_deposit to create the account."
      : "";

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter ${isMarket ? "market" : "limit"} order ready`,
      `${verb}: ${parsed.side.toUpperCase()} ${parsed.size} on ${marketLabel(parsed.market)}${trackedMarket ? ` (sizeDecimals ${trackedMarket.sizeDecimals}, priceDecimals ${trackedMarket.priceDecimals})` : ""}`,
      isMarket
        ? `Market price: ${built.priceHuman} (Core mark price ${parsed.side === "buy" ? "+1%" : "−1%"} bound)   |   TIF: IOC${parsed.reduceOnly ? "   |   reduce-only" : ""}`
        : `Limit price: ${built.priceHuman}   |   TIF: ${tif === "postOnly" ? "post-only" : "GTT"}${parsed.reduceOnly ? "   |   reduce-only" : ""}`,
      marginContextLine,
      ...(marginWarning ? [marginWarning] : []),
      ...(expiryNote ? [expiryNote] : []),
      `Client order index: ${built.clientOrderIndexHex} — quote it to cancel this order`,
      activationNote,
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].filter(Boolean).join("\n"),
    transaction,
  };
}

export async function handle_lighter_limit_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  const postOnly = args.postOnly === true || args.postOnly === "true";
  return draftOrder(env, ctx, args, false, postOnly ? "postOnly" : "gtt");
}

export async function handle_lighter_market_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  return draftOrder(env, ctx, args, true);
}

// ── Cancels ────────────────────────────────────────────────────────────

export async function handle_lighter_cancel_order(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  requireVault(ctx);

  const raw = String(args.orderIndex ?? "").trim();
  if (!raw) throw new Error("Specify the order to cancel, e.g. orderIndex=\"0x2a…\" (the clientOrderIndex shown when the order was placed).");
  let orderIndex: bigint;
  try {
    orderIndex = BigInt(raw);
  } catch {
    throw new Error(`Invalid Lighter order index: ${raw} (decimal or 0x hex).`);
  }
  if (orderIndex < 0n) throw new Error(`Invalid Lighter order index: ${raw}`);

  const calldata = buildLighterCancelOrderCalldata(orderIndex);
  const transaction = draft(ctx, calldata, `[Lighter] Cancel order ${orderIndex.toString()}`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter cancel order ready`,
      `Order index: ${orderIndex.toString()}${orderIndex < (1n << 48n) ? " (treated by Core as a clientOrderIndex)" : ""}`,
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].join("\n"),
    transaction,
  };
}

export async function handle_lighter_cancel_all_orders(
  _env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  requireVault(ctx);

  const calldata = buildLighterCancelAllOrdersCalldata();
  const transaction = draft(ctx, calldata, "[Lighter] Cancel all open orders");

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter cancel-all ready`,
      `Cancels every open order of the vault's Lighter Core account.`,
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].join("\n"),
    transaction,
  };
}

// ── Track / untrack markets ────────────────────────────────────────────

export async function handle_lighter_track_market(
  _env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  const vault = requireVault(ctx);

  const marketId = parseMarketId(args.marketId);
  // Decimals are resolved on-chain: trackMarket(uint16) reads the adapter's
  // LighterConstants table at track time, and the pool's
  // getLighterTrackedMarkets view exposes exactly those values afterwards —
  // never user input (rogue decimals would distort the pool's NAV).

  // Validate against the live market read before drafting: a nonexistent market
  // or a non-perp reverts on-chain anyway, but failing here saves a signature.
  const info = await readLighterMarketInfo(LIGHTER_CHAIN_ID, marketId);
  if (info && info.marketType !== 0) {
    throw new Error(`Lighter market ${marketId} is not a perp market (marketType ${info.marketType}) — only perps can be tracked.`);
  }

  const calldata = buildLighterTrackMarketCalldata(marketId);
  const transaction = draft(ctx, calldata, `[Lighter] Track ${marketLabel(marketId)}`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter track-market ready`,
      `Market: ${marketLabel(marketId)}   |   on-chain trackMarket(uint16) takes no decimals (adapter's LighterConstants table)`,
      info
        ? "On-chain validation: market exists on Core and is a perp."
        : "Market info could not be read from Core — the transaction itself validates the market (it reverts if the market does not exist or is not a perp).",
      "After the transaction confirms, the market (with its adapter-resolved decimals) appears in the pool's on-chain tracked-markets view and can be traded.",
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].join("\n"),
    transaction,
  };
}

export async function handle_lighter_untrack_market(
  _env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  requireOperator(ctx);
  assertLighterChain(ctx);
  const vault = requireVault(ctx);

  const marketId = parseMarketId(args.marketId);
  const calldata = buildLighterUntrackMarketCalldata(marketId);
  const transaction = draft(ctx, calldata, `[Lighter] Untrack ${marketLabel(marketId)}`);

  const actionLine = txActionLine(ctx);
  return {
    message: [
      `✅ Lighter untrack-market ready`,
      `Market: ${marketLabel(marketId)}`,
      `Reverts on-chain while the pool holds a position on this market (PositionNotClosed).`,
      ASYNC_NOTE,
      ...(actionLine ? [actionLine] : []),
    ].join("\n"),
    transaction,
  };
}

// ── Request status ─────────────────────────────────────────────────────

export async function handle_lighter_get_request_status(
  _env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  assertLighterChain(ctx);
  requireVault(ctx);

  const raw = String(args.reqId ?? "").trim();
  if (!raw) throw new Error("Specify the Core request id, e.g. reqId=\"12345\" (from the transaction's OrderSent event).");
  let reqId: bigint;
  try {
    reqId = BigInt(raw);
  } catch {
    throw new Error(`Invalid reqId: ${raw} (decimal or 0x hex).`);
  }
  if (reqId < 0n) throw new Error(`Invalid reqId: ${raw}`);

  const status = await readLighterTxStatus(LIGHTER_CHAIN_ID, reqId);
  if (!status) {
    return {
      message: `Lighter Core request status for reqId ${reqId.toString()}: unknown — the status read failed (the request may still be pending, or the reqId is from a devnet reset).`,
      suggestions: ["Check again"],
    };
  }

  const label =
    status.status === LIGHTER_TX_STATUS.success
      ? "✅ success — Core processed the request"
      : status.status === LIGHTER_TX_STATUS.failed
        ? `❌ failed — Core rejected the request${status.errorCode != null ? ` (Core error code ${status.errorCode})` : ""}`
        : "⏳ pending — Core has not processed the request yet";
  return {
    message: `Lighter Core request ${reqId.toString()}: ${label}.`,
    suggestions: status.status === LIGHTER_TX_STATUS.pending ? ["Check again"] : [],
  };
}
