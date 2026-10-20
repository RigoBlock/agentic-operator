/**
 * Lighter Core account reads — the READ_CORE precompile on Lighter EVM devnet (19529).
 *
 * Every Lighter Core STATE read goes through the READ_CORE precompile
 * (0x6600…0000) via eth_call on LIGHTER_RPC_URL. Inputs are abi.encodePacked(uint16
 * queryId, args) WITHOUT a function selector; the current devnet build returns RAW
 * abi.encode payloads WITHOUT the documented (bool found, bytes) envelope for every
 * query except tx status (0x0000). Live-verified encodings, 2026-10-20 — see
 * docs/lighter-integration.md.
 *
 * The ONE exception is order-book decimals: per the Lighter docs, the READ_CORE
 * market-info read explicitly does NOT return sizeDecimals/priceDecimals — the
 * Core REST API (GET /v1/orderBookDetails) is the only machine-readable source
 * (fetchLighterMarketDecimals below).
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
} from "../abi/lighter.js";
import { getRpcProvider } from "./rpcClient.js";
import type { Env } from "../types.js";

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
  lastFundingRatePrefixSum: bigint;
  /** Signed size on the market's sizeDecimals scale (createOrder amount units). */
  position: bigint;
  /** Unsigned entry NOTIONAL in 6-dec USDC (not a price). */
  entryQuote: bigint;
  initialMarginFraction: number;
  totalOrderCount: bigint;
  totalPositionTiedOrderCount: bigint;
  /** 0 = cross, 1 = isolated. */
  marginMode: number;
  /** Isolated margin in 12-dec USDC (divide by 1e6 for 6-dec). */
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

// Rigoblock LighterTypes layout: leading int64 lastFundingRatePrefixSum
// (matches the 2026-10-19 docs revision; public-docs-first-field-is-position
// decoders would mis-shift every field).
const POSITION_OUT = [
  { type: "int64" }, { type: "int64" }, { type: "uint56" }, { type: "uint16" },
  { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "int128" },
] as const;

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
 * Account info (0x0001, 23 bytes in). The call ERRORS ("READ_CORE query
 * failed") when the account does not exist — treated as "no account" (null),
 * mirroring LighterLib.coreAccountExists.
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
    const [accountType, accountIndex, masterAccountIndex, l1Address, evmAddress, collateralBaseAmount] =
      decodeAbiParameters([...ACCOUNT_INFO_OUT], raw) as unknown as readonly [number, number, number, Address, Address, bigint];
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
    const [marketType, baseAssetId, quoteAssetId, takerFee, makerFee, minBaseAmount, minQuoteAmount, liquidationFee, indexPrice, markPrice] =
      decodeAbiParameters([...MARKET_INFO_OUT], raw) as unknown as readonly [number, number, number, number, number, bigint, bigint, number, bigint, bigint];
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
    const [lastFundingRatePrefixSum, position, entryQuote, initialMarginFraction, totalOrderCount, totalPositionTiedOrderCount, marginMode, allocatedMargin] =
      decodeAbiParameters([...POSITION_OUT], raw) as unknown as readonly [bigint, bigint, number, number, bigint, bigint, number, bigint];
    return {
      lastFundingRatePrefixSum,
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
    const [accountIndex] = decodeAbiParameters([{ type: "uint48" }], raw) as unknown as readonly [number];
    return BigInt(accountIndex);
  } catch {
    return null;
  }
}

// ── Order-book decimals (the ONE value READ_CORE does not return) ─────

export interface LighterMarketDecimals {
  sizeDecimals: number;
  priceDecimals: number;
}

/**
 * Per-market decimals verified out-of-band and pinned in code. THIS TABLE IS
 * THE ONLY DECIMALS SOURCE THAT WORKS WITHOUT THE CORE API. Entries must come
 * with provenance (who confirmed, when, and the orderBookDetails output they
 * were taken from) — a wrong value distorts NAV math by orders of magnitude,
 * so nothing is ever guessed or accepted from user input.
 *
 * Lighter docs: "READ_CORE does not return the decimals; read them from
 * GET /api/v1/orderBookDetails", and ecosystem docs warn decimals are
 * per-market AND can change — never assume one market's scale fits another.
 */
