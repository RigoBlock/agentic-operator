import { type Address } from "viem";
import {
  convertTokenAmountViaOracle,
  hasPriceFeedForPair,
  normalizeTokenAddress,
} from "./oraclePrice.js";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Default maximum allowed divergence from oracle price (5%).
 * Catches rogue quotes, API compromise, fat-finger errors, and extreme
 * low-liquidity routing without false-positiving on normal DEX spread.
 */
export const DEFAULT_MAX_DIVERGENCE_PCT = 5;


/** KV key prefix for swap shield temporary tolerance override */
const SWAP_SHIELD_TOLERANCE_PREFIX = "swap-shield-tolerance:";

/** Temporary tolerance TTL: 10 minutes */
const SWAP_SHIELD_TOLERANCE_TTL = 600;

/** Maximum temporary divergence an operator can set (50%) */
const MAX_TEMP_DIVERGENCE_PCT = 50;

function formatBpsAsPct(bps: bigint): string {
  const sign = bps < 0n ? "-" : "";
  const absBps = bps < 0n ? -bps : bps;
  const wholePct = absBps / 100n;
  const fractionalPct = (absBps % 100n).toString().padStart(2, "0");
  return `${sign}${wholePct.toString()}.${fractionalPct}`;
}

// ── Types ────────────────────────────────────────────────────────────

export interface SwapShieldResult {
  allowed: boolean;
  /** Whether oracle comparison was actually performed */
  verified: boolean;
  /** Oracle-derived expected output as a raw bigint string in smallest units */
  oracleAmount: string;
  /** DEX quote expected output as a raw bigint string in smallest units */
  dexAmount: string;
  /** Divergence percentage (positive = DEX gives less than oracle) */
  divergencePct: string;
  /** Divergence in basis points (positive = DEX worse, negative = DEX better) */
  deltaBps: number;
  /** Whether a price feed exists for both tokens */
  priceFeedExists: boolean;
  reason?: string;
  /**
   * Result code:
   * - 'BLOCKED'       — DEX quote diverges too much from oracle (user getting bad deal)
   * - 'INVALID_QUOTE' — quote output is invalid for safety checks (e.g., non-zero input, zero output)
   * - 'NO_PRICE_FEED' — oracle has no price feed for one of the tokens
   * - 'ORACLE_ERROR'  — oracle call failed for another reason
   * - undefined       — allowed, oracle check passed
   */
  code?: "BLOCKED" | "INVALID_QUOTE" | "NO_PRICE_FEED" | "ORACLE_ERROR";
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Check if a swap quote from a DEX API diverges from the on-chain oracle spot price.
 *
 * @param chainId - Chain ID
 * @param tokenIn - Address of the token being sold
 * @param tokenOut - Address of the token being bought
 * @param amountInRaw - Raw amount of tokenIn (in native decimals, as bigint)
 * @param dexExpectedOutRaw - Raw amount of tokenOut the DEX promises (in native decimals, as bigint)
 * @param _slippageBps - Reserved for future quote-type specific handling
 * @param alchemyKey - Alchemy API key for RPC
 * @param maxDivergencePct - Maximum allowed divergence (default 5%)
 * @returns SwapShieldResult
 */
export async function checkSwapPrice(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountInRaw: bigint,
  dexExpectedOutRaw: bigint,
  _slippageBps: number,
  alchemyKey: string,
  maxDivergencePct: number = DEFAULT_MAX_DIVERGENCE_PCT,
  precomputedPriceFeedExists?: boolean,
  precomputedOracleAmount?: bigint,
): Promise<SwapShieldResult> {
  void _slippageBps;

  // Negative inputs are never valid for a swap quote — reject as INVALID_QUOTE
  // rather than trying to reason about signed amounts downstream.
  if (amountInRaw < 0n || dexExpectedOutRaw < 0n) {
    return {
      allowed: false,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: false,
      code: "INVALID_QUOTE",
      reason: "Invalid quote — negative input or expected output amount.",
    };
  }

  // Skip only for zero input amounts
  if (amountInRaw === 0n) {
    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: false,
      reason: "Zero input amount — skipping oracle check",
    };
  }

