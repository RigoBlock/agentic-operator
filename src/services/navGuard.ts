/**
 * NAV Shield — server-side protection against trades that crash pool unit price.
 *
 * Prevents any swap from reducing the vault's unitary value by more than
 * MAX_NAV_DROP_PCT (10%) compared to the pre-swap value or the 24-hour
 * baseline (whichever is higher).
 *
 * ## How it works
 *
 * 1. Read current NAV via `updateUnitaryValue()` simulation on the vault
 * 2. Simulate a vault `multicall([swap, updateUnitaryValue])` via `eth_call`
 *    — this captures the post-swap NAV in a single atomic simulation
 *    — the simulation runs as the vault OPERATOR (not the agent wallet),
 *      because `multicall` is not in the agent's delegated selectors.
 *      The operator is the vault owner and is always authorized for any
 *      selector, so the multicall succeeds.
 * 3. Compare post-swap unitaryValue vs pre-swap unitaryValue
 * 4. If drop > MAX_NAV_DROP_PCT, reject the transaction
 * 5. RECOVERY RULE: trades that improve or hold the current unitaryValue are
 *    always allowed, even if the vault is still below the 24h baseline.
 * 6. Store the 24-hour baseline in KV for rolling protection
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
 * However, if the multicall simulation fails but the swap ALONE
 * simulates successfully, we return `allowed: true, verified: false`.
 * This means: "the trade is valid but NAV impact could not be measured
 * atomically" — the caller decides whether to proceed (execution.ts
 * logs a warning and continues). This should NOT be the normal path —
 * the operator address is always authorized for multicall. If this
 * fires, investigate why multicall is failing (RPC issue, adapter
 * not installed on this vault, etc.).
 */

import {
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { simulateCalls } from "viem/actions";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { getRpcProvider } from "./rpcClient.js";
import { decodeRevertData, getRevertDataFromError } from "./errorDecoder.js";
import type { Env } from "../types.js";

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
   *  - 'TRADE_REVERTS' — the swap itself reverts on-chain (not a NAV issue)
   *  - 'UNVERIFIED'    — multicall simulation failed but swap is valid; NAV unknown
   *  - 'DISABLED'      — operator intentionally disabled the NAV shield temporarily
   *  - undefined       — allowed, NAV verified OK
   */
  code?: 'BLOCKED' | 'TRADE_REVERTS' | 'UNVERIFIED' | 'DISABLED';
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
 * Format a simulation error for human-readable output, including any raw revert
 * data and the decoded error if it matches a known ABI.
 */
function formatSimulationError(err: unknown, prefix: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const revertData = getRevertDataFromError(err);
  const decoded = revertData ? decodeRevertData(revertData) : null;
  const parts: string[] = [`${prefix}: ${msg}`];
  if (decoded) parts.push(`Decoded revert: ${decoded}`);
  if (revertData && !decoded) parts.push(`Raw revert data: ${revertData}`);
  return parts.join(" | ");
}

/** Build a TRADE_REVERTS result from a swap simulation failure. */
function handleSwapSimulationFailure(
  err: unknown,
  preUnitaryValue: bigint,
  _chainId: number,
): NavShieldResult {
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
 * Uses eth_simulateV1 from the address that will actually execute the transaction.
 * This gives us:
 *   - the pre-swap unitary value
 *   - whether the transaction succeeds as the executor
 *   - the post-swap unitary value
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
  executorAddress: Address,
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

  // First deposit: no outstanding shares means no unitary value to protect.
  try {
    const totalSupply = await publicClient.readContract({
      address: vaultAddress,
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "totalSupply",
    });
    if (totalSupply === 0n) {
      return {
        allowed: true,
        verified: false,
        code: 'UNVERIFIED',
        preNavUnitaryValue: "0",
        postNavUnitaryValue: "0",
        dropPct: "0",
        impactPct: "0",
        reason: "no outstanding shares — first deposit, skipping NAV shield.",
      };
    }
  } catch (err) {
    // If totalSupply cannot be read, fall through to simulation and let it fail closed.
    console.warn("[NavShield] totalSupply read failed (falling through):", err);
  }

  try {
    const updateNavCalldata = encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
    });

    const preNavCall = { to: vaultAddress, data: updateNavCalldata };
    const swapCall = { to: vaultAddress, data: txData, value: txValue };
    const postNavCall = { to: vaultAddress, data: updateNavCalldata };

    // Run both simulations concurrently. viem's HTTP transport batches independent
    // JSON-RPC requests into a single HTTP call, so this is still one round-trip.
    const [preSim, swapSim] = await Promise.all([
      simulateCalls(publicClient, {
        account: executorAddress,
        calls: [preNavCall],
      }),
      simulateCalls(publicClient, {
        account: executorAddress,
        calls: [swapCall, postNavCall],
      }),
    ]);

    // Pre-swap NAV
    const preResult = preSim.results[0];
    if (preResult.status !== "success") {
      throw new Error(formatSimulationError(preResult.error, "Pre-swap NAV read failed"));
    }
    const preNav = decodeUpdateUnitaryValue(preResult.data);

    // Swap execution
    const swapResult = swapSim.results[0];
    if (swapResult.status !== "success") {
      return handleSwapSimulationFailure(swapResult.error, preNav.unitaryValue, chainId);
    }

    // Post-swap NAV
    const postResult = swapSim.results[1];
    if (postResult.status !== "success") {
      throw new Error(formatSimulationError(postResult.error, "Post-swap NAV read failed"));
    }
    const postNav = decodeUpdateUnitaryValue(postResult.data);

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
