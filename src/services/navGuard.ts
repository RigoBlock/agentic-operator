/**
 * NAV Shield — server-side protection against trades that crash pool unit price.
 *
 * Prevents any swap from reducing the vault's unitary value by more than
 * MAX_NAV_DROP_PCT (10%) compared to the pre-swap value or the 24-hour
 * baseline (whichever is higher).
 *
 * KILL-SWITCH: beyond per-trade protection, the threshold check halts ALL
 * trading once the vault has breached its allowed NAV drop — a rogue or
 * unlucky bot stops trading while NAV-neutral operations (deposits,
 * withdrawals, spot sends) keep working so the operator can rebalance or
 * exit. NEVER exempt a trading path (swaps, orders) from this shield.
 *
 * ## How it works
 *
 * 1. Read current NAV via `updateUnitaryValue()` eth_call on the vault
 * 2. eth_call a vault `multicall([tx, updateUnitaryValue])` from the vault
 *    owner — this captures the post-swap NAV in a single atomic simulation
 * 3. Compare post-swap unitaryValue vs pre-swap unitaryValue
 * 4. If drop > MAX_NAV_DROP_PCT, reject the transaction
 * 5. RECOVERY RULE: trades that improve or hold the current unitaryValue are
 *    always allowed, even if the vault is still below the 24h baseline.
 * 6. Store the 24-hour baseline in KV for rolling protection
 *
 * ## Why the simulation runs from the vault owner and NOT the executor
 *
 * The simulation is caller-independent: selector delegation is enforced by the
 * 7-point execution validation before this shield runs, and no whitelisted
 * adapter branches on msg.sender (the only msg.sender use in any adapter is an
 * event emission). The outer multicall selector hits the vault fallback's
 * write-mode gate, which the pool owner always passes — so simulating from the
 * vault owner needs no multicall delegation. Delegating multicall would grant
 * the agent nothing extra (each inner call is individually selector-checked and
 * core admin methods are onlyOwner), so the multicall selectors are not in the
 * delegation whitelist at all.
 *
 * ## Why updateUnitaryValue() instead of getNavDataView()
 *
 * getNavDataView() is a view-only extension (ENavView) that has an edge case
 * bug: when effectiveSupply > 0 AND totalValue <= 0, it returns unitaryValue=0.
 * The actual contract algorithm (_updateNav in MixinPoolValue) returns the
 * STORED unitaryValue in this case, preserving the last known good price.
 * Since eth_call can simulate non-view functions, we use updateUnitaryValue()
 * to get the correct result matching actual contract behavior.
 *
 * ## The NAV shield can be temporarily disabled by the operator
 *
 * The NAV shield is the user's primary protection against rogue transactions.
 * It is enabled by default and should normally never be skipped. However, an
 * authenticated operator may temporarily disable it (e.g. to work around a
 * contract-level oracle bug that makes the NAV simulation revert). The disable
 * override uses the same 10-minute TTL as threshold overrides so a forgotten
 * setting cannot leave vaults under-protected. External agents and prompt
 * injections cannot disable the shield because they never receive
 * `operatorVerified = true`.
 *
 * This shield runs BEFORE the transaction is broadcast (both sponsored
 * and direct paths), so it's entirely server-side and outside the agent's
 * control.
 *
 * ## FAIL-CLOSED POLICY
 *
 * If the NAV threshold check itself fails (pre-NAV read error, decode
 * failure), the shield returns `allowed: false`. We NEVER allow a
 * transaction when we can't even read the vault's current NAV.
 *
 * If the multicall reverts, the transaction itself would revert on-chain for
 * any legitimate executor (the simulation is caller-independent; selector
 * delegation is validated separately before this shield runs), so the shield
 * returns `allowed: false` with code TRADE_REVERTS and the decoded revert
 * reason.
 */

import {
  encodeFunctionData,
  decodeFunctionData,
  decodeFunctionResult,
  type Address,
  type Hex,
} from "viem";
import { RIGOBLOCK_VAULT_ABI, ALLOWED_VAULT_SELECTORS } from "../abi/rigoblockVault.js";
import { RIGOBLOCK_HYPERLIQUID_ABI, HL_ACTIONS } from "../abi/hyperliquid.js";
import { getRpcProvider } from "./rpcClient.js";
import { decodeRevertData, getRevertDataFromError } from "./errorDecoder.js";
import type { Env } from "../types.js";

