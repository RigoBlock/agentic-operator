/**
 * Lighter calldata builders.
 *
 * All transactions target the VAULT (the ALighter adapter runs in delegatecall
 * context), mirroring how the Hyperliquid adapter calls work. Lighter Core
 * writes are ASYNCHRONOUS: a successful EVM transaction only means Core
 * ACCEPTED the request — the emitted OrderSent(reqId) / returned reqId is the
 * handle for the final outcome, checked with lighter_get_request_status
 * (READ_CORE 0x0000). User-facing text must never claim an order filled.
 *
 * Unit conversions (USDC-only integration):
 *   - deposit amount / withdraw baseAmount : EVM USDC, 6 decimals (uint256 / uint64 —
 *     USDC's Core tickSize is 1, so Core base units are already 6-dec USDC)
 *   - order amount : base-asset units scaled by the market's sizeDecimals (uint48)
 *   - order price  : quote units scaled by the market's priceDecimals (uint32)
 *
 * Market decimals come from LIGHTER_MARKET_DECIMALS — the adapter's own
 * LighterConstants table (ALighter v4.6.3), mirrored here. The first order on
 * a market auto-tracks it on-chain; there is no manual tracking step.
 */

import {
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  RIGOBLOCK_LIGHTER_ABI,
  LIGHTER_SELECTORS,
  LIGHTER_USDC_ASSET_INDEX,
  LIGHTER_FIRST_SPOT_MARKET_ID,
  LIGHTER_ORDER_TYPES,
  LIGHTER_TIF,
  LIGHTER_MARKET_DECIMALS,
  LIGHTER_MARKET_SYMBOLS,
} from "../abi/lighter.js";
import { readLighterMarketInfo } from "./lighter.js";

const U48_MAX = (1n << 48n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const NUMBER_SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** viem types uintN (N ≤ 64) as number in encodeFunctionData args — convert safely. */
function num(b: bigint, what: string): number {
  if (b > NUMBER_SAFE_MAX) throw new Error(`Lighter ${what} exceeds the safe integer range: ${b}.`);
  return Number(b);
}

/** GTT expiry window enforced by Lighter Core: 5 minutes … 30 days from now. */
export const LIGHTER_MIN_EXPIRY_MS = 5 * 60 * 1000;
export const LIGHTER_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** Default GTT expiry: 24 hours. */
export const LIGHTER_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Market-order bound: mark price ±1% (mirrors the Hyperliquid 1% market bound). */
const MARKET_BOUND_BPS = 100;

// ── Unit conversions ──────────────────────────────────────────────────

/** Human base-asset size → uint48 amount on the market's sizeDecimals scale.
 *  Must be an EXACT integer on that scale — sub-tick sizes are rejected.
 *  Parses the decimal string exactly: float multiplication misclassifies exact
 *  ticks (0.0006 × 10^5 computes to 59.99999999999999, not 60). */
export function toLighterAmount(size: number | string, sizeDecimals: number): bigint {
  const raw = String(size).replace(/[$,]/g, "").trim();
  const m = /^(\d*)(?:\.(\d+))?$/.exec(raw);
  if (!m || (m[1] === "" && m[2] === undefined)) {
    throw new Error(`Invalid Lighter order size: ${size} (must be a positive number).`);
  }
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > sizeDecimals) {
    throw new Error(
      `Lighter order size ${size} is below this market's size tick (sizeDecimals = ${sizeDecimals}). ` +
      `Use a size with at most ${sizeDecimals} decimal places.`,
    );
  }
  const amount = BigInt(whole) * (10n ** BigInt(sizeDecimals)) + BigInt(frac.padEnd(sizeDecimals, "0") || "0");
  if (amount <= 0n) throw new Error(`Invalid Lighter order size: ${size} (must be a positive number).`);
  if (amount > U48_MAX) throw new Error(`Lighter order size too large: ${size}`);
  return amount;
}

/** Human price → uint32 price on the market's priceDecimals scale.
 *  Truncated toward zero to the valid tick (never rounded up — a truncated buy
 *  bound stays at/under the cap and a sell bound at/over it). */