export const VERIFIED_LIGHTER_MARKET_DECIMALS: Record<number, LighterMarketDecimals> = {
  // Devnet perps 0..3 (ETH/BTC/SOL/DOGE): on-chain mark prices are observed at
  // 1e2 scale (raw ~238800 → $2,388.00), consistent with priceDecimals = 2 —
  // but sizeDecimals is NOT derivable on-chain and remains UNVERIFIED until
  // confirmed from GET /api/v1/orderBookDetails?market_id=N (Lighter team).
  // Intentionally empty until then: resolveLighterMarketDecimals fails closed.
};

/**
 * sizeDecimals/priceDecimals for a market from the Lighter Core REST API
 * (GET {LIGHTER_CORE_API_URL}/v1/orderBookDetails?market_id=<id>).
 *
 * Lighter's docs state explicitly that the READ_CORE market-info read does NOT
 * return decimals — the Core API is the only machine-readable source. Returns
 * null when the API URL is not configured, the request fails, or the response
 * does not match the documented order_book_details shape; callers then fall
 * back to the verified constants table or fail closed.
 */
export async function fetchLighterMarketDecimals(
  env: Pick<Env, "LIGHTER_CORE_API_URL">,
  marketId: number,
): Promise<LighterMarketDecimals | null> {
  const base = env.LIGHTER_CORE_API_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/v1/orderBookDetails?market_id=${marketId}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      order_book_details?: {
        market_id?: unknown;
        supported_size_decimals?: unknown;
        supported_price_decimals?: unknown;
      }[];
    } | null;
    const entry = json?.order_book_details?.find((b) => Number(b?.market_id) === marketId)
      ?? json?.order_book_details?.[0];
    const { supported_size_decimals: size, supported_price_decimals: price } = entry ?? {};
    if (
      Number.isInteger(size) && (size as number) >= 0 && (size as number) <= 18 &&
      Number.isInteger(price) && (price as number) >= 0 && (price as number) <= 16
    ) {
      return { sizeDecimals: size as number, priceDecimals: price as number };
    }
    return null;
  } catch {
    return null;
  }
}

const decimalsApiCache = new Map<number, { at: number; value: LighterMarketDecimals }>();
const DECIMALS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Deterministic decimals for a market — NEVER user input (rogue decimals
 * distort the pool's on-chain NAV by orders of magnitude, hitting every pool
 * token holder). Sources, in trust order:
 *   1. VERIFIED_LIGHTER_MARKET_DECIMALS (pinned, provenance-documented),
 *   2. the Lighter Core API orderBookDetails (Lighter's canonical source —
 *      the same data the protocol team uses to build the constants table),
 * Then fails closed with an actionable error. There is deliberately no
 * free-input path.
 */
export async function resolveLighterMarketDecimals(
  env: Pick<Env, "LIGHTER_CORE_API_URL">,
  marketId: number,
): Promise<LighterMarketDecimals> {
  const verified = VERIFIED_LIGHTER_MARKET_DECIMALS[marketId];
  if (verified) return verified;

  const hit = decimalsApiCache.get(marketId);
  if (hit && Date.now() - hit.at < DECIMALS_CACHE_TTL_MS) return hit.value;

  const fromApi = await fetchLighterMarketDecimals(env, marketId);
  if (fromApi) {
    decimalsApiCache.set(marketId, { at: Date.now(), value: fromApi });
    return fromApi;
  }

  throw new Error(
    `Lighter market ${marketId}: size/price decimals are not readable on-chain — Lighter's READ_CORE ` +
    `market-info read explicitly does not return them (see the Lighter docs). No verified value is pinned ` +
    `in code and LIGHTER_CORE_API_URL is not configured or did not answer, so tracking this market is blocked. ` +
    `Get the values from GET {core-api}/api/v1/orderBookDetails?market_id=${marketId} (fields ` +
    `supported_size_decimals / supported_price_decimals, from the Lighter team) and either pin them in ` +
    `VERIFIED_LIGHTER_MARKET_DECIMALS in src/services/lighter.ts or configure LIGHTER_CORE_API_URL.`,
  );
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

  const info = await readLighterAccount(chainId, vaultAddress);
  if (info !== null) {
    activationCache.set(key, { at: Date.now(), activated: true });
    return true;
  }

  // Classify the failure: a READ_CORE application error ("READ_CORE query
  // failed") is the precompile's "no such account" signal → false; a
  // transport/RPC failure → null ("unknown", never prompt).
  let activated: boolean | null = null;
  try {
    await callReadCore(
      chainId,
      packQuery(LIGHTER_QUERIES.accountInfo, hexAddress(vaultAddress), hexBool(false)),
    );
    activated = true;
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

// ── Tracked-markets store (KV ledger) ─────────────────────────────────
//
// The on-chain pool view getLighterTrackedMarkets (0x5239dd83) is BROKEN on the
// current devnet deployment (the pool impl's READ_CORE queries don't match the
// devnet build — verified 2026-10-20), so the operator keeps its own ledger in
// KV, keyed by vault. track/untrack tools update it after a successful on-chain
// write; the order builder enforces market-tracked against this ledger.

export interface TrackedMarket {
  marketId: number;
  sizeDecimals: number;
  priceDecimals: number;
}

const TRACKED_MARKETS_PREFIX = "lighter:markets:";

function trackedMarketsKey(vaultAddress: Address): string {
  return `${TRACKED_MARKETS_PREFIX}${vaultAddress.toLowerCase()}`;
}

/** The vault's tracked markets from the KV ledger. Missing/corrupt entries read as []. */
export async function getLighterTrackedMarkets(
  kv: KVNamespace,
  vaultAddress: Address,
): Promise<TrackedMarket[]> {
  const raw = await kv.get(trackedMarketsKey(vaultAddress));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TrackedMarket[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m) =>
        Number.isInteger(m.marketId) &&
        m.marketId >= 0 &&
        m.marketId < 65536 &&
        Number.isInteger(m.sizeDecimals) &&
        Number.isInteger(m.priceDecimals),
    );
  } catch {
    return [];
  }
}