  // Zero expected output for non-zero input is an invalid quote and must be blocked.
  if (dexExpectedOutRaw === 0n) {
    return {
      allowed: false,
      verified: false,
      oracleAmount: "0",
      dexAmount: "0",
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: false,
      code: "INVALID_QUOTE",
      reason: "Invalid quote — expected output is zero for a non-zero input amount.",
    };
  }

  // Normalize native ETH and WETH to address(0) for oracle math
  const normalizedIn = normalizeTokenAddress(tokenIn, chainId);
  const normalizedOut = normalizeTokenAddress(tokenOut, chainId);

  // Same token after normalization — skip (wrap/unwrap)
  if (normalizedIn.toLowerCase() === normalizedOut.toLowerCase()) {
    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: false,
      reason: "Same token (wrap/unwrap) — skipping oracle check",
    };
  }

  // ── Check price feed availability ──
  let priceFeedExists: boolean;
  if (precomputedPriceFeedExists !== undefined) {
    priceFeedExists = precomputedPriceFeedExists;
  } else {
    try {
      priceFeedExists = await hasPriceFeedForPair(chainId, normalizedIn, normalizedOut, alchemyKey);
    } catch {
      priceFeedExists = false;
    }
  }

  if (!priceFeedExists) {
    console.warn(
      `[SwapShield] ⚠ No oracle price feed for ${normalizedIn} → ${normalizedOut} on chain ${chainId}`,
    );
    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: false,
      code: "NO_PRICE_FEED",
      reason:
        `Oracle price feed not available for this token pair on chain ${chainId}. ` +
        `Swap Shield cannot verify this quote — proceeding without oracle protection.`,
    };
  }

  // ── Call convertTokenAmount via direct oracle spot price ──
  let oracleAmountRaw: bigint;
  if (precomputedOracleAmount !== undefined) {
    oracleAmountRaw = precomputedOracleAmount;
  } else {
    try {
      oracleAmountRaw = await convertTokenAmountViaOracle(
        chainId,
        normalizedIn,
        amountInRaw,
        normalizedOut,
        alchemyKey,
      );

    // convertTokenAmountViaOracle returns a bigint, but for a positive input amount the
    // output should always be non-negative. A negative return indicates an
    // unexpected condition — fail CLOSED to ORACLE_ERROR.
    if (oracleAmountRaw < 0n) {
      console.error(
        `[SwapShield] Oracle conversion returned a negative amount (${oracleAmountRaw}) ` +
        `for positive input ${amountInRaw} on chain ${chainId} — treating as ORACLE_ERROR`,
      );
      return {
        allowed: true,
        verified: false,
        oracleAmount: "0",
        dexAmount: dexExpectedOutRaw.toString(),
        divergencePct: "0",
        deltaBps: 0,
        priceFeedExists: true,
        code: "ORACLE_ERROR",
        reason:
          `Oracle returned an invalid (negative) amount on chain ${chainId}. ` +
          `Swap Shield cannot verify this quote — proceeding without oracle protection.`,
      };
    }

    console.log(
      `[SwapShield] Oracle spot: ${amountInRaw} tokenIn → ${oracleAmountRaw} tokenOut ` +
      `(chain=${chainId})`,
    );
  } catch (convertErr) {
    const convertErrMsg = convertErr instanceof Error ? convertErr.message : String(convertErr);
    console.error(
      `[SwapShield] Oracle conversion failed on chain ${chainId}: ` +
      convertErrMsg.slice(0, 200),
    );
    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: true,
      code: "ORACLE_ERROR",
      reason:
        `Oracle check failed on chain ${chainId}. ` +
        `Swap Shield cannot verify this quote — proceeding without oracle protection.`,
    };
  }
  }

  // Oracle returned 0 — can't compare meaningfully
  if (oracleAmountRaw === 0n) {
    console.warn("[SwapShield] Oracle returned 0 — skipping comparison");
    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      deltaBps: 0,
      priceFeedExists: true,
      code: "ORACLE_ERROR",
      reason: "Oracle returned zero amount — cannot verify quote.",
    };
  }

  // ── Calculate signed divergence directly from expected output ──
  // divergenceBps = (oracleAmount - dexExpectedOut) * 10000 / oracleAmount
  //   > 0  => DEX gives less than oracle (potentially bad)
  //   < 0  => DEX gives more than oracle (potentially suspiciously favorable)
  //
  // NOTE: divergenceBps is kept for display/logging only (truncated toward zero is fine for
  // human-readable output). The actual threshold checks below use cross-multiplication to avoid
  // integer-division truncation — e.g., 5.009% would truncate to 5.00% bps and bypass the 5%
  // block if we compared the divided result directly.
  const divergenceBps =
    ((oracleAmountRaw - dexExpectedOutRaw) * 10000n) / oracleAmountRaw;
  const divergencePctDisplay = formatBpsAsPct(divergenceBps);
  const normalizedMaxDivergencePct = Number.isFinite(maxDivergencePct)
    ? Math.min(MAX_TEMP_DIVERGENCE_PCT, Math.max(0, maxDivergencePct))
    : DEFAULT_MAX_DIVERGENCE_PCT;
  const maxDivergenceBps = BigInt(Math.round(normalizedMaxDivergencePct * 100));

  console.log(
    `[SwapShield] Comparison: oracle=${oracleAmountRaw} dexExpected=${dexExpectedOutRaw} ` +
    `divergence=${divergencePctDisplay}% ` +
    `(tolerance=±${normalizedMaxDivergencePct}%)`,
  );

  // ── Enforce threshold (cross-multiplication — no division, no truncation) ──
  // Equivalent to divergenceBps > maxDivergenceBps, but exact:
  //   (oracle - dex) * 10000 > maxDivBps * oracle
  if (
    oracleAmountRaw > dexExpectedOutRaw &&
    (oracleAmountRaw - dexExpectedOutRaw) * 10000n > maxDivergenceBps * oracleAmountRaw
  ) {
    console.warn(
      `[SwapShield] ✗ BLOCKED: DEX quote diverges ${divergencePctDisplay}% from oracle ` +
      `(max allowed: ${normalizedMaxDivergencePct}%)`,
    );
    return {
      allowed: false,
      verified: true,
      oracleAmount: oracleAmountRaw.toString(),
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: divergencePctDisplay,
      deltaBps: Number(divergenceBps),
      priceFeedExists: true,
      code: "BLOCKED",
      reason:
        `⚠️ Swap Shield blocked: the DEX quote diverges ${divergencePctDisplay}% from the oracle spot price ` +
        `(max allowed: ${normalizedMaxDivergencePct}%). ` +
        `This likely indicates significant price impact, a bad route, or stale liquidity.\n\n` +
        `To proceed anyway, you can temporarily raise the tolerance (up to 50% for 10 min): "set swap shield tolerance to 30%"\n` +
        `Or split the trade into smaller amounts using a TWAP order to reduce price impact.`,
    };
  }

  // Block if DEX diverges beyond tolerance in the favorable direction too.
  // Unified tolerance: the same maxDivergencePct applies to both worse-than-oracle
  // and better-than-oracle quotes. This is simpler for operators and still safe
  // because the NAV shield (10% max loss) runs independently.
  if (dexExpectedOutRaw > oracleAmountRaw) {
    const favorableBps = -divergenceBps;
    const favorablePctDisplay = formatBpsAsPct(favorableBps);
    if ((dexExpectedOutRaw - oracleAmountRaw) * 10000n > maxDivergenceBps * oracleAmountRaw) {
      console.warn(
        `[SwapShield] ✗ BLOCKED: DEX quote ${favorablePctDisplay}% BETTER than oracle — ` +
        `exceeds ±${normalizedMaxDivergencePct}% tolerance`,
      );
      return {
        allowed: false,
        verified: true,
        oracleAmount: oracleAmountRaw.toString(),
        dexAmount: dexExpectedOutRaw.toString(),
        divergencePct: divergencePctDisplay,
        deltaBps: Number(divergenceBps),
        priceFeedExists: true,
        code: "BLOCKED",
        reason:
          `⚠️ Swap Shield blocked: the DEX quote is ${favorablePctDisplay}% better than the oracle spot price, ` +
          `exceeding the ${normalizedMaxDivergencePct}% tolerance. ` +
          `This may indicate a stale oracle or manipulated route.\n\n` +
          `To proceed anyway, temporarily raise the tolerance (up to 50% for 10 min): "set swap shield tolerance to 30%"`,
      };
    }
  }

  console.log(
    `[SwapShield] ✓ ALLOWED: divergence ${divergencePctDisplay}% within ±${normalizedMaxDivergencePct}% tolerance`,
  );

  return {
    allowed: true,
    verified: true,
    oracleAmount: oracleAmountRaw.toString(),
    dexAmount: dexExpectedOutRaw.toString(),
    divergencePct: divergencePctDisplay,
    deltaBps: Number(divergenceBps),
    priceFeedExists: true,
  };
}