export function toLighterPrice(price: number | string, priceDecimals: number): bigint {
  const n = typeof price === "string" ? parseFloat(price.replace(/[$,]/g, "")) : price;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid Lighter price: ${price} (must be a positive number).`);
  }
  const scale = 10 ** priceDecimals;
  const scaled = Math.floor(n * scale + 1e-6);
  if (scaled <= 0) throw new Error(`Lighter price too small: ${price}`);
  const px = BigInt(scaled);
  if (px > U32_MAX) throw new Error(`Lighter price too large: ${price}`);
  return px;
}

/** Human USDC amount → 6-decimal units (sendToCore amount / sendToEvm baseAmount). */
export function usdToLighterBaseUnits(amount: number | string): bigint {
  const n = typeof amount === "string" ? parseFloat(amount.replace(/[$,]/g, "")) : amount;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid USDC amount: ${amount} (must be a positive number).`);
  }
  const units = BigInt(Math.round(n * 1e6));
  if (units === 0n) throw new Error(`USDC amount too small: ${amount}`);
  return units;
}

/** Random uint48 client order index. */
export function randomClientOrderIndex(): bigint {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return BigInt(`0x${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`) & ((1n << 48n) - 1n);
}

/**
 * Resolve a perp market's decimals from the adapter's LighterConstants table
 * (mirrored in LIGHTER_MARKET_DECIMALS). Only markets in the table are
 * tradeable — any other id reverts UnknownMarket on-chain; fail here instead.
 */
export function getLighterMarketDecimals(marketId: number): { sizeDecimals: number; priceDecimals: number } {
  if (!Number.isInteger(marketId) || marketId < 0 || marketId >= LIGHTER_FIRST_SPOT_MARKET_ID) {
    throw new Error(
      `Invalid Lighter perp market id: ${marketId} (perp markets are 0 … ${LIGHTER_FIRST_SPOT_MARKET_ID - 1}).`,
    );
  }
  const decimals = LIGHTER_MARKET_DECIMALS[marketId];
  if (!decimals) {
    const tradeable = Object.entries(LIGHTER_MARKET_DECIMALS)
      .map(([id, _]) => `${id} ${LIGHTER_MARKET_SYMBOLS[Number(id)] ?? ""}`.trim())
      .join(", ");
    throw new Error(
      `Unknown Lighter market ${marketId} — tradeable markets: ${tradeable}. ` +
      "New markets require a protocol release.",
    );
  }
  return decimals;
}

/** Clamp a GTT expiry into Lighter's 5 min … 30 d window. */
export function clampLighterExpiry(expiryMs: number, nowMs: number): number {
  return Math.min(Math.max(expiryMs, nowMs + LIGHTER_MIN_EXPIRY_MS), nowMs + LIGHTER_MAX_EXPIRY_MS);
}

// ── Public builders (all return vault-targeted calldata) ──────────────

/** sendToCore(3, vault, false, amount×1e6, 0) — deposit pool USDC into Core perps margin.
 *  First deposit auto-creates the vault's Core master account. */
export function buildLighterDepositCalldata(vault: Address, amountHuman: string): Hex {
  const amount = parseUnits(amountHuman.replace(/[$,]/g, ""), 6);
  if (amount <= 0n) throw new Error(`Invalid deposit amount: ${amountHuman}`);
  return encodeFunctionData({
    abi: RIGOBLOCK_LIGHTER_ABI,
    functionName: "sendToCore",
    args: [LIGHTER_USDC_ASSET_INDEX, vault, false, amount, 0],
  });
}

/** sendToEvm(0, 3, vault, 0, amount×1e6) — withdraw USDC from Core perps back to the pool.
 *  Reverts AccountNotActivated when no Core account exists. accountIndex is ignored
 *  by the adapter (it substitutes the vault's own). */
export function buildLighterWithdrawCalldata(vault: Address, amountHuman: string): Hex {
  const baseAmount = usdToLighterBaseUnits(amountHuman);
  if (baseAmount > U64_MAX) throw new Error(`Withdrawal amount too large: ${amountHuman}`);
  return encodeFunctionData({
    abi: RIGOBLOCK_LIGHTER_ABI,
    functionName: "sendToEvm",
    args: [0, LIGHTER_USDC_ASSET_INDEX, vault, 0, baseAmount],
  });
}