/**
 * HyperEVM → HyperCore NAV-neutral selectors (AHyperliquid) — chain 999 only.
 *
 * The NAV shield doubles as a KILL-SWITCH for trading: a transaction is
 * rejected when the vault is already below the allowed NAV drop, halting a
 * rogue or unlucky trading bot. That kill-switch MUST stay on every trading
 * path — including `sendRawAction` limit orders — while deposits and
 * withdrawals keep working so the operator can always rebalance or exit.
 * Do NOT add trading selectors here.
 *
 * The selectors below are the ONLY HyperCore interactions exempted from the
 * post-tx NAV comparison (the raw transaction is still simulated and reverts
 * still block). They share one property: they lock pool NAV at the end of
 * execution (they touch `lastActionTimestamp`, so a trailing
 * updateUnitaryValue in the same multicall always reverts NavLocked), yet
 * they cannot impact NAV:
 *  - `deposit`/`depositFor` move USDC 1:1 into the Core perp account, which
 *    the NAV already counts via the precompiles.
 *  - `spotSend` (CoreWriter action id 6, inside sendRawAction(bytes)) bridges
 *    Core spot USDC back to HyperEVM — a withdrawal. It is detected by
 *    `isSpotSendAction` below; every OTHER sendRawAction payload (limit
 *    orders, USD-class transfers, cancels) is trading-relevant and keeps the
 *    full multicall shield as the kill-switch.
 */
const HYPERCORE_NAV_NEUTRAL_SELECTORS: string[] = [
  ALLOWED_VAULT_SELECTORS.hlDeposit.toLowerCase(),
  ALLOWED_VAULT_SELECTORS.hlDepositFor.toLowerCase(),
];

/**
 * Decode a sendRawAction(bytes) vault calldata payload and report whether it
 * carries a SPOT_SEND_ACTION (CoreWriter action id 6) — the only sendRawAction
 * variant that locks NAV (touches lastActionTimestamp) without being able to
 * impact it, since it is a withdrawal from Core to HyperEVM. Returns false for
 * every other action (limit orders, USD-class transfers, cancels), which keep
 * the full NAV shield kill-switch — and false for any payload that does not
 * decode: undecodable payloads MUST keep the shield (fail closed), never skip
 * it.
 *
 * Payload layout (CoreWriter): 1 version byte + uint24 action id + abi params.
 */
function isSpotSendAction(txData: Hex): boolean {
  try {
    const decoded = decodeFunctionData({
      abi: RIGOBLOCK_HYPERLIQUID_ABI,
      data: txData,
    });
    if (decoded.functionName !== "sendRawAction") return false;
    const action = decoded.args[0] as Hex;
    if (action.length < 10) return false;
    if (Number(BigInt(action.slice(2, 4))) !== 1) return false; // version
    const actionId = Number(
      (BigInt(action.slice(4, 6)) << 16n) |
      (BigInt(action.slice(6, 8)) << 8n) |
      BigInt(action.slice(8, 10)),
    );
    return actionId === HL_ACTIONS.spotSend;
  } catch {
    return false;
  }
}

/** Default maximum allowed NAV drop per transaction (10%) — used for swaps */
export const DEFAULT_MAX_NAV_DROP_PCT = 10n;

/** Minimum configurable NAV drop threshold (1%). 0 is reserved as a sentinel for "disabled". */
export const MIN_NAV_DROP_PCT = 1n;

/** Maximum configurable NAV drop threshold (100%) */
export const MAX_NAV_DROP_PCT = 100n;

/** Sentinel value: NAV shield disabled by operator. Stored in KV as "0". */
export const DISABLED_NAV_DROP_PCT = 0n;

/** KV key prefix for per-operator NAV shield threshold override */
const NAV_SHIELD_PREFIX = "nav-shield-pct:";

/**
 * Temporary threshold TTL: 10 minutes.
 * Like the swap-shield tolerance override, a raised NAV shield threshold is
 * intentionally short-lived so a forgotten override cannot leave vaults
 * under-protected.
 */
const NAV_SHIELD_TTL = 600;

