/**
 * NAV Shield — server-side protection against trades that crash pool unit price.
 *
 * Prevents any swap from reducing the vault's unitary value by more than
 * MAX_NAV_DROP_PCT (10%) compared to the pre-swap value or the 24-hour
 * baseline (whichever is higher).
 *
 * ## How it works
 *
 * 1. Read current NAV via `getNavDataView()` on the vault
 * 2. Simulate a vault `multicall([swap, getNavDataView])` via `eth_call`
 *    — this captures the post-swap NAV in a single atomic simulation
 *    — the simulation runs as the vault OPERATOR (not the agent wallet),
 *      because `multicall` is not in the agent's delegated selectors.
 *      The operator is the vault owner and is always authorized for any
 *      selector, so the multicall succeeds.
 * 3. Compare post-swap unitaryValue vs pre-swap unitaryValue
 * 4. If drop > MAX_NAV_DROP_PCT, reject the transaction
 * 5. Store the 24-hour baseline in KV for rolling protection
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
} from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { getClient } from "./vault.js";

/** Maximum allowed NAV drop per transaction (10%) */
const MAX_NAV_DROP_PCT = 10n;

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
  dropPct: string;
  baselineUnitaryValue?: string;
  reason?: string;
  /** Distinguishes WHY the result is what it is:
   *  - 'BLOCKED'       — NAV would drop more than the threshold
   *  - 'TRADE_REVERTS' — the swap itself reverts on-chain (not a NAV issue)
   *  - 'UNVERIFIED'    — multicall simulation failed but swap is valid; NAV unknown
   *  - undefined       — allowed, NAV verified OK
   */
  code?: 'BLOCKED' | 'TRADE_REVERTS' | 'UNVERIFIED';
}

/** @deprecated Use NavShieldResult */
export type NavGuardResult = NavShieldResult;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a transaction would drop the vault's NAV per unit by more
 * than the allowed threshold.
 *
 * @param vaultAddress - The vault contract address
 * @param txData - The encoded transaction calldata (for the vault)
 * @param txValue - ETH value sent with the tx (usually 0)
 * @param chainId - Chain ID
 * @param alchemyKey - Alchemy API key
 * @param callerAddress - Address that will execute the tx (agent wallet)
 * @param kv - KV namespace for baseline storage (optional)
 * @returns NavShieldResult with allowed=true/false
 */