export interface LighterOrderParams {
  chainId: number;
  vault: Address;
  marketId: number;
  side: "buy" | "sell";
  sizeHuman: string;
  /** Limit price in human quote units. Omitted for market orders. */
  priceHuman?: string;
  /** true = market order (IOC, price = mark ±1%); false = resting limit (GTT default). */
  isMarket: boolean;
  /** Time in force for limit orders: 'gtt' (default) or 'postOnly'. */
  tif?: "gtt" | "postOnly";
  /** Explicit GTT expiry (ms since epoch); clamped to now+5min … now+30d. */
  expiryMs?: number;
  reduceOnly?: boolean;
}

export interface BuiltLighterOrder {
  calldata: Hex;
  /** Resolved values for the user-facing summary. */
  amount: bigint;
  price: bigint;
  orderType: number;
  tifCode: number;
  expiry: bigint;
  isAsk: boolean;
  reduceOnly: boolean;
  clientOrderIndex: bigint;
  clientOrderIndexHex: string;
  /** Display-only: the human price actually encoded (post-truncation / bound). */
  priceHuman: string;
}

/**
 * createOrder — the single entry for perp orders. Deterministic validation:
 * market must be a tradeable perp (LighterConstants table) and < 2048; amount
 * must be an exact integer on the market's sizeDecimals scale and fit uint48;
 * price must fit uint32. The first order on a market auto-tracks it on-chain.
 *
 *  - Market order (isMarket): forced IOC (tif 0), no expiry, price = mark ±1%
 *    (buy = mark × 1.01, sell = mark × 0.99, rounded to an integer price tick,
 *    fetched from READ_CORE 0x0005).
 *  - Limit order: GTT (tif 1) by default with expiry now+24h clamped to
 *    5min…30d; postOnly (tif 2) keeps the expiry. reduceOnly allowed on both.
 *
 * Every order reads the market's on-chain configuration (READ_CORE 0x0005) and
 * is HARD-REJECTED below Core's minimum order size (minBaseAmount) or minimum
 * notional (minQuoteAmount, 6-dec USDC) — both are exact sequencer values, so
 * undersized orders fail here instead of being accepted by Core and cancelled
 * at matching. Margin adequacy is NOT checked here: the market-default initial
 * margin fraction is not readable on-chain and Core does not margin-reject at
 * placement anyway — the handler surfaces a conservative collateral warning.
 */