// ── Opt-out helpers ──────────────────────────────────────────────────

/**
 * Get the temporary swap shield tolerance override for this operator.
 * Returns the tolerance percentage (e.g. 30 for 30%) if active, null otherwise.
 */
export async function getSwapShieldTolerance(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<number | null> {
  const key = `${SWAP_SHIELD_TOLERANCE_PREFIX}${operatorAddress.toLowerCase()}`;
  const val = await kv.get(key);
  if (!val) return null;
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0.5 || num > MAX_TEMP_DIVERGENCE_PCT) return null;
  return num;
}

/**
 * Temporarily set a higher swap shield tolerance (10-minute TTL).
 * @param tolerancePct - Maximum allowed divergence from oracle (e.g. 30 for 30%)
 */
export async function setSwapShieldTolerance(
  kv: KVNamespace,
  operatorAddress: string,
  tolerancePct: number,
): Promise<void> {
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0.5 || tolerancePct > MAX_TEMP_DIVERGENCE_PCT) {
    throw new Error(
      `Swap shield tolerance must be between 0.5% and ${MAX_TEMP_DIVERGENCE_PCT}%. ` +
      `Received: ${tolerancePct}%`,
    );
  }
  const key = `${SWAP_SHIELD_TOLERANCE_PREFIX}${operatorAddress.toLowerCase()}`;
  await kv.put(key, String(tolerancePct), { expirationTtl: SWAP_SHIELD_TOLERANCE_TTL });
  console.log(
    `[SwapShield] Tolerance set to ${tolerancePct}% for ${operatorAddress} (10 min TTL)`,
  );
}

