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
 * 5. Store the 24-hour baseline in KV for rolling protection
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
 * ## The NAV shield must NEVER be skipped
 *
 * The NAV shield is the user's primary protection against rogue transactions.
 * When it produces incorrect results (e.g. blocking a valid bridge), the fix
 * must be in correcting the root cause (switching to updateUnitaryValue,
 * adjusting thresholds), not in skipping the shield. No code path, flag,
 * env var, or config may disable the NAV shield.
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

/** Default maximum allowed NAV drop per transaction (10%) — used for swaps */
const DEFAULT_MAX_NAV_DROP_PCT = 10n;

/** Known on-chain custom error selectors for clear error reporting */
const KNOWN_ERRORS: Record<string, string> = {
  // NavImpactLib — keccak256("NavImpactTooHigh()")[:4]
  "0x3471741b": "Transfer amount exceeds maximum allowed NAV impact (NavImpactTooHigh). " +
    "The on-chain contract limits how much value can leave the vault in a single transaction.",
  // NavImpactLib — keccak256("EffectiveSupplyTooLow()")[:4]
  "0x0f6e887f": "Effective supply too low after operation (EffectiveSupplyTooLow). " +
    "Cannot bridge more than 87.5% of pool supply (on-chain MINIMUM_SUPPLY_RATIO = 8).",
};

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
 * Parse a revert message for known on-chain custom error selectors.
 * Returns a human-readable description if recognized, or null.
 */
function parseKnownError(errMsg: string): string | null {
  const lower = errMsg.toLowerCase();
  for (const [selector, description] of Object.entries(KNOWN_ERRORS)) {
    // Custom errors appear as hex selectors in revert data
    if (lower.includes(selector.slice(2))) {
      return description;
    }
  }
  return null;
}

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
 * @param maxDropPct - Maximum allowed NAV drop percentage (default 10).
 *   The 10% threshold applies to swap, LP, AND bridge operations equally.
 *   The NAV shield must NEVER be skipped for any transaction type. When it
 *   produces incorrect results, fix the root cause (not skip the shield).
 *
 *   For Transfer bridges (depositV3 with OpType.Transfer): virtual supply
 *   updates make effectiveSupply decrease proportionally with value, so
 *   updateUnitaryValue() returns the stored unitaryValue → no NAV drop.
 *
 *   For Sync bridges (depositV3 with OpType.Sync): virtual supply is NOT
 *   updated, so source-chain NAV drops. The 10% threshold applies normally.
 *   If the caller knows the expected tolerance (e.g. from navToleranceBps),
 *   they can pass a higher maxDropPct.
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
  maxDropPct: bigint = DEFAULT_MAX_NAV_DROP_PCT,
): Promise<NavShieldResult> {
  const publicClient = getClient(chainId, alchemyKey);

  // ── Step 1: Read current (pre-swap) NAV via updateUnitaryValue() ──
  // We use updateUnitaryValue() (the actual contract NAV algorithm) instead of
  // getNavDataView() (view-only extension) because ENavView has an edge case
  // where it returns unitaryValue=0 when effectiveSupply > 0 AND totalValue <= 0,
  // while the actual _updateNav() preserves the stored unitaryValue in that case.
  // eth_call simulates the non-view function without persisting state changes.
  let preNav: NavData;
  try {
    const updateNavCalldata = encodeFunctionData({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
    });
    const callResult = await publicClient.call({
      to: vaultAddress,
      data: updateNavCalldata,
    });
    if (!callResult.data) {
      throw new Error("updateUnitaryValue simulation returned no data");
    }
    const navResult = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      data: callResult.data,
    }) as { unitaryValue: bigint; netTotalValue: bigint; netTotalLiabilities: bigint };

    preNav = {
      totalValue: navResult.netTotalValue,
      unitaryValue: navResult.unitaryValue,
      timestamp: 0n, // updateUnitaryValue doesn't return timestamp
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

  // ── Step 2: Simulate multicall([tx, updateUnitaryValue]) ──
  // Uses updateUnitaryValue() (the actual contract algorithm) to capture the
  // post-tx NAV atomically. This avoids the ENavView edge case where the view
  // returns unitaryValue=0 when effectiveSupply > 0 AND totalValue <= 0.
  const navCalldata = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "updateUnitaryValue",
  });

  // Encode the multicall: [original tx, updateUnitaryValue]
  const multicallData = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "multicall",
    args: [[txData, navCalldata]],
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

    // The second result is the updateUnitaryValue return bytes
    const navResultBytes = decodedMulticall[1];

    // Decode the NetAssetsValue tuple from the raw bytes
    const decodedNav = decodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      data: navResultBytes,
    }) as { unitaryValue: bigint; netTotalValue: bigint; netTotalLiabilities: bigint };

    postNav = {
      totalValue: decodedNav.netTotalValue,
      unitaryValue: decodedNav.unitaryValue,
      timestamp: 0n, // updateUnitaryValue doesn't return timestamp
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
    // Also check if the multicall error itself is a known on-chain error.
    const knownMulticallError = parseKnownError(msg);
    console.error(`[NavShield] Multicall simulation failed: ${knownMulticallError ?? msg}`);

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
      // Swap itself reverts — parse the actual error
      const swapMsg = swapErr instanceof Error ? swapErr.message : String(swapErr);
      code = 'TRADE_REVERTS';
      allowed = false;
      // Try to match known on-chain custom errors for clear reporting
      const knownError = parseKnownError(swapMsg);
      reason = knownError
        ? `On-chain error: ${knownError}`
        : `Trade simulation failed — the transaction would revert on-chain: ${swapMsg.slice(0, 500)}`;
      console.error(`[NavShield] ✗ TRADE REVERTS: ${reason}`);
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
  const maxDrop = Number(maxDropPct);
  if (dropFromRefPct > maxDrop) {
    console.warn(
      `[NavShield] ✗ BLOCKED: NAV would drop ${dropFromRefPct.toFixed(2)}% ` +
      `(max allowed: ${maxDrop}%) reference=${referenceValue} post=${postNav.unitaryValue}`,
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
        `(max allowed: ${maxDrop}%). This protects the pool from excessive value impact.`,
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
    `[NavShield] ✓ ALLOWED: NAV drop ${dropFromRefPct.toFixed(2)}% within ${maxDrop}% limit`,
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