export async function buildLighterOrderCalldata(p: LighterOrderParams): Promise<BuiltLighterOrder> {
  const tracked = getLighterMarketDecimals(p.marketId);
  const isAsk = p.side === "sell";
  const reduceOnly = p.reduceOnly === true;
  const amount = toLighterAmount(p.sizeHuman, tracked.sizeDecimals);
  const clientOrderIndex = randomClientOrderIndex();

  // Live market config, required for every order: the mark price bounds market
  // orders and the on-chain minimums gate all orders.
  const info = await readLighterMarketInfo(p.chainId, p.marketId);
  if (!info) {
    throw new Error(
      `No live market data for Lighter market ${p.marketId} — the Core read failed or the market does not exist. Try again shortly.`,
    );
  }

  let orderType: number;
  let tifCode: number;
  let expiry = 0n;
  let price: bigint;
  let priceHuman: string;

  if (p.isMarket) {
    orderType = LIGHTER_ORDER_TYPES.market;
    tifCode = LIGHTER_TIF.ioc;
    // ±1% bound on the Core mark price, rounded to an integer price tick,
    // conservative in both directions: a BUY bound rounds DOWN (stays at/under
    // the cap), a SELL bound rounds UP (stays at/over it).
    const mark = BigInt(info.markPrice);
    const boundBps = BigInt(10_000 + (isAsk ? -MARKET_BOUND_BPS : MARKET_BOUND_BPS));
    const numerator = mark * boundBps;
    const bounded = numerator / 10_000n;
    const remainder = numerator % 10_000n;
    price = isAsk && remainder > 0n ? bounded + 1n : bounded;
    if (price <= 0n) {
      throw new Error(`Computed market-order price for market ${p.marketId} rounds to zero — use an explicit limit price.`);
    }
    if (price > U32_MAX) throw new Error(`Computed market-order price exceeds the uint32 limit for market ${p.marketId}.`);
    priceHuman = formatPriceHuman(price, tracked.priceDecimals);
  } else {
    orderType = LIGHTER_ORDER_TYPES.limit;
    if (p.tif === "postOnly") {
      tifCode = LIGHTER_TIF.postOnly;
    } else if (p.tif && p.tif !== "gtt") {
      throw new Error(`Invalid time-in-force for a Lighter limit order: ${p.tif} (use 'gtt' or 'postOnly').`);
    } else {
      tifCode = LIGHTER_TIF.gtt;
    }
    // GTT and postOnly both require an expiry inside the 5min…30d window.
    const requested = p.expiryMs ?? Date.now() + LIGHTER_DEFAULT_EXPIRY_MS;
    if (!Number.isFinite(requested)) throw new Error(`Invalid expiry: ${p.expiryMs}`);
    expiry = BigInt(clampLighterExpiry(requested, Date.now()));
    if (!p.priceHuman) {
      throw new Error("A Lighter limit order requires an explicit price.");
    }
    price = toLighterPrice(p.priceHuman, tracked.priceDecimals);
    priceHuman = formatPriceHuman(price, tracked.priceDecimals);
  }

  // Core's on-chain minimums (exact sequencer values) — hard stops. Below them
  // Core would accept the order and cancel it at matching, which surfaces as a
  // confirmed EVM transaction that never fills.
  if (amount < info.minBaseAmount) {
    const minHuman = formatPriceHuman(info.minBaseAmount, tracked.sizeDecimals);
    throw new Error(
      `Order size ${p.sizeHuman} is below Lighter market ${p.marketId}'s minimum order size (${minHuman} base units).`,
    );
  }
  const notionalMicroUsd = (amount * price * 1_000_000n) / 10n ** BigInt(tracked.sizeDecimals + tracked.priceDecimals);
  if (notionalMicroUsd < info.minQuoteAmount) {
    const notionalUsd = (Number(notionalMicroUsd) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const minUsd = (Number(info.minQuoteAmount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
    throw new Error(
      `Order notional (≈ $${notionalUsd}) is below Lighter market ${p.marketId}'s minimum of $${minUsd}.`,
    );
  }

  const calldata = encodeFunctionData({
    abi: RIGOBLOCK_LIGHTER_ABI,
    functionName: "createOrder",
    args: [
      0, // accountIndex — ignored by the adapter (vault's own is substituted)
      p.marketId,
      num(clientOrderIndex, "client order index"),
      orderType,
      tifCode,
      expiry,
      num(amount, "order amount"),
      num(price, "order price"),
      isAsk,
      reduceOnly,
      0, // triggerPrice — unused for plain limit/market orders
    ],
  });

  return {
    calldata,
    amount,
    price,
    orderType,
    tifCode,
    expiry,
    isAsk,
    reduceOnly,
    clientOrderIndex,
    clientOrderIndexHex: `0x${clientOrderIndex.toString(16)}`,
    priceHuman,
  };
}

/** Display a scaled integer price back in human units (trailing zeros trimmed). */
function formatPriceHuman(price: bigint, priceDecimals: number): string {
  const scale = 10n ** BigInt(priceDecimals);
  const whole = price / scale;
  const fraction = (price % scale).toString().padStart(priceDecimals, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

/** cancelOrder(0, orderIndex) — accountIndex ignored by the adapter. */
export function buildLighterCancelOrderCalldata(orderIndex: bigint | number | string): Hex {
  const idx = BigInt(orderIndex);
  if (idx < 0n || idx > U64_MAX) {
    throw new Error(`Invalid Lighter order index: ${orderIndex}.`);
  }
  return encodeFunctionData({
    abi: RIGOBLOCK_LIGHTER_ABI,
    functionName: "cancelOrder",
    args: [0, idx],
  });
}

/** cancelAllOrders(0) — cancels every open order of the vault's Core account. */
export function buildLighterCancelAllOrdersCalldata(): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_LIGHTER_ABI,
    functionName: "cancelAllOrders",
    args: [0],
  });
}
