/**
 * Lighter Core account reads — the READ_CORE precompile on Lighter EVM devnet (19529).
 *
 * Every Lighter Core STATE read goes through the READ_CORE precompile
 * (0x6600…0000) via eth_call on LIGHTER_RPC_URL. Inputs are abi.encodePacked(uint16
 * queryId, args) WITHOUT a function selector. Since the Devnet 1.1.0 reset
 * (2026-10-26) every read except tx status (0x0000) returns the documented
 * (bool found, bytes data) envelope: found=false means the account/asset/market
 * does not exist and data is empty. The position read (0x0007) serves a 7-word
 * tuple WITHOUT the old leading lastFundingRatePrefixSum, and allocatedMargin is
 * in 6-dec USDC (10^6 per USDC — previously 12-dec). Withdrawal Core write type
 * is 0x48 (was 0x4c) with 72xx rejection codes (was 76xx); the app only surfaces
 * the numeric code. Encodings verified live against Devnet 1.1.0 on 2026-10-27.
 *
 * Tracked markets and their size/price decimals are read from the pool's own
 * on-chain view getLighterTrackedMarkets() (0x5239dd83, EApps) — since
 * ALighter v4.6.3 tracking is automatic (first order on a market tracks it;
 * the NAV loop untracks markets with no position and no open orders), so the
 * view reflects the pool's actual activity. This read feeds REPORTS ONLY;
 * order building resolves decimals from the LighterConstants table mirrored
 * in LIGHTER_MARKET_DECIMALS (abi/lighter.ts) — the same table the adapter
 * prices NAV with, so the operator can never disagree with the contract.
 * Decimals are NEVER user input.
 *
 * Read-failure policy (mirrors services/hyperliquid.ts):
 *  - Position/market/account reads return null on failure — callers report what
 *    they know and never hard-fail.
 *  - Account activation is prompt-only: null means "unknown, don't prompt";
 *    false means "no Core account — suggest lighter_deposit". A READ_CORE
 *    application-level failure ("READ_CORE query failed", the precompile's
 *    signal for a missing account) maps to false; transport/RPC failures map
 *    to null, so a flaky read can never block or mislead.
 */

import { decodeAbiParameters, type Address, type Hex } from "viem";
import {
  LIGHTER_CHAIN_ID,
  LIGHTER_READ_CORE,
  LIGHTER_QUERIES,
  LIGHTER_TX_STATUS,
  LIGHTER_MARGIN_MODE_ISOLATED,
  LIGHTER_VIEW_TRACKED_MARKETS,
  LIGHTER_VIEW_DATA_OUT,
  LIGHTER_MARKET_SYMBOLS,
} from "../abi/lighter.js";
import { getRpcProvider } from "./rpcClient.js";

// ── READ_CORE input encoding (abi.encodePacked: uint16 id + args) ─────

