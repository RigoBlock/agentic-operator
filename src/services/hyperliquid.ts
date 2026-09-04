/**
 * Hyperliquid account reads — HyperEVM read precompiles + Hyperliquid Core info API.
 *
 * Two complementary read paths, per the protocol design:
 *
 * 1. HyperEVM read precompiles (on-chain, used for NAV-critical values):
 *    - accountMarginSummary(0, vault) → perp account value / notional / margin (USDC, 6 decimals)
 *    - spotBalance(vault, USDC)       → Core spot USDC balance (8 decimals, "core wei")
 *    - coreUserExists(vault)          → whether the Core account is activated
 *
 * 2. Hyperliquid Core info API (https://api.hyperliquid.xyz/info) — the ONLY source
 *    for per-position state (entry/mark/liq prices, declared leverage, unrealized PnL,
 *    open orders). Core perp account internals are not exposed on HyperEVM precompiles.
 *
 * Decimal conventions (see src/abi/hyperliquid.ts header):
 *   perp account USDC = 6 decimals; Core spot USDC = 8 decimals; prices = 8-decimal fixed point.
 */

import { decodeAbiParameters, encodeAbiParameters, formatUnits, parseUnits, type Address } from "viem";
import {
  HYPEREVM_CHAIN_ID,
  HYPEREVM_USDC,
  HL_USDC_TOKEN_INDEX,
  HL_DEFAULT_PERP_DEX,
  HL_CORE_SPOT_ASSET_BASE,
  HL_PRECOMPILES,
  HL_INFO_API_URL,
} from "../abi/hyperliquid.js";
import { getRpcProvider } from "./rpcClient.js";

// ── Hyperliquid Core info API ─────────────────────────────────────────