/**
 * Clear the temporary tolerance override (reset to default 5%).
 */
export async function clearSwapShieldTolerance(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<void> {
  const key = `${SWAP_SHIELD_TOLERANCE_PREFIX}${operatorAddress.toLowerCase()}`;
  await kv.delete(key);
  console.log(
    `[SwapShield] Tolerance reset to default for ${operatorAddress}`,
  );
}

// ── Slippage KV helpers ──────────────────────────────────────────────

const SLIPPAGE_KEY_PREFIX = "slippage:";

/** Minimum allowed slippage: 0.1% (10 bps) */
export const MIN_SLIPPAGE_BPS = 10;
/** Maximum allowed slippage: 5% (500 bps) */
export const MAX_SLIPPAGE_BPS = 500;
/** Default slippage: 1% (100 bps) */
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * Read the operator's stored default slippage from KV.
 * Returns null if not set (caller should use DEFAULT_SLIPPAGE_BPS).
 */
export async function getStoredSlippage(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<number | null> {
  const raw = await kv.get(`${SLIPPAGE_KEY_PREFIX}${operatorAddress.toLowerCase()}`);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const val = Number(raw);
  if (!Number.isInteger(val) || val < MIN_SLIPPAGE_BPS || val > MAX_SLIPPAGE_BPS) return null;
  return val;
}

/**
 * Store the operator's default slippage in KV (persistent).
 */
export async function setStoredSlippage(
  kv: KVNamespace,
  operatorAddress: string,
  slippageBps: number,
): Promise<void> {
  if (!Number.isFinite(slippageBps) || !Number.isInteger(slippageBps)) {
    throw new Error("Slippage must be an integer number of basis points.");
  }
  if (slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage must be between ${MIN_SLIPPAGE_BPS / 100}% (${MIN_SLIPPAGE_BPS} bps) ` +
      `and ${MAX_SLIPPAGE_BPS / 100}% (${MAX_SLIPPAGE_BPS} bps).`,
    );
  }
  await kv.put(
    `${SLIPPAGE_KEY_PREFIX}${operatorAddress.toLowerCase()}`,
    String(slippageBps),
  );
}