function hexByte(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function hexUint16(n: number): string {
  return n.toString(16).padStart(4, "0");
}

function hexUint32(n: number): string {
  return n.toString(16).padStart(8, "0");
}

function hexUint64(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(16, "0");
}

function hexAddress(a: Address): string {
  return a.toLowerCase().slice(2);
}

/** bool packs as ONE byte (0x00/0x01) under abi.encodePacked. */
function hexBool(b: boolean): string {
  return b ? "01" : "00";
}

function packQuery(queryId: number, ...parts: string[]): Hex {
  return `0x${hexUint16(queryId)}${parts.join("")}` as Hex;
}

// ── READ_CORE typed reads ─────────────────────────────────────────────

export interface LighterAccountInfo {
  accountType: number;
  accountIndex: bigint;
  masterAccountIndex: bigint;
  l1Address: Address;
  evmAddress: Address;
  /** Shared USDC margin (6-dec USDC); excludes isolated margin. */
  collateralBaseAmount: bigint;
}

export interface LighterMarketInfo {
  marketType: number;
  baseAssetId: number;
  quoteAssetId: number;
  takerFee: number;
  makerFee: number;
  minBaseAmount: bigint;
  minQuoteAmount: bigint;
  liquidationFee: number;
  indexPrice: bigint;
  markPrice: bigint;
}

export interface LighterPosition {
  /** Signed size on the market's sizeDecimals scale (createOrder amount units). */
  position: bigint;
  /** Unsigned entry NOTIONAL in 6-dec USDC (not a price). */
  entryQuote: bigint;
  initialMarginFraction: number;
  totalOrderCount: bigint;
  totalPositionTiedOrderCount: bigint;
  /** 0 = cross, 1 = isolated. */
  marginMode: number;
  /** Isolated margin in 6-dec USDC (Devnet 1.1.0 — was 12-dec before the reset). */
  allocatedMargin: bigint;
}

const ACCOUNT_INFO_OUT = [
  { type: "uint8" }, { type: "uint48" }, { type: "uint48" },
  { type: "address" }, { type: "address" }, { type: "int128" },
] as const;

const MARKET_INFO_OUT = [
  { type: "uint8" }, { type: "uint32" }, { type: "uint32" },
  { type: "uint32" }, { type: "uint32" }, { type: "uint64" },
  { type: "uint64" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" },
] as const;

// Devnet 1.1.0 position layout (Lighter "Reading Core from EVM"): a 7-word
// tuple WITHOUT the leading int64 lastFundingRatePrefixSum the 1.0.0 docs
// showed — the field was dropped in the reset. allocatedMargin is 6-dec USDC
// (10^6 per USDC; 1.0.0 served 12-dec). The two order-count fields are in
// docs order: word3 = totalOrderCount (currently open/resting orders), word4 =
// totalPositionTiedOrderCount (SL/TP conditional orders tied to a position's
// lifecycle). Verified against live state on 2026-10-27.
const POSITION_OUT = [
  { type: "int64" }, { type: "uint56" }, { type: "uint16" },
  { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "int128" },
] as const;

// Envelope served by every READ_CORE query except tx status (0x0000) since
// Devnet 1.1.0: abi.encode(bool found, bytes data). found=false (data empty)
// is the "entity does not exist" signal — a SUCCESS, not an error.
const FOUND_ENVELOPE_OUT = [{ type: "bool" }, { type: "bytes" }] as const;

/** Unwrap the (bool found, bytes data) envelope. Null data when not found. */
function unwrapFoundData(raw: Hex): Hex | null {
  const [found, data] = decodeAbiParameters(
    [...FOUND_ENVELOPE_OUT], raw,
  ) as unknown as readonly [boolean, Hex];
  return found ? data : null;
}

/** Strict word-count guard: a payload of the wrong size means the chain served
 *  a different read ABI — fail the read instead of silently misaligning every
 *  field (viem's decodeAbiParameters ignores trailing bytes, so without this
 *  an old-shape tuple decodes "successfully" into garbage). */
function hasExactWords(data: Hex, words: number): boolean {
  return data.length === 2 + 64 * words;
}

/**
 * Raw eth_call to READ_CORE with blockTag pinned to "latest" (bare
 * eth_estimateGas/eth_call intermittently hits unattached precompile state —
 * same observation as on HyperEVM, see AGENTS.md).
 */
async function callReadCore(chainId: number, data: Hex): Promise<Hex> {
  const client = getRpcProvider(chainId);
  const { data: returnData } = await client.call({
    to: LIGHTER_READ_CORE,
    data,
    blockTag: "latest",
  });
  return (returnData ?? "0x") as Hex;
}

/**
 * Account info (0x0001, 23 bytes in). A missing account returns
 * found=false → null (Devnet 1.1.0 envelope), mirroring LighterLib.coreAccountExists.
 */
export async function readLighterAccount(
  chainId: number,
  vaultAddress: Address,
): Promise<LighterAccountInfo | null> {
  if (chainId !== LIGHTER_CHAIN_ID) return null;
  try {
    const raw = await callReadCore(
      chainId,
      packQuery(LIGHTER_QUERIES.accountInfo, hexAddress(vaultAddress), hexBool(false)),
    );
    const data = unwrapFoundData(raw);
    if (data === null || !hasExactWords(data, 6)) return null;
    const [accountType, accountIndex, masterAccountIndex, l1Address, evmAddress, collateralBaseAmount] =
      decodeAbiParameters([...ACCOUNT_INFO_OUT], data) as unknown as readonly [number, number, number, Address, Address, bigint];
    return {
      accountType,
      accountIndex: BigInt(accountIndex),
      masterAccountIndex: BigInt(masterAccountIndex),
      l1Address,
      evmAddress,
      collateralBaseAmount,
    };
  } catch {
    return null;
  }
}

/** Market info (0x0005, 4 bytes in). Null when the market does not exist or the read fails. */
export async function readLighterMarketInfo(
  chainId: number,
  marketId: number,
): Promise<LighterMarketInfo | null> {
  if (chainId !== LIGHTER_CHAIN_ID) return null;
  try {
    const raw = await callReadCore(chainId, packQuery(LIGHTER_QUERIES.marketInfo, hexUint16(marketId)));
    const data = unwrapFoundData(raw);
    if (data === null || !hasExactWords(data, 10)) return null;
    const [marketType, baseAssetId, quoteAssetId, takerFee, makerFee, minBaseAmount, minQuoteAmount, liquidationFee, indexPrice, markPrice] =
      decodeAbiParameters([...MARKET_INFO_OUT], data) as unknown as readonly [number, number, number, number, number, bigint, bigint, number, bigint, bigint];
    return { marketType, baseAssetId, quoteAssetId, takerFee, makerFee, minBaseAmount, minQuoteAmount, liquidationFee, indexPrice, markPrice };
  } catch {
    return null;
  }
}

/** Position (0x0007, 25 bytes in). Null when there is no account/market or the read fails. */
export async function readLighterPosition(
  chainId: number,
  vaultAddress: Address,
  marketId: number,
): Promise<LighterPosition | null> {
  if (chainId !== LIGHTER_CHAIN_ID) return null;
  try {
    const raw = await callReadCore(
      chainId,
      packQuery(LIGHTER_QUERIES.position, hexAddress(vaultAddress), hexBool(false), hexUint16(marketId)),
    );
    const data = unwrapFoundData(raw);
    if (data === null || !hasExactWords(data, 7)) return null;
    const [position, entryQuote, initialMarginFraction, totalOrderCount, totalPositionTiedOrderCount, marginMode, allocatedMargin] =
      decodeAbiParameters([...POSITION_OUT], data) as unknown as readonly [bigint, number, number, bigint, bigint, number, bigint];
    return {
      position,
      entryQuote: BigInt(entryQuote),
      initialMarginFraction,
      totalOrderCount,
      totalPositionTiedOrderCount,
      marginMode,
      allocatedMargin,
    };
  } catch {
    return null;
  }
}

export interface LighterTxStatus {
  /** 0 = pending/unknown, 1 = success, 2 = failed. */
  status: number;
  /** Core error code when status == 2. */
  errorCode?: number;
  rawData: Hex;
}

/** Tx status (0x0000) — the ONE query that keeps the (uint8, bytes) envelope. */
export async function readLighterTxStatus(
  chainId: number,
  reqId: bigint | number,
): Promise<LighterTxStatus | null> {
  if (chainId !== LIGHTER_CHAIN_ID) return null;
  try {
    const raw = await callReadCore(chainId, packQuery(LIGHTER_QUERIES.txStatus, hexUint64(reqId)));
    const [status, inner] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes" }],
      raw,
    ) as unknown as readonly [number, Hex];
    const result: LighterTxStatus = { status, rawData: inner };
    if (status === LIGHTER_TX_STATUS.failed && inner && inner.length >= 10) {
      const [errorCode] = decodeAbiParameters([{ type: "uint32" }], inner) as unknown as readonly [number];
      result.errorCode = errorCode;
    }
    return result;
  } catch {
    return null;
  }
}

/** EVM account index (0x0009, 22 bytes in). Null when the account is absent or the read fails. */
export async function getLighterAccountIndex(
  chainId: number,
  vaultAddress: Address,
): Promise<bigint | null> {
  if (chainId !== LIGHTER_CHAIN_ID) return null;
  try {
    const raw = await callReadCore(chainId, packQuery(LIGHTER_QUERIES.evmAccountIndex, hexAddress(vaultAddress)));
    const data = unwrapFoundData(raw);
    if (data === null || !hasExactWords(data, 1)) return null;
    const [accountIndex] = decodeAbiParameters([{ type: "uint48" }], data) as unknown as readonly [number];
    return BigInt(accountIndex);
  } catch {
    return null;
  }
}

// ── Core account activation (prompt-only gating) ──────────────────────

const ACTIVATION_TTL_MS = 5 * 60 * 1000;
const activationCache = new Map<string, { at: number; activated: boolean }>();

/** True when the failure is READ_CORE's own "no such account" signal, not a transport error. */
function isReadCoreMissingAccountError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ""}` : String(err);
  return /READ_CORE|query failed|PrecompileError/i.test(message);
}

/**
 * Whether the vault has a Lighter Core account (created automatically by the
 * first deposit — there is no separate activation step). Cached per vault for
 * ACTIVATION_TTL_MS so a session pays for at most one read.
 *
 * Returns false when READ_CORE reports the account missing, and null when the
 * read itself fails (node hiccup) — callers must treat null as "unknown, don't
 * prompt", never as "not activated" (mirrors getHyperliquidAccountActivation).
 */
export async function getLighterAccountActivation(
  chainId: number,
  vaultAddress: Address,
): Promise<boolean | null> {
  const key = vaultAddress.toLowerCase();
  const hit = activationCache.get(key);
  if (hit && Date.now() - hit.at < ACTIVATION_TTL_MS) return hit.activated;

  // Devnet 1.1.0: a missing account returns found=false with SUCCESS — the
  // envelope itself discriminates "absent" from "read failure". A thrown
  // READ_CORE application error is still the precompile's legacy "no such
  // account" signal → false; a transport/RPC failure → null ("unknown", never
  // prompt).
  let activated: boolean | null;
  try {
    const raw = await callReadCore(
      chainId,
      packQuery(LIGHTER_QUERIES.accountInfo, hexAddress(vaultAddress), hexBool(false)),
    );
    activated = unwrapFoundData(raw) !== null;
  } catch (err) {
    activated = isReadCoreMissingAccountError(err) ? false : null;
  }

  if (activated !== null) activationCache.set(key, { at: Date.now(), activated });
  return activated;
}

/** Record a freshly created account (lighter_deposit auto-creates it on first deposit). */
export function markLighterAccountActivated(vaultAddress: Address): void {
  activationCache.set(vaultAddress.toLowerCase(), { at: Date.now(), activated: true });
}

// ── Tracked markets (on-chain view — the single source) ───────────────

export interface TrackedMarket {
  marketId: number;
  sizeDecimals: number;
  priceDecimals: number;
}

export interface LighterTrackedMarketsView {
  markets: TrackedMarket[];
  /** NAV-relevant in-flight amount (6-dec USDC), as tracked by the contract. */
  inFlightAmount: bigint;
  lastActionTimestamp: bigint;
  lastReqId: bigint;
}

/**
 * The pool's getLighterTrackedMarkets() view (0x5239dd83, EApps/EAppsLighter):
 * the markets the pool tracks, WITH the size/price decimals the adapter's
 * LighterConstants table resolved at track time. This is the operator's only
 * source for both — no KV ledger, no Core API, no user input — so the
 * operator can never disagree with the contract that prices the pool's NAV.
 * Null when the read fails or the pool runs an implementation without the
 * view (never throws).
 */
export async function readLighterTrackedMarkets(
  chainId: number,
  vaultAddress: Address,
): Promise<LighterTrackedMarketsView | null> {
  if (chainId !== LIGHTER_CHAIN_ID) return null;
  try {
    const client = getRpcProvider(chainId);
    const { data: raw } = await client.call({
      to: vaultAddress,
      data: LIGHTER_VIEW_TRACKED_MARKETS,
      blockTag: "latest",
    });
    if (!raw || raw === "0x") return null;
    const [view] = decodeAbiParameters(
      [...LIGHTER_VIEW_DATA_OUT],
      raw as Hex,
    ) as unknown as readonly [{
      marketIds: number[];
      sizeDecimals: number[];
      priceDecimals: number[];
      inFlightAmount: bigint;
      lastActionTimestamp: bigint;
      lastReqId: bigint;
    }];
    if (!Array.isArray(view.marketIds) || !Array.isArray(view.sizeDecimals) || !Array.isArray(view.priceDecimals)) {
      return null;
    }
    const markets: TrackedMarket[] = view.marketIds
      .filter((id) => Number.isInteger(id) && id >= 0 && id < 65536)
      .map((id, i) => ({
        marketId: id,
        sizeDecimals: view.sizeDecimals[i] ?? 0,
        priceDecimals: view.priceDecimals[i] ?? 0,
      }));
    return {
      markets,
      inFlightAmount: BigInt(view.inFlightAmount),
      lastActionTimestamp: BigInt(view.lastActionTimestamp),
      lastReqId: BigInt(view.lastReqId),
    };
  } catch {
    return null;
  }
}

/** The vault's tracked markets from the on-chain view ([] when unreadable). */
export async function getLighterTrackedMarkets(
  chainId: number,
  vaultAddress: Address,
): Promise<TrackedMarket[]> {
  const view = await readLighterTrackedMarkets(chainId, vaultAddress);
  return view?.markets ?? [];
}

// ── Portfolio valuation (mirrors LighterLib._positionValueUsdc exactly) ──

export interface LighterPortfolioPosition {
  marketId: number;
  /** Signed size on the market's sizeDecimals scale. */
  size: bigint;
  sizeHuman: string;
  /** Entry notional in 6-dec USDC. */
  entryQuote: bigint;
  markPrice: bigint;
  /** Unrealized PnL (mark value − entry notional), 6-dec USDC (signed). */
  pnl: bigint;
  /** Margin mode: 1 = isolated. */
  marginMode: number;
  /** Isolated margin allocated outside shared collateral, 6-dec USDC (Devnet 1.1.0). */
  allocatedMargin: bigint;
  /** NAV contribution: pnl + isolated-margin add-back, 6-dec USDC (signed). */
  value: bigint;
}

export interface LighterPortfolio {
  vaultAddress: Address;
  /** false = no Core account (nothing deposited yet). */
  accountExists: boolean;
  /** Shared USDC margin in 6-dec USDC; 0 when the account read failed or is absent. */
  collateralBase: bigint;
  positions: LighterPortfolioPosition[];
  /** collateralBase + Σ position values, 6-dec USDC. */
  totalValue: bigint;
  formattedReport: string;
}

/** 10^n as bigint. */
function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Values the vault's Lighter Core account: shared collateral plus, per tracked
 * market with a nonzero position, the mark-to-market value
 *
 *   markValue  = position × markPrice × 1e6 / 10^(sizeDecimals + priceDecimals)   (signed)
 *   entryValue = position > 0 ? entryQuote : −entryQuote
 *   value      = markValue − entryValue  (+ allocatedMargin when isolated)
 *
 * (LighterLib._positionValueUsdc, minus the in-flight adjustment — the operator
 * has no on-chain NAV to keep consistent and surfaces reqId status separately.
 * Devnet 1.1.0: allocatedMargin is already 6-dec USDC, no conversion.)
 * Read failures degrade to what is known; they never throw.
 */
export async function getLighterPortfolio(
  chainId: number,
  vaultAddress: Address,
  trackedMarkets: TrackedMarket[],
): Promise<LighterPortfolio> {
  const account = await readLighterAccount(chainId, vaultAddress).catch(() => null);
  const collateralBase = account?.collateralBaseAmount ?? 0n;

  const positions: LighterPortfolioPosition[] = [];
  let totalValue = collateralBase;

  for (const market of trackedMarkets) {
    const [position, marketInfo] = await Promise.all([
      readLighterPosition(chainId, vaultAddress, market.marketId).catch(() => null),
      readLighterMarketInfo(chainId, market.marketId).catch(() => null),
    ]);
    if (!position || position.position === 0n || !marketInfo) continue;

    const scale = pow10(market.sizeDecimals + market.priceDecimals);
    const markValue = (position.position * marketInfo.markPrice * 1_000_000n) / scale;
    const entryValue = position.position > 0n ? position.entryQuote : -position.entryQuote;
    const pnl = markValue - entryValue;
    let value = pnl;
    if (position.marginMode === LIGHTER_MARGIN_MODE_ISOLATED) {
      // Devnet 1.1.0: allocatedMargin is already 6-dec USDC.
      value += position.allocatedMargin;
    }

    positions.push({
      marketId: market.marketId,
      size: position.position,
      sizeHuman: formatHuman(position.position, market.sizeDecimals),
      entryQuote: position.entryQuote,
      markPrice: marketInfo.markPrice,
      pnl,
      marginMode: position.marginMode,
      allocatedMargin: position.allocatedMargin,
      value,
    });
    totalValue += value;
  }

  const portfolio: LighterPortfolio = {
    vaultAddress,
    accountExists: account !== null,
    collateralBase,
    positions,
    totalValue,
    formattedReport: "",
  };
  portfolio.formattedReport = formatLighterReport(portfolio, trackedMarkets);
  return portfolio;
}

export interface LighterOpenOrderCounts {
  marketId: number;
  /** Currently open (resting) orders of the account on this market. */
  totalOrderCount: bigint;
  /** SL/TP conditional orders tied to a position's lifecycle (0 without a position). */
  totalPositionTiedOrderCount: bigint;
}

/**
 * Per tracked market, the open-order counts Core exposes on-chain (the
 * position read's totalOrderCount / totalPositionTiedOrderCount). READ_CORE
 * has NO order-listing query — individual order prices/sizes exist only on
 * the Core REST API, which the operator deliberately does not use — so this
 * is the deterministic on-chain answer to "are my orders still open?".
 * Markets whose read fails are skipped, never thrown.
 */
export async function getLighterOpenOrderCounts(
  chainId: number,
  vaultAddress: Address,
  trackedMarkets: TrackedMarket[],
): Promise<LighterOpenOrderCounts[]> {
  const out: LighterOpenOrderCounts[] = [];
  for (const market of trackedMarkets) {
    const position = await readLighterPosition(chainId, vaultAddress, market.marketId).catch(() => null);
    if (!position) continue;
    out.push({
      marketId: market.marketId,
      totalOrderCount: position.totalOrderCount,
      totalPositionTiedOrderCount: position.totalPositionTiedOrderCount,
    });
  }
  return out;
}

function formatHuman(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = pow10(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function fmtUsdUnits(value6dec: bigint): string {
  const n = Number(value6dec) / 1e6;
  if (!Number.isFinite(n)) return "$0.00";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

function fmtSignedUsdUnits(value6dec: bigint): string {
  return `${value6dec >= 0n ? "+" : ""}${fmtUsdUnits(value6dec)}`;
}

function formatLighterReport(p: LighterPortfolio, trackedMarkets: TrackedMarket[]): string {
  const lines: string[] = [];
  lines.push("📊 Lighter Core Account (Lighter Devnet)");
  lines.push("");
  lines.push(
    `Core account: ${p.accountExists ? "active" : "not created"}   |   Collateral: ${fmtUsdUnits(p.collateralBase)}   |   Total value: ${fmtUsdUnits(p.totalValue)}`,
  );
  lines.push("");
  lines.push("Prices are mark prices read from Lighter Core state; sizes use each market's tracked decimals. Entry is derived from the entry notional recorded by Core.");
  lines.push("");

  if (p.positions.length > 0) {
    lines.push(`| Market | Side | Size | Entry | Mark | uPnL | Margin |`);
    lines.push(`|--------|------|------|-------|------|------|--------|`);
    for (const pos of p.positions) {
      const market = trackedMarkets.find((m) => m.marketId === pos.marketId);
      const sizeDecimals = market?.sizeDecimals ?? 6;
      const priceDecimals = market?.priceDecimals ?? 2;
      const symbol = LIGHTER_MARKET_SYMBOLS[pos.marketId];
      // entryQuote = |size| × entryPrice × 1e6 / 10^(sizeDecimals + priceDecimals)
      // (LighterLib._positionValueUsdc), inverted to a price on priceDecimals.
      const absSize = pos.size < 0n ? -pos.size : pos.size;
      const entryPrice = absSize > 0n
        ? (pos.entryQuote * pow10(sizeDecimals + priceDecimals)) / (absSize * 1_000_000n)
        : 0n;
      // Devnet 1.1.0: allocatedMargin is already 6-dec USDC.
      const margin = pos.marginMode === LIGHTER_MARGIN_MODE_ISOLATED
        ? `isolated (${fmtUsdUnits(pos.allocatedMargin)})`
        : "—";
      lines.push(
        `| ${symbol ? `${symbol} (${pos.marketId})` : pos.marketId} | ${pos.size > 0n ? "LONG" : "SHORT"} | ${formatHuman(pos.size, sizeDecimals)} | ${formatHuman(entryPrice, priceDecimals)} | ${formatHuman(pos.markPrice, priceDecimals)} | ${fmtSignedUsdUnits(pos.pnl)} | ${margin} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("No open Lighter positions on tracked markets.");
    lines.push("");
  }
  return lines.join("\n");
}