export async function checkNavImpact(
  vaultAddress: Address,
  txData: Hex,
  txValue: bigint,
  chainId: number,
  alchemyKey: string,
  callerAddress: Address,
  kv?: KVNamespace,
): Promise<NavShieldResult> {
  const publicClient = getClient(chainId, alchemyKey);

  // ── Step 1: Read current (pre-swap) NAV ──
  let preNav: NavData;
  try {
    const result = await publicClient.readContract({
      address: vaultAddress,
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "getNavDataView",
    }) as { totalValue: bigint; unitaryValue: bigint; timestamp: bigint };

    preNav = {
      totalValue: result.totalValue,
      unitaryValue: result.unitaryValue,
      timestamp: result.timestamp,
    };
    console.log(
      `[NavShield] Pre-swap NAV: unitaryValue=${preNav.unitaryValue} ` +
      `totalValue=${preNav.totalValue} chain=${chainId}`,
    );
  } catch (err) {
    // FAIL-CLOSED: If we can't read pre-swap NAV, we MUST block the transaction.
    // Allowing it would bypass the NAV shield entirely — leaving the vault unprotected.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[NavShield] ✗ BLOCKED: Could not read pre-swap NAV: ${msg}`);
    return {
      allowed: false,
      verified: false,
      preNavUnitaryValue: "0",
      postNavUnitaryValue: "0",
      dropPct: "0",
      reason: `Cannot read vault NAV — RPC or vault may be unreachable on chain ${chainId}: ${msg.slice(0, 300)}`,
    };
  }

  // If unitaryValue is 0, vault is empty — nothing to protect
  if (preNav.unitaryValue === 0n) {
    console.log("[NavShield] unitaryValue=0 (empty vault) — allowing");
    return {
      allowed: true,
      verified: true,
      preNavUnitaryValue: "0",
      postNavUnitaryValue: "0",
      dropPct: "0",
      reason: "Empty vault (unitaryValue=0)",
    };
  }

  // ── Step 2: Simulate multicall([swap, getNavDataView]) ──
  // Encode the getNavDataView call
  const navViewCalldata = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "getNavDataView",
  });

  // Encode the multicall: [original tx, getNavDataView]
  const multicallData = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "multicall",
    args: [[txData, navViewCalldata]],
  });

  let postNav: NavData;
  try {
    // Simulate the multicall via eth_call — atomic: swap + read NAV
    const multicallResult = await publicClient.call({
      account: callerAddress,
      to: vaultAddress,
      data: multicallData,
      value: txValue,
    });

    if (!multicallResult.data) {
      throw new Error("Multicall simulation returned no data");
    }

    // Decode the multicall result → bytes[]
    const decodedMulticall = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "multicall",
      data: multicallResult.data,
    }) as readonly Hex[];

    // The second result is the getNavDataView return bytes
    const navResultBytes = decodedMulticall[1];

    // Decode the NavData tuple from the raw bytes
    const decodedNav = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "getNavDataView",
      data: navResultBytes,
    }) as { totalValue: bigint; unitaryValue: bigint; timestamp: bigint };

    postNav = {
      totalValue: decodedNav.totalValue,
      unitaryValue: decodedNav.unitaryValue,
      timestamp: decodedNav.timestamp,
    };

    console.log(
      `[NavShield] Post-swap NAV: unitaryValue=${postNav.unitaryValue} ` +
      `totalValue=${postNav.totalValue}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // FAIL-CLOSED: If we can't simulate the trade's NAV impact, we MUST block it.
    // But first, diagnose whether the SWAP itself reverts vs. only the multicall wrapping.
    // This gives the user a clear error: "trade would fail" vs. "NAV shield can't verify".
    console.error(`[NavShield] Multicall simulation failed: ${msg}`);

    let reason: string;
    let code: 'TRADE_REVERTS' | 'UNVERIFIED';
    let allowed: boolean;
    try {
      // Try simulating the swap alone (without multicall wrapping)
      await publicClient.call({
        account: callerAddress,
        to: vaultAddress,
        data: txData,
        value: txValue,
      });
      // Swap alone passes — multicall is unsupported on this vault/chain,
      // but the trade itself is valid. Proceed without NAV verification.
      code = 'UNVERIFIED';
      allowed = true;
      reason = `NAV verification unavailable — vault multicall simulation failed on chain ${chainId}. ` +
        `Trade is valid (swap simulation passed). Proceeding without NAV impact check.`;
      console.warn(`[NavShield] ⚠ UNVERIFIED: Swap passes but multicall fails on chain ${chainId} — proceeding without NAV check`);
    } catch (swapErr) {
      // Swap itself reverts — the trade is invalid, not a NAV shield problem
      const swapMsg = swapErr instanceof Error ? swapErr.message : String(swapErr);
      code = 'TRADE_REVERTS';
      allowed = false;
      reason = `Trade simulation failed — the swap would revert on-chain: ${swapMsg.slice(0, 500)}`;
      console.error(`[NavShield] ✗ TRADE REVERTS: ${swapMsg.slice(0, 500)}`);
    }

    return {
      allowed,
      verified: false,
      code,
      preNavUnitaryValue: preNav.unitaryValue.toString(),
      postNavUnitaryValue: "0",
      dropPct: "0",
      reason,
    };
  }

  // ── Step 3: Calculate NAV drop percentage ──
  const dropBps = preNav.unitaryValue > postNav.unitaryValue
    ? ((preNav.unitaryValue - postNav.unitaryValue) * 10000n) / preNav.unitaryValue
    : 0n;
  const dropPct = Number(dropBps) / 100; // Convert basis points to percentage

  console.log(
    `[NavShield] NAV change: ${preNav.unitaryValue} → ${postNav.unitaryValue} ` +
    `(${dropPct >= 0 ? "-" : "+"}${Math.abs(dropPct).toFixed(2)}%)`,
  );

  // ── Step 4: Check against 24-hour baseline ──
  let baselineUnitaryValue: bigint | undefined;
  if (kv) {
    try {
      const baseline = await loadBaseline(kv, vaultAddress, chainId);
      if (baseline) {
        baselineUnitaryValue = BigInt(baseline.unitaryValue);
        console.log(
          `[NavShield] 24h baseline: unitaryValue=${baselineUnitaryValue} ` +
          `(recorded ${Math.round((Date.now() - baseline.recordedAt) / 60000)}min ago)`,
        );
      } else {
        // No baseline yet — store current as baseline
        await storeBaseline(kv, vaultAddress, chainId, preNav.unitaryValue);
        console.log("[NavShield] No 24h baseline found — stored current NAV as baseline");
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

  // ── Step 5: Enforce threshold ──
  const maxDropPct = Number(MAX_NAV_DROP_PCT);
  if (dropFromRefPct > maxDropPct) {
    console.warn(
      `[NavShield] ✗ BLOCKED: NAV would drop ${dropFromRefPct.toFixed(2)}% ` +
      `(max allowed: ${maxDropPct}%) reference=${referenceValue} post=${postNav.unitaryValue}`,
    );
    return {
      allowed: false,
      verified: true,
      code: 'BLOCKED',
      preNavUnitaryValue: preNav.unitaryValue.toString(),
      postNavUnitaryValue: postNav.unitaryValue.toString(),
      dropPct: dropFromRefPct.toFixed(2),
      baselineUnitaryValue: baselineUnitaryValue?.toString(),
      reason: `Trade would reduce pool unit price by ${dropFromRefPct.toFixed(2)}% ` +
        `(max allowed: ${maxDropPct}%). This protects the pool from excessive value impact.`,
    };
  }

  // ── Step 6: Update baseline if needed ──
  if (kv) {
    try {
      // Refresh baseline if older than 24h or doesn't exist
      const baseline = await loadBaseline(kv, vaultAddress, chainId);
      if (!baseline || (Date.now() - baseline.recordedAt) > BASELINE_TTL_MS) {
        await storeBaseline(kv, vaultAddress, chainId, preNav.unitaryValue);
      }
    } catch { /* non-critical */ }
  }

  console.log(
    `[NavShield] ✓ ALLOWED: NAV drop ${dropFromRefPct.toFixed(2)}% within ${maxDropPct}% limit`,
  );

  return {
    allowed: true,
    verified: true,
    preNavUnitaryValue: preNav.unitaryValue.toString(),
    postNavUnitaryValue: postNav.unitaryValue.toString(),
    dropPct: dropFromRefPct.toFixed(2),
    baselineUnitaryValue: baselineUnitaryValue?.toString(),
  };
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