/** Add a market to the vault's ledger (no-op when already tracked). */
export async function addLighterTrackedMarket(
  kv: KVNamespace,
  vaultAddress: Address,
  market: TrackedMarket,
): Promise<TrackedMarket[]> {
  const list = await getLighterTrackedMarkets(kv, vaultAddress);
  if (list.some((m) => m.marketId === market.marketId)) return list;
  const next = [...list, market];
  await kv.put(trackedMarketsKey(vaultAddress), JSON.stringify(next));
  return next;
}

/** Remove a market from the vault's ledger. */
export async function removeLighterTrackedMarket(
  kv: KVNamespace,
  vaultAddress: Address,
  marketId: number,
): Promise<TrackedMarket[]> {
  const list = await getLighterTrackedMarkets(kv, vaultAddress);
  const next = list.filter((m) => m.marketId !== marketId);
  if (next.length !== list.length) {
    await kv.put(trackedMarketsKey(vaultAddress), JSON.stringify(next));
  }
  return next;
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
  /** Unrealized PnL + (isolated) margin add-back, 6-dec USDC (signed). */
  value: bigint;
  marginMode: number;
  allocatedMargin: bigint;
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
 *   value      = markValue − entryValue  (+ allocatedMargin / 1e6 when isolated)
 *
 * (LighterLib._positionValueUsdc, minus the in-flight adjustment — the operator
 * has no on-chain NAV to keep consistent and surfaces reqId status separately.)
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
    let value = markValue - entryValue;
    if (position.marginMode === LIGHTER_MARGIN_MODE_ISOLATED) {
      // 12-dec isolated margin → 6-dec USDC.
      value += position.allocatedMargin / 1_000_000n;
    }

    positions.push({
      marketId: market.marketId,
      size: position.position,
      sizeHuman: formatHuman(position.position, market.sizeDecimals),
      entryQuote: position.entryQuote,
      markPrice: marketInfo.markPrice,
      value,
      marginMode: position.marginMode,
      allocatedMargin: position.allocatedMargin,
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
  lines.push("Prices are mark prices read from Lighter Core state; sizes use each market's tracked decimals.");
  lines.push("");

  if (p.positions.length > 0) {
    lines.push(`| Market | Side | Size | Value (PnL + iso margin) | Margin |`);
    lines.push(`|--------|------|------|--------------------------|--------|`);
    for (const pos of p.positions) {
      const decimals = trackedMarkets.find((m) => m.marketId === pos.marketId)?.sizeDecimals ?? 6;
      lines.push(
        `| ${pos.marketId} | ${pos.size > 0n ? "LONG" : "SHORT"} | ${formatHuman(pos.size, decimals)} | ${fmtSignedUsdUnits(pos.value)} | ${pos.marginMode === LIGHTER_MARGIN_MODE_ISOLATED ? `isolated (${fmtUsdUnits(pos.allocatedMargin / 1_000_000n)})` : "cross"} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("No open Lighter positions on tracked markets.");
    lines.push("");
  }
  return lines.join("\n");
}