export async function hlInfoApi<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_INFO_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as T & { status?: string };
  if (data && data.status === "err") {
    throw new Error(`Hyperliquid API error: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

export interface HlPerpAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface HlMeta {
  universe: HlPerpAsset[];
}

let metaCache: { at: number; meta: HlMeta } | null = null;
const META_TTL_MS = 5 * 60 * 1000;

/** Perp market metadata (universe). Cached 5 minutes. */
export async function getHyperliquidMeta(): Promise<HlMeta> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.meta;
  const meta = await hlInfoApi<HlMeta>({ type: "meta" });
  metaCache = { at: Date.now(), meta };
  return meta;
}

/** Resolve a coin symbol ("BTC", "ETH") to its Core perp asset index. Throws if unknown or not a core perp. */
export async function resolveHlAssetIndex(coin: string): Promise<number> {
  const meta = await getHyperliquidMeta();
  const wanted = coin.toUpperCase();
  const idx = meta.universe.findIndex((u) => u.name.toUpperCase() === wanted);
  if (idx === -1) {
    throw new Error(
      `Unknown Hyperliquid perp market: "${coin}". Available: ${meta.universe
        .slice(0, 30)
        .map((u) => u.name)
        .join(", ")}${meta.universe.length > 30 ? ", …" : ""}`,
    );
  }
  if (idx >= HL_CORE_SPOT_ASSET_BASE) {
    throw new Error(`"${coin}" is not a core perp asset (assetId ${idx} ≥ ${HL_CORE_SPOT_ASSET_BASE}).`);
  }
  return idx;
}

/** Current mid prices keyed by coin (e.g. { BTC: "67234.5", ... }). */
export async function getHyperliquidMids(): Promise<Record<string, string>> {
  return hlInfoApi<Record<string, string>>({ type: "allMids" });
}

/** Top-of-book quote (level 1) for a perp market, from the Core order book. */
export async function getHyperliquidQuote(coin: string): Promise<{ bid: number; ask: number }> {
  const res = await hlInfoApi<{
    levels: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>];
  }>({ type: "l2Book", coin });
  const bid = parseFloat(res.levels[0][0]?.px ?? "");
  const ask = parseFloat(res.levels[1][0]?.px ?? "");
  return { bid, ask };
}

// ── HyperEVM precompile reads ─────────────────────────────────────────

export interface HlPrecompileBalances {
  /** Perp account value (USDC, 6 decimals). Negative values possible in extremis. */
  perpAccountValue: bigint;
  perpNtlPos: bigint;
  perpMarginUsed: bigint;
  perpRawUsd: bigint;
  /** Core spot USDC balance (8 decimals, "core wei"). */
  spotUsdcWei: bigint;
  spotUsdcHoldWei: bigint;
  /** Whether the vault has an activated HyperCore account. */
  activated: boolean;
}

/**
 * HyperEVM read precompiles take raw abi.encode(args) input — WITHOUT the
 * 4-byte function selector a normal contract call prepends. Sending a selector
 * makes the precompile revert with PrecompileError, which is why selector-based
 * `simulateContract` reads always degraded to zero/false here.
 * See: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore
 */
const HL_PRECOMPILE_PARAMS = {
  marginSummary: {
    in: [{ type: "uint32" }, { type: "address" }] as const,
    out: [{ type: "int64" }, { type: "uint64" }, { type: "uint64" }, { type: "int64" }] as const,
  },
  spotBalance: {
    in: [{ type: "address" }, { type: "uint64" }] as const,
    out: [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }] as const,
  },
  coreUserExists: {
    in: [{ type: "address" }] as const,
    out: [{ type: "bool" }] as const,
  },
} as const;

async function callReadPrecompile(
  to: Address,
  params: { in: readonly { type: string }[]; out: readonly { type: string }[] },
  args: readonly unknown[],
): Promise<readonly unknown[]> {
  const client = getRpcProvider(HYPEREVM_CHAIN_ID);
  const data = encodeAbiParameters([...params.in], [...args] as never);
  const { data: returnData } = await client.call({ to, data });
  return decodeAbiParameters([...params.out], returnData ?? "0x");
}

/** Read the on-chain HyperEVM precompiles. Failing reads degrade to zero instead of throwing. */
export async function getHyperliquidPrecompileBalances(vaultAddress: Address): Promise<HlPrecompileBalances> {
  const zero: HlPrecompileBalances = {
    perpAccountValue: 0n,
    perpNtlPos: 0n,
    perpMarginUsed: 0n,
    perpRawUsd: 0n,
    spotUsdcWei: 0n,
    spotUsdcHoldWei: 0n,
    activated: false,
  };

  const [summary, spot, exists] = await Promise.all([
    callReadPrecompile(HL_PRECOMPILES.accountMarginSummary, HL_PRECOMPILE_PARAMS.marginSummary, [HL_DEFAULT_PERP_DEX, vaultAddress])
      .then((r) => r as [bigint, bigint, bigint, bigint])
      .catch(() => [0n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint]),
    // The spotBalance precompile reverts (PrecompileError) for accounts with no
    // spot entry, so fall back to the Core info API for the same USDC value.
    callReadPrecompile(HL_PRECOMPILES.spotBalance, HL_PRECOMPILE_PARAMS.spotBalance, [vaultAddress, HL_USDC_TOKEN_INDEX])
      .then((r) => r as [bigint, bigint, bigint])
      .catch(async () => {
        const spotState = await fetchSpotClearinghouseState(vaultAddress).catch(() => null);
        const usdc = spotState?.balances.find((b) => b.token === Number(HL_USDC_TOKEN_INDEX));
        return [usdc ? parseUnits(usdc.total, 8) : 0n, usdc ? parseUnits(usdc.hold, 8) : 0n, 0n] as [bigint, bigint, bigint];
      }),
    callReadPrecompile(HL_PRECOMPILES.coreUserExists, HL_PRECOMPILE_PARAMS.coreUserExists, [vaultAddress])
      .then((r) => r[0] as boolean)
      .catch(() => false),
  ]);

  return {
    perpAccountValue: summary[0],
    perpMarginUsed: summary[1],
    perpNtlPos: summary[2],
    perpRawUsd: summary[3],
    spotUsdcWei: spot[0],
    spotUsdcHoldWei: spot[1],
    activated: exists,
  };
}

// ── Core info API account state ───────────────────────────────────────

export interface HlApiPosition {
  coin: string;
  /** Signed size in base units (negative = short). */
  szi: string;
  entryPx?: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage: { type: string; value: number };
  liquidationPx?: string | null;
  marginUsed: string;
  maxLeverage: number;
  cumFunding?: { allTime?: string; sinceOpen?: string; sinceChange?: string };
}

export interface HlApiMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HlClearinghouseState {
  marginSummary: HlApiMarginSummary;
  withdrawable: string;
  assetPositions: Array<{ position: HlApiPosition; type: string }>;
  time: number;
}

export interface HlSpotBalanceEntry {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}

export interface HlOpenOrder {
  coin: string;
  side: "B" | "A";
  sz: string;
  limitPx: string;
  oid: number;
  cloid?: string | null;
  tif?: string;
  reduceOnly?: boolean;
  isPositionTaker?: boolean;
  orderType?: string;
  origSz?: string;
  timestamp?: number;
}

export function fetchClearinghouseState(user: Address): Promise<HlClearinghouseState> {
  return hlInfoApi<HlClearinghouseState>({ type: "clearinghouseState", user });
}

export function fetchSpotClearinghouseState(user: Address): Promise<{ balances: HlSpotBalanceEntry[] }> {
  return hlInfoApi<{ balances: HlSpotBalanceEntry[] }>({ type: "spotClearinghouseState", user });
}

export function fetchOpenOrders(user: Address): Promise<HlOpenOrder[]> {
  return hlInfoApi<HlOpenOrder[]>({ type: "openOrders", user });
}

/** One executed trade from the Core userFills API (prices/sizes as float strings). */
export interface HlUserFill {
  coin: string;
  /** "B" = buy, "A" = sell (taker side). */
  side: "B" | "A";
  /** Fill price (human readable). */
  px: string;
  /** Filled size in base asset (human readable). */
  sz: string;
  /** Fill time, milliseconds since epoch. */
  time: number;
  /** e.g. "Open Long", "Close Short", "Open Short", "Close Long", "Fee". */
  dir: string;
  /** Realized PnL on closing fills. */
  closedPnl: string;
  oid: number;
  /** Taker fill crossed the spread. */
  crossed: boolean;
  fee: string;
}

/** Recent fills for a Core account (newest first, exchange-limited window). */
export function fetchUserFills(user: Address): Promise<HlUserFill[]> {
  return hlInfoApi<HlUserFill[]>({ type: "userFills", user });
}

// ── Normalized account summary ────────────────────────────────────────

export interface HyperliquidPosition {
  coin: string;
  assetIndex: number;
  isLong: boolean;
  /** Signed and absolute sizes in base units, trimmed. */
  sizeToken: string;
  absSizeToken: number;
  /** Position notional in USD. */
  sizeUsd: string;
  positionValue: number;
  entryPx: string;
  markPx: string;
  liquidationPx: string | null;
  unrealizedPnl: string;
  unrealizedPnlPercent: string;
  /** Declared leverage at open (e.g. "3x"). Global account leverage is in the summary. */
  leverage: string;
  leverageType: string;
  marginUsedUsd: string;
  maxLeverage: number;
  fundingSinceOpen: string;
}

export interface HyperliquidOpenOrder {
  coin: string;
  assetIndex: number;
  side: "long" | "short";
  sizeToken: string;
  price: string;
  oid: number;
  cloid: string | null;
  tif: string;
  reduceOnly: boolean;
  orderType: string;
  timestamp: number;
}

export interface HyperliquidAccountSummary {
  vaultAddress: Address;
  activated: boolean;
  /** Perp account value (USDC, 6 decimals) — from the HyperEVM precompile (NAV-critical read). */
  perpAccountValueUsd: string;
  /** Total open notional (USDC, 6 decimals) — from the precompile. */
  perpNtlPosUsd: string;
  perpMarginUsedUsd: string;
  withdrawableUsd: string;
  /** Core spot USDC balance scaled from 8-decimal core wei to 6-decimal USD. */
  spotUsdcUsd: string;
  /** Total account value = perp account value + spot USDC. */
  totalAccountValueUsd: string;
  /** Global leverage = total open notional / perp account value. */
  globalLeverage: string | null;
  positions: HyperliquidPosition[];
  openOrders: HyperliquidOpenOrder[];
  formattedReport: string;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

function fmtSignedUsd(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmtUsd(n)}`;
}

function fmtPx(px: number): string {
  if (!Number.isFinite(px) || px <= 0) return "—";
  const digits = px >= 1000 ? 1 : px >= 100 ? 2 : px >= 1 ? 3 : 5;
  return `$${px.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
}

function trimNum(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** Normalize one clearinghouseState assetPosition entry. Exported for tests. */
export function normalizeHlPosition(
  raw: HlApiPosition,
  assetIndex: number,
  szDecimals: number,
): HyperliquidPosition {
  const szi = parseFloat(raw.szi) || 0;
  const isLong = szi >= 0;
  const positionValue = parseFloat(raw.positionValue) || 0;
  const absSize = Math.abs(szi);
  const markPx = absSize > 0 ? positionValue / absSize : 0;
  const entryPx = raw.entryPx ? parseFloat(raw.entryPx) : 0;
  const pnl = parseFloat(raw.unrealizedPnl) || 0;
  const pnlPercent = entryPx > 0 && absSize > 0 ? (pnl / (entryPx * absSize)) * 100 : 0;

  return {
    coin: raw.coin,
    assetIndex,
    isLong,
    sizeToken: `${isLong ? "" : "-"}${trimNum(absSize.toFixed(szDecimals + 4))}`,
    absSizeToken: absSize,
    sizeUsd: fmtUsd(positionValue),
    positionValue,
    entryPx: fmtPx(entryPx),
    markPx: fmtPx(markPx),
    liquidationPx: raw.liquidationPx ? fmtPx(parseFloat(raw.liquidationPx)) : null,
    unrealizedPnl: fmtSignedUsd(pnl),
    unrealizedPnlPercent: `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`,
    leverage: `${raw.leverage?.value ?? 1}x`,
    leverageType: raw.leverage?.type ?? "cross",
    marginUsedUsd: fmtUsd(parseFloat(raw.marginUsed) || 0),
    maxLeverage: raw.maxLeverage ?? 1,
    fundingSinceOpen: raw.cumFunding?.sinceOpen ? fmtSignedUsd(parseFloat(raw.cumFunding.sinceOpen)) : "—",
  };
}

/** Normalize one openOrders entry. Exported for tests. */
export function normalizeHlOpenOrder(raw: HlOpenOrder, assetIndex: number, szDecimals: number): HyperliquidOpenOrder {
  const isBuy = raw.side === "B";
  const reduceOnly = raw.reduceOnly === true;
  return {
    coin: raw.coin,
    assetIndex,
    side: isBuy !== reduceOnly ? "long" : "short",
    sizeToken: trimNum((parseFloat(raw.origSz ?? raw.sz) || 0).toFixed(szDecimals + 4)),
    price: fmtPx(parseFloat(raw.limitPx) || 0),
    oid: raw.oid,
    cloid: raw.cloid ?? null,
    tif: raw.tif ?? "GTC",
    reduceOnly,
    orderType: raw.orderType ?? "limit",
    timestamp: raw.timestamp ?? 0,
  };
}

/**
 * Full account summary: precompile balances + API positions/orders, plus the
 * formatted markdown report used by chat and Telegram.
 */
export async function getHyperliquidAccountSummary(vaultAddress: Address): Promise<HyperliquidAccountSummary> {
  const [meta, pre] = await Promise.all([
    getHyperliquidMeta(),
    getHyperliquidPrecompileBalances(vaultAddress),
  ]);

  // The API calls are best-effort: the account may not be activated yet, in which
  // case clearinghouseState errors and we fall back to precompile-only data.
  const [chState, orders] = await Promise.all([
    fetchClearinghouseState(vaultAddress).catch(() => null),
    fetchOpenOrders(vaultAddress).catch(() => [] as HlOpenOrder[]),
  ]);

  const coinIndex = new Map<string, number>();
  meta.universe.forEach((u, i) => coinIndex.set(u.name.toUpperCase(), i));
  const szDecimalsOf = (coin: string) => meta.universe[coinIndex.get(coin.toUpperCase()) ?? -1]?.szDecimals ?? 6;

  const positions: HyperliquidPosition[] = (chState?.assetPositions ?? [])
    .map((ap) => normalizeHlPosition(ap.position, coinIndex.get(ap.position.coin.toUpperCase()) ?? -1, szDecimalsOf(ap.position.coin)))
    .filter((p) => p.assetIndex >= 0 && p.absSizeToken > 0);

  const openOrders: HyperliquidOpenOrder[] = orders
    .map((o) => normalizeHlOpenOrder(o, coinIndex.get(o.coin.toUpperCase()) ?? -1, szDecimalsOf(o.coin)))
    .filter((o) => o.assetIndex >= 0);

  // Prefer precompile reads for the NAV-critical account values (they are the same
  // values the vault NAV uses); fall back to the API margin summary.
  const perpAccountValue = Number(formatUnits(pre.perpAccountValue, 6));
  const perpNtlPos = Number(formatUnits(pre.perpNtlPos, 6));
  const perpMarginUsed = Number(formatUnits(pre.perpMarginUsed, 6));
  const withdrawable = chState ? parseFloat(chState.withdrawable) || 0 : 0;
  const spotUsdcUsd = Number(formatUnits(pre.spotUsdcWei, 8));
  const totalAccountValue = perpAccountValue + spotUsdcUsd;
  const globalLeverage = perpAccountValue > 0 ? perpNtlPos / perpAccountValue : null;

  const summary: HyperliquidAccountSummary = {
    vaultAddress,
    activated: pre.activated,
    perpAccountValueUsd: fmtUsd(perpAccountValue),
    perpNtlPosUsd: fmtUsd(perpNtlPos),
    perpMarginUsedUsd: fmtUsd(perpMarginUsed),
    withdrawableUsd: fmtUsd(withdrawable),
    spotUsdcUsd: fmtUsd(spotUsdcUsd),
    totalAccountValueUsd: fmtUsd(totalAccountValue),
    globalLeverage: globalLeverage != null ? `${globalLeverage.toFixed(2)}x` : null,
    positions,
    openOrders,
    formattedReport: "",
  };
  summary.formattedReport = formatHyperliquidReport(summary);
  return summary;
}

function formatHyperliquidReport(s: HyperliquidAccountSummary): string {
  const lines: string[] = [];
  lines.push("📊 Hyperliquid Account");
  lines.push("");
  lines.push(
    s.activated
      ? `HyperCore account: ✅ activated   |   ${HYPEREVM_USDC.slice(0, 6)}… USDC-only`
      : `HyperCore account: ⏳ not activated — use hyperliquid_deposit to bridge USDC and activate it.`,
  );
  lines.push(
    `Perp value: ${s.perpAccountValueUsd}   |   Spot (USDC): ${s.spotUsdcUsd}   |   Total: ${s.totalAccountValueUsd}` +
      (s.globalLeverage ? `   |   Global leverage: ${s.globalLeverage}` : "") +
      (s.withdrawableUsd !== "$0.00" ? `   |   Withdrawable: ${s.withdrawableUsd}` : ""),
  );
  lines.push("");

  if (s.positions.length > 0) {
    lines.push(`| Market | Side | Size | Net PnL | Entry | Mark | Liq Price | Lev |`);
    lines.push(`|--------|------|------|---------|-------|------|-----------|-----|`);
    for (const p of s.positions) {
      lines.push(
        `| ${p.coin} | ${p.isLong ? "LONG" : "SHORT"} | ${p.sizeUsd} (${p.sizeToken}) | ${p.unrealizedPnl} (${p.unrealizedPnlPercent}) | ${p.entryPx} | ${p.markPx} | ${p.liquidationPx ?? "—"} | ${p.leverage} ${p.leverageType === "cross" ? "cross" : "isol"} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("No open Hyperliquid positions.");
    lines.push("");
  }

  if (s.openOrders.length > 0) {
    lines.push(`⏳ Open Orders (${s.openOrders.length})`);
    lines.push("");
    lines.push(`| Market | Side | Type | Size | Price | OID |`);
    lines.push(`|--------|------|------|------|-------|-----|`);
    for (const o of s.openOrders) {
      lines.push(
        `| ${o.coin} | ${o.side.toUpperCase()}${o.reduceOnly ? " (reduce-only)" : ""} | ${o.tif} | ${o.sizeToken} | ${o.price} | ${o.oid} |`,
      );
    }
    lines.push("");
  }

  lines.push(`[View account on Hyperliquid](https://app.hyperliquid.xyz/explorer/address/${s.vaultAddress})`);
  return lines.join("\n");
}