/**
 * Get the operator's stored NAV shield threshold from KV.
 * Returns `null` if not set (caller should use DEFAULT_MAX_NAV_DROP_PCT).
 * Returns `0n` if the operator has temporarily disabled the NAV shield.
 */
export async function getNavShieldThreshold(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<bigint | null> {
  const raw = await kv.get(`${NAV_SHIELD_PREFIX}${operatorAddress.toLowerCase()}`);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const val = BigInt(raw);
  // 0 is the explicit "disabled" sentinel; negatives and >100 are invalid.
  if (val < 0n || val > MAX_NAV_DROP_PCT) return null;
  return val;
}

/**
 * Temporarily set a higher NAV shield threshold, or disable the shield entirely
 * by passing `0n` (10-minute TTL).
 * The override automatically resets to the default after TTL expiry.
 */
export async function setNavShieldThreshold(
  kv: KVNamespace,
  operatorAddress: string,
  pct: bigint,
): Promise<void> {
  if (pct < 0n || pct > MAX_NAV_DROP_PCT) {
    throw new Error(
      `NAV shield threshold must be between ${Number(MIN_NAV_DROP_PCT)}% and ${Number(MAX_NAV_DROP_PCT)}%, or 0 to disable. ` +
      `Received: ${Number(pct)}%`,
    );
  }
  await kv.put(
    `${NAV_SHIELD_PREFIX}${operatorAddress.toLowerCase()}`,
    String(pct),
    { expirationTtl: NAV_SHIELD_TTL },
  );
}

/**
 * Clear the operator's NAV shield threshold override (reset to default).
 */
export async function clearNavShieldThreshold(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<void> {
  await kv.delete(`${NAV_SHIELD_PREFIX}${operatorAddress.toLowerCase()}`);
}

/** KV key prefix for 24-hour NAV baseline */
const NAV_BASELINE_PREFIX = "nav-baseline:";

/** 24 hours in milliseconds */
const BASELINE_TTL_MS = 24 * 60 * 60 * 1000;

/** KV TTL for baseline storage (48h to have overlap) */
const BASELINE_KV_TTL = 48 * 60 * 60;

// ── Types ────────────────────────────────────────────────────────────

interface NavData {
  totalValue: bigint;
  unitaryValue: bigint;
  timestamp: bigint;
}

interface NavBaseline {
  unitaryValue: string; // bigint serialized as string for KV
  recordedAt: number;   // Date.now() when recorded
  chainId: number;
}

export interface NavShieldResult {
  allowed: boolean;
  /** Whether NAV impact was actually measured (true = threshold comparison happened) */
  verified: boolean;
  preNavUnitaryValue: string;
  postNavUnitaryValue: string;
  /** Unsigned drop from the higher of pre-swap NAV or 24h baseline (used for threshold enforcement). */
  dropPct: string;
  /** Signed percentage change from pre-swap to post-swap NAV (positive = NAV improved). */
  impactPct: string;
  baselineUnitaryValue?: string;
  reason?: string;
  /** Distinguishes WHY the result is what it is:
   *  - 'BLOCKED'       — NAV would drop more than the threshold
   *  - 'TRADE_REVERTS' — the transaction itself reverts on-chain (not a NAV issue)
   *  - 'NAV_NEUTRAL'   — HyperEVM → HyperCore interaction that locks NAV but
   *                      cannot impact it (deposit/depositFor/spotSend): tx
   *                      simulates cleanly; the [tx, updateUnitaryValue]
   *                      composition would always revert NavLocked, so the raw
   *                      tx was simulated and the threshold comparison skipped.
   *                      Trading actions (sendRawAction orders) are NEVER this
   *                      code — they keep the full shield as the kill-switch.
   *  - 'DISABLED'      — operator intentionally disabled the NAV shield temporarily
   *  - undefined       — allowed, NAV verified OK
   */
  code?: 'BLOCKED' | 'TRADE_REVERTS' | 'NAV_NEUTRAL' | 'DISABLED';
}

/** @deprecated Use NavShieldResult */
export type NavGuardResult = NavShieldResult;

/**
 * Compute the signed percentage change from pre-swap to post-swap unitary value.
 * Positive = NAV improved; negative = NAV dropped; zero = unchanged.
 */
function computeImpactPct(preUnitaryValue: bigint, postUnitaryValue: bigint): string {
  if (preUnitaryValue === 0n) return "0";
  const impactBps = ((postUnitaryValue - preUnitaryValue) * 10000n) / preUnitaryValue;
  return (Number(impactBps) / 100).toFixed(4);
}

// ── Public API ───────────────────────────────────────────────────────

/** Decode the updateUnitaryValue return tuple into NavData. */
function decodeUpdateUnitaryValue(data: Hex): NavData {
  const navResult = decodeFunctionResult({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "updateUnitaryValue",
    data,
  }) as { unitaryValue: bigint; netTotalValue: bigint; netTotalLiabilities: bigint };

  return {
    totalValue: navResult.netTotalValue,
    unitaryValue: navResult.unitaryValue,
    timestamp: 0n, // updateUnitaryValue doesn't return timestamp
  };
}

/**
 * Format a simulation error for human-readable output.
 * When the revert data decodes against a known ABI, only the decoded reason is
 * shown — the raw selector is surfaced exclusively for undecoded reverts.
 */
function formatSimulationError(err: unknown, prefix: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const revertData = getRevertDataFromError(err);
  const decoded = revertData ? decodeRevertData(revertData) : null;

  let detail: string;
  if (decoded) {
    detail = decoded.replace(/^Contract reverted: /, "");
  } else if (revertData) {
    detail = `Raw revert data: ${revertData}`;
  } else if (/returned no data/i.test(msg)) {
    // viem wraps empty-data reverts in a misleading "returned no data" decoding
    // error — say what actually happened instead.
    detail = "the transaction reverted on-chain without a revert reason";
  } else {
    detail = msg;
  }

  return `${prefix}: ${detail}`;
}

/** Build a TRADE_REVERTS result from a failed multicall eth_call. */
function buildTradeRevertsResult(err: unknown, preUnitaryValue: bigint): NavShieldResult {
  const reason = formatSimulationError(err, "Trade simulation failed — the transaction would revert on-chain");
  console.error(`[NavShield] ✗ TRADE_REVERTS: ${reason}`);
  return {
    allowed: false,
    verified: false,
    code: 'TRADE_REVERTS',
    preNavUnitaryValue: preUnitaryValue.toString(),
    postNavUnitaryValue: "0",
    dropPct: "0",
    impactPct: "0",
    reason,
  };
}

/** Evaluate pre/post NAV against thresholds and 24-hour baselines. */
async function evaluateNavImpact(
  preNav: NavData,
  postNav: NavData,
  chainId: number,
  vaultAddress: Address,
  kv: KVNamespace | undefined,
  maxDropPct: bigint,
): Promise<NavShieldResult> {
  // If unitaryValue is 0, vault is empty — nothing to protect
  if (preNav.unitaryValue === 0n) {
    return {
      allowed: true,
      verified: true,
      preNavUnitaryValue: "0",
      postNavUnitaryValue: "0",
      dropPct: "0",
      impactPct: "0",
      reason: "Empty vault (unitaryValue=0)",
    };
  }

  // Calculate NAV drop percentage
  const dropBps = preNav.unitaryValue > postNav.unitaryValue
    ? ((preNav.unitaryValue - postNav.unitaryValue) * 10000n) / preNav.unitaryValue
    : 0n;
  void dropBps; // kept for parity; threshold enforcement uses reference value below

  // ── Check against 24-hour baseline ──
  let baselineUnitaryValue: bigint | undefined;
  if (kv) {
    try {
      const baseline = await loadBaseline(kv, vaultAddress, chainId);
      if (baseline) {
        baselineUnitaryValue = BigInt(baseline.unitaryValue);
      } else {
        // No baseline yet — store current as baseline
        await storeBaseline(kv, vaultAddress, chainId, preNav.unitaryValue);
      }
    } catch (err) {
      console.warn("[NavShield] KV baseline error (ignoring):", err);
    }
  }

  // Compare against the higher of: pre-swap NAV or 24h baseline
  const referenceValue = baselineUnitaryValue && baselineUnitaryValue > preNav.unitaryValue
    ? baselineUnitaryValue
    : preNav.unitaryValue;

  const dropFromRefBps = referenceValue > postNav.unitaryValue
    ? ((referenceValue - postNav.unitaryValue) * 10000n) / referenceValue
    : 0n;
  const dropFromRefPct = Number(dropFromRefBps) / 100;

  // ── Recovery rule ──
  if (postNav.unitaryValue >= preNav.unitaryValue) {
    const improvementBps = postNav.unitaryValue > preNav.unitaryValue
      ? ((postNav.unitaryValue - preNav.unitaryValue) * 10000n) / preNav.unitaryValue
      : 0n;
    const improvementPct = Number(improvementBps) / 100;

    return {
      allowed: true,
      verified: true,
      preNavUnitaryValue: preNav.unitaryValue.toString(),
      postNavUnitaryValue: postNav.unitaryValue.toString(),
      dropPct: "0",
      impactPct: computeImpactPct(preNav.unitaryValue, postNav.unitaryValue),
      baselineUnitaryValue: baselineUnitaryValue?.toString(),
      reason: improvementPct > 0
        ? `Trade improves the pool unit price by ${improvementPct.toFixed(2)}%.`
        : "Trade holds the pool unit price unchanged.",
    };
  }

  // ── Enforce threshold for trades that actually reduce NAV ──
  const maxDrop = Number(maxDropPct);
  if (dropFromRefPct > maxDrop) {
    const isBelowBaseline = baselineUnitaryValue && baselineUnitaryValue > preNav.unitaryValue;
    const baselineDropPct = isBelowBaseline && baselineUnitaryValue
      ? Number(((baselineUnitaryValue - preNav.unitaryValue) * 10000n) / baselineUnitaryValue) / 100
      : 0;

    console.warn(
      `[NavShield] ✗ BLOCKED: NAV would drop ${dropFromRefPct.toFixed(2)}% from reference ` +
      `(max allowed: ${maxDrop}%) reference=${referenceValue} pre=${preNav.unitaryValue} post=${postNav.unitaryValue}`,
    );

    const reason = isBelowBaseline
      ? (
        `NAV is already ${baselineDropPct.toFixed(2)}% below the 24h baseline. ` +
        `This trade would worsen it to ${dropFromRefPct.toFixed(2)}% below baseline ` +
        `(limit: ${maxDrop}%). Trading is paused while NAV is below baseline.`
      )
      : (
        `Trade would reduce pool unit price by ${dropFromRefPct.toFixed(2)}% ` +
        `(limit: ${maxDrop}%). This protects the pool from excessive value impact.`
      );

    return {
      allowed: false,
      verified: true,
      code: 'BLOCKED',
      preNavUnitaryValue: preNav.unitaryValue.toString(),
      postNavUnitaryValue: postNav.unitaryValue.toString(),
      dropPct: dropFromRefPct.toFixed(4),
      impactPct: computeImpactPct(preNav.unitaryValue, postNav.unitaryValue),
      baselineUnitaryValue: baselineUnitaryValue?.toString(),
      reason,
    };
  }

  // ── Update baseline if needed ──
  if (kv) {
    try {
      const baseline = await loadBaseline(kv, vaultAddress, chainId);
      if (!baseline || (Date.now() - baseline.recordedAt) > BASELINE_TTL_MS) {
        await storeBaseline(kv, vaultAddress, chainId, preNav.unitaryValue);
      }
    } catch { /* non-critical */ }
  }

  return {
    allowed: true,
    verified: true,
    preNavUnitaryValue: preNav.unitaryValue.toString(),
    postNavUnitaryValue: postNav.unitaryValue.toString(),
    dropPct: dropFromRefPct.toFixed(4),
    impactPct: computeImpactPct(preNav.unitaryValue, postNav.unitaryValue),
    baselineUnitaryValue: baselineUnitaryValue?.toString(),
  };
}

/**
 * Check if a transaction would drop the vault's NAV per unit by more
 * than the allowed threshold.
 *
 * Uses plain `eth_call` from the vault owner (see module header: the
 * simulation is caller-independent and the owner always passes the fallback
 * write-mode gate, so no multicall delegation is required):
 *   - `updateUnitaryValue()` for the pre-swap unitary value
 *   - `multicall([tx, updateUnitaryValue])` for the post-swap unitary value
 *
 * KILL-SWITCH — the threshold comparison is what halts a trading bot once the
 * vault has breached its allowed NAV drop. Trading actions therefore always go
 * through the multicall path below; only NAV-neutral operations are exempted.
 *
 * EXCEPTION — NAV-neutral HyperEVM → HyperCore interactions (chain 999):
 * `deposit`, `depositFor`, and `sendRawAction` payloads carrying a SPOT_SEND
 * action (CoreWriter action id 6, a Core → HyperEVM withdrawal). These touch
 * `lastActionTimestamp`, which locks pool NAV for a few seconds while
 * HyperCore settles — a trailing `updateUnitaryValue` in the same multicall
 * always reverts `NavLocked()` — yet they cannot impact NAV (deposits move
 * USDC 1:1 into the Core perp account the NAV already counts via the
 * precompiles; a spot send is a withdrawal). For these the shield simulates
 * the raw transaction instead (reverts still block; a clean simulation is
 * allowed with code NAV_NEUTRAL and no threshold comparison).
 *
 * sendRawAction payloads that are NOT spot sends (limit orders, USD-class
 * transfers, cancels) are trading-relevant and MUST keep the full multicall
 * shield even though their Core settlement is asynchronous and invisible to
 * the simulation — the shield's job for them is the kill-switch, not measuring
 * the fill.
 *
 * `knownOwner`: callers that already verified vault ownership pass the owner
 * address (no extra RPC read); otherwise it is read on-chain, batched with the
 * totalSupply read into one round-trip.
 *
 * RECOVERY RULE: trades that improve or hold the current unitaryValue are
 * always allowed, even when the vault is below the 24h baseline. Only trades
 * that reduce unitaryValue are subject to the maxDropPct threshold.
 */
export async function checkNavImpact(
  vaultAddress: Address,
  txData: Hex,
  txValue: bigint,
  chainId: number,
  knownOwner?: Address,
  kv?: KVNamespace,
  maxDropPct: bigint = DEFAULT_MAX_NAV_DROP_PCT,
): Promise<NavShieldResult> {
  const publicClient = getRpcProvider(chainId);

  // Operator has explicitly disabled the NAV shield temporarily. Skip all
  // simulation and return an allowed result so execution can proceed without the
  // NAV updateUnitaryValue call.
  if (maxDropPct === 0n) {
    return {
      allowed: true,
      verified: false,
      code: 'DISABLED',
      preNavUnitaryValue: "0",
      postNavUnitaryValue: "0",
      dropPct: "0",
      impactPct: "0",
      reason: "NAV shield temporarily disabled by operator. It will re-enable automatically in 10 minutes.",
    };
  }

  // No supply-based skip. Raw ERC-20 totalSupply can be 0 while virtual supply
  // (cross-chain transfers) keeps NAV live, and even zero effective supply is
  // handled on-chain (MixinPoolValue._updateNav returns the stored value
  // without update). The shield therefore always simulates.
  // `knownOwner` lets callers that already verified vault ownership
  // (operatorVerified) skip the owner read — latency-critical on the execution path.
  try {
    const vaultOwner = (knownOwner ??
      (await publicClient.readContract({
        address: vaultAddress,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "owner",
      }))) as Address;

    const updateNavCalldata = encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
    });

    // NAV-neutral HyperCore interactions (deposits, depositFor, spot sends)
    // lock pool NAV at the end of execution — they touch lastActionTimestamp,
    // so a trailing updateUnitaryValue in the same multicall always reverts
    // NavLocked — even though they cannot impact NAV. For those the
    // [tx, update] composition can never succeed even though the action itself
    // is valid. Simulate the raw transaction instead; reverts still block.
    //
    // KILL-SWITCH RULE: sendRawAction is only exempted when its inner payload
    // is a SPOT_SEND (a withdrawal). Limit orders and other CoreWriter actions
    // are trading and MUST keep the full multicall shield below, so a vault
    // that already breached its NAV threshold stops trading while deposits and
    // withdrawals keep working.
    const txSelector = txData.slice(0, 10).toLowerCase();
    const isNavNeutralHyperCoreTx =
      chainId === 999 &&
      (HYPERCORE_NAV_NEUTRAL_SELECTORS.includes(txSelector) ||
        (txSelector === ALLOWED_VAULT_SELECTORS.hlSendRawAction.toLowerCase() &&
          isSpotSendAction(txData)));
    if (isNavNeutralHyperCoreTx) {
      const [preSettled, txSettled] = await Promise.allSettled([
        publicClient.call({
          account: vaultOwner,
          to: vaultAddress,
          data: updateNavCalldata,
        }),
        publicClient.call({
          account: vaultOwner,
          to: vaultAddress,
          data: txData,
          value: txValue,
        }),
      ]);

      if (preSettled.status === "rejected") {
        throw preSettled.reason instanceof Error
          ? preSettled.reason
          : new Error(String(preSettled.reason));
      }
      const preNav = decodeUpdateUnitaryValue(preSettled.value.data!);

      if (txSettled.status === "rejected") {
        return buildTradeRevertsResult(txSettled.reason, preNav.unitaryValue);
      }

      return {
        allowed: true,
        verified: false,
        code: "NAV_NEUTRAL",
        preNavUnitaryValue: preNav.unitaryValue.toString(),
        postNavUnitaryValue: "0",
        dropPct: "0",
        impactPct: "0",
        reason: "Transaction simulates cleanly. This HyperCore interaction locks NAV for a few seconds at the end of execution but cannot impact NAV: deposits move USDC 1:1 into the Core perp account the NAV already counts, and spot sends are withdrawals from Core back to HyperEVM. The NAV threshold comparison is skipped for it by design; reverts still block. Trading actions (orders) keep the full NAV shield.",
      };
    }

    const multicallData = encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "multicall",
      args: [[txData, updateNavCalldata]],
    });

    // Run both eth_calls concurrently from the vault owner. viem's HTTP
    // transport batches independent JSON-RPC requests into a single HTTP call,
    // so this is still one round-trip.
    const [preSettled, multiSettled] = await Promise.allSettled([
      publicClient.call({
        account: vaultOwner,
        to: vaultAddress,
        data: updateNavCalldata,
      }),
      publicClient.call({
        account: vaultOwner,
        to: vaultAddress,
        data: multicallData,
        value: txValue,
      }),
    ]);

    if (preSettled.status === "rejected") {
      throw preSettled.reason instanceof Error
        ? preSettled.reason
        : new Error(String(preSettled.reason));
    }
    const preNav = decodeUpdateUnitaryValue(preSettled.value.data!);

    if (multiSettled.status === "rejected") {
      return buildTradeRevertsResult(
        multiSettled.reason,
        preNav.unitaryValue,
      );
    }

    // multicall returns bytes[] — one result per inner call. The last one is
    // the updateUnitaryValue return data.
    const innerResults = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "multicall",
      data: multiSettled.value.data!,
    }) as Hex[];
    const postNav = decodeUpdateUnitaryValue(innerResults[innerResults.length - 1]);

    return evaluateNavImpact(preNav, postNav, chainId, vaultAddress, kv, maxDropPct);
  } catch (err) {
    // FAIL-CLOSED: any simulation failure (RPC error, timeout, unsupported method)
    // means we cannot verify NAV impact. We MUST block the transaction.
    const reason = formatSimulationError(err, "Could not simulate NAV impact");
    console.error(`[NavShield] BLOCKED: ${reason}`);
    return {
      allowed: false,
      verified: false,
      preNavUnitaryValue: "0",
      postNavUnitaryValue: "0",
      dropPct: "0",
      impactPct: "0",
      reason: `Cannot simulate vault NAV impact on chain ${chainId}: ${reason}`,
    };
  }
}

// ── KV Baseline helpers ──────────────────────────────────────────────

function baselineKey(vaultAddress: string, chainId: number): string {
  return `${NAV_BASELINE_PREFIX}${vaultAddress.toLowerCase()}:${chainId}`;
}

async function loadBaseline(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
): Promise<NavBaseline | null> {
  const raw = await kv.get(baselineKey(vaultAddress, chainId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NavBaseline;
  } catch {
    return null;
  }
}

async function storeBaseline(
  kv: KVNamespace,
  vaultAddress: string,
  chainId: number,
  unitaryValue: bigint,
): Promise<void> {
  const data: NavBaseline = {
    unitaryValue: unitaryValue.toString(),
    recordedAt: Date.now(),
    chainId,
  };
  await kv.put(
    baselineKey(vaultAddress, chainId),
    JSON.stringify(data),
    { expirationTtl: BASELINE_KV_TTL },
  );
}
