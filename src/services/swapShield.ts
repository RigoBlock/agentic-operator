/**
 * Swap Shield — oracle-protected swap validation.
 *
 * Compares DEX API quotes against on-chain oracle (BackgeoOracle) TWAP prices
 * via the vault's `convertTokenAmount()` extension. Blocks swaps where the DEX
 * quote diverges more than the configured `maxDivergencePct` threshold from the oracle price.
 *
 * ## How it works
 *
 * 1. Call `vault.convertTokenAmount(tokenIn, amountIn, tokenOut)` via `eth_call`
 *    — this uses the BackgeoOracle TWAP (up to 5-minute window) to compute the
 *      oracle-derived expected output for the given input
 *    — routes through ETH internally when needed (token→ETH→targetToken)
 * 2. Compare oracle output vs DEX expected output
 * 3. If the DEX gives significantly less than the oracle predicts, block the swap
 *
 * ## Why convertTokenAmount() instead of direct oracle
 *
 * The vault's EOracle extension:
 * - Handles ETH routing automatically (any ERC-20 → any ERC-20 via ETH)
 * - Uses a 5-minute TWAP window (capped at oracle cardinality)
 * - Guaranteed coverage for tokens acquired via supported vault flows;
 *   tokens sent to the vault externally may still lack a price feed
 * - Single eth_call vs. manual PoolKey construction + observe() + tick math
 *
 * Direct oracle access (BackgeoOracle.observe()) can be added later for EOA
 * support using the same SwapShieldResult interface.
 *
 * ## Edge cases
 *
 * - **No price feed**: convertTokenAmount reverts (division by zero in
 *   _getSecondsAgos when cardinality=0). We catch this and return
 *   `code: 'NO_PRICE_FEED'` — the caller decides how to handle it.
 * - **Native ETH**: EOracle treats address(0) and WETH equivalently.
 *   We normalize ETH to address(0) before calling.
 * - **Zero amounts**: Skip the check (nothing to protect).
 * - **Token sold has no price feed but is in vault**: This can happen when
 *   tokens are sent to the vault externally. The check degrades gracefully.
 *
 * ## Divergence direction
 *
 * The rule is two-sided and asymmetric:
 * - BLOCK when the DEX gives >5% less than the oracle predicts (bad deal)
 * - BLOCK when the DEX gives >10% more than the oracle predicts (stale oracle
 *   or manipulated route — could expose vault to sandwich attacks)
 * - ALLOW quotes within these bounds (normal spread/slippage)
 *
 * ## Independence from NAV shield
 *
 * The swap shield is independent of the NAV shield. Both run on every swap.
 * The swap shield catches bad quotes BEFORE calldata is built (price-level).
 * The NAV shield catches excessive NAV impact AFTER calldata is built (value-level).
 * Either can block independently.
 */

import { type Address } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { getClient } from "./vault.js";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Default maximum allowed divergence from oracle price (5%).
 * Catches rogue quotes, API compromise, fat-finger errors, and extreme
 * low-liquidity routing without false-positiving on normal DEX spread.
 */
const DEFAULT_MAX_DIVERGENCE_PCT = 5;
const MAX_FAVORABLE_DIVERGENCE_PCT = 10;

/** Native ETH address (zero address) — EOracle treats this equivalently to WETH */
const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as Address;

/** Wrapped native token addresses per chain — mapped to address(0) for EOracle */
const WRAPPED_NATIVE_ADDRESSES: Record<number, string> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",     // Ethereum
  10: "0x4200000000000000000000000000000000000006",      // Optimism
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",     // BNB (WBNB)
  130: "0x4200000000000000000000000000000000000006",     // Unichain
  137: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",   // Polygon (WMATIC)
  8453: "0x4200000000000000000000000000000000000006",    // Base
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",  // Arbitrum
};

/** KV key prefix for swap shield opt-out */
const SWAP_SHIELD_DISABLED_PREFIX = "swap-shield-disabled:";

/** Opt-out TTL: 10 minutes */
const SWAP_SHIELD_DISABLE_TTL = 600;

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
 * Check if a swap quote from a DEX API diverges from the on-chain oracle price.
 *
 * @param vaultAddress - The vault contract address (has EOracle extension)
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
  vaultAddress: Address,
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountInRaw: bigint,
  dexExpectedOutRaw: bigint,
  _slippageBps: number,
  alchemyKey: string,
  maxDivergencePct: number = DEFAULT_MAX_DIVERGENCE_PCT,
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
      code: "INVALID_QUOTE",
      reason: "Invalid quote — negative input or expected output amount.",
    };
  }

  // Skip only for zero input amounts
  if (amountInRaw === 0n) {
    return {
      allowed: true,
      verified: false,
      // No oracle comparison performed — sentinel "0" signals absence of oracle data.
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      reason: "Zero input amount — skipping oracle check",
    };
  }

  // Zero expected output for non-zero input is an invalid quote and must be blocked.
  if (dexExpectedOutRaw === 0n) {
    return {
      allowed: false,
      verified: false,
      // No oracle comparison performed — sentinel "0" signals absence of oracle data.
      oracleAmount: "0",
      dexAmount: "0",
      divergencePct: "0",
      code: "INVALID_QUOTE",
      reason: "Invalid quote — expected output is zero for a non-zero input amount.",
    };
  }

  // Normalize native ETH and WETH to address(0) for EOracle
  const normalizedIn = normalizeTokenAddress(tokenIn, chainId);
  const normalizedOut = normalizeTokenAddress(tokenOut, chainId);

  // Same token after normalization — skip (wrap/unwrap)
  if (normalizedIn.toLowerCase() === normalizedOut.toLowerCase()) {
    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",       // sentinel: no oracle comparison performed
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      reason: "Same token (wrap/unwrap) — skipping oracle check",
    };
  }

  const publicClient = getClient(chainId, alchemyKey);

  // ── Call convertTokenAmount via eth_call ──
  let oracleAmountRaw: bigint;
  try {
    const result = await publicClient.readContract({
      address: vaultAddress,
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "convertTokenAmount",
      args: [normalizedIn, amountInRaw, normalizedOut],
    });

    oracleAmountRaw = result as bigint;

    // convertTokenAmount returns int256, but for a positive input amount the
    // output should always be non-negative. A negative return indicates an
    // unexpected condition (e.g. overflow, adapter bug) — fail CLOSED to
    // ORACLE_ERROR rather than silently flip the sign, which could bypass
    // the divergence threshold if the semantics are inverted.
    if (oracleAmountRaw < 0n) {
      console.error(
        `[SwapShield] convertTokenAmount returned a negative amount (${oracleAmountRaw}) ` +
        `for positive input ${amountInRaw} on chain ${chainId} — treating as ORACLE_ERROR`,
      );
      return {
        allowed: true,
        verified: false,
        oracleAmount: "0",
        dexAmount: dexExpectedOutRaw.toString(),
        divergencePct: "0",
        code: "ORACLE_ERROR",
        reason:
          `Oracle returned an invalid (negative) amount on chain ${chainId}. ` +
          `Swap Shield cannot verify this quote — proceeding without oracle protection.`,
      };
    }

    console.log(
      `[SwapShield] Oracle: ${amountInRaw} tokenIn → ${oracleAmountRaw} tokenOut ` +
      `(chain=${chainId})`,
    );
  } catch (convertErr) {
    const convertErrMsg = convertErr instanceof Error ? convertErr.message : String(convertErr);
    // convertTokenAmount reverted. Use hasPriceFeed to distinguish:
    //   • Feed genuinely absent    → NO_PRICE_FEED (graceful degradation)
    //   • Vault has no EOracle ext → ORACLE_ERROR
    //   • Any other unexpected revert after confirming feeds exist → ORACLE_ERROR
    // This avoids fragile string-matching and correctly classifies vaults
    // that do not implement the EOracle extension as ORACLE_ERROR rather than
    // silently claiming the feed is missing.
    try {
      const [tokenInHasFeed, tokenOutHasFeed] = (await Promise.all([
        publicClient.readContract({
          address: vaultAddress,
          abi: RIGOBLOCK_VAULT_ABI,
          functionName: "hasPriceFeed",
          args: [normalizedIn],
        }),
        publicClient.readContract({
          address: vaultAddress,
          abi: RIGOBLOCK_VAULT_ABI,
          functionName: "hasPriceFeed",
          args: [normalizedOut],
        }),
      ])) as [boolean, boolean];

      if (!tokenInHasFeed || !tokenOutHasFeed) {
        const missingToken = !tokenInHasFeed ? normalizedIn : normalizedOut;
        console.warn(
          `[SwapShield] ⚠ No oracle price feed for token ${missingToken} on chain ${chainId}`,
        );
        return {
          allowed: true,
          verified: false,
          oracleAmount: "0",
          dexAmount: dexExpectedOutRaw.toString(),
          divergencePct: "0",
          code: "NO_PRICE_FEED",
          reason:
            `Oracle price feed not available for this token pair on chain ${chainId}. ` +
            `Swap Shield cannot verify this quote — proceeding without oracle protection.`,
        };
      }

      // hasPriceFeed returned true but convertTokenAmount still reverted —
      // unexpected condition (e.g. cardinality too low, pool not initialized).
      console.error(
        `[SwapShield] convertTokenAmount reverted despite feeds reporting available on chain ${chainId}: ` +
        convertErrMsg.slice(0, 200),
      );
    } catch (feedErr) {
      // hasPriceFeed itself reverted — vault likely does not implement EOracle extension,
      // or the RPC is down / wrong chain. Both cases should NOT be treated as missing feed.
      const feedErrMsg = feedErr instanceof Error ? feedErr.message : String(feedErr);
      console.error(
        `[SwapShield] hasPriceFeed call failed — vault may not implement EOracle on chain ${chainId}: ` +
        feedErrMsg.slice(0, 200),
      );
    }

    return {
      allowed: true,
      verified: false,
      oracleAmount: "0",
      dexAmount: dexExpectedOutRaw.toString(),
      divergencePct: "0",
      code: "ORACLE_ERROR",
      reason:
        `Oracle check failed on chain ${chainId}. ` +
        `Swap Shield cannot verify this quote — proceeding without oracle protection.`,
    };
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
      code: "ORACLE_ERROR",
      reason: "Oracle returned zero amount — cannot verify quote.",
    };
  }

  // ── Calculate signed divergence directly from expected output ──
  // divergenceBps = (oracleAmount - dexExpectedOut) * 10000 / oracleAmount
  //   > 0  => DEX gives less than oracle (potentially bad)
  //   < 0  => DEX gives more than oracle (potentially suspiciously favorable)
  const divergenceBps =
    ((oracleAmountRaw - dexExpectedOutRaw) * 10000n) / oracleAmountRaw;
  const divergencePctDisplay = formatBpsAsPct(divergenceBps);
  const normalizedMaxDivergencePct = Number.isFinite(maxDivergencePct)
    ? Math.max(0, maxDivergencePct)
    : DEFAULT_MAX_DIVERGENCE_PCT;
  const maxDivergenceBps = BigInt(Math.round(normalizedMaxDivergencePct * 100));
  const maxFavorableDivergenceBps = BigInt(MAX_FAVORABLE_DIVERGENCE_PCT * 100);

  console.log(
    `[SwapShield] Comparison: oracle=${oracleAmountRaw} dexExpected=${dexExpectedOutRaw} ` +
    `divergence=${divergencePctDisplay}% ` +
    `(max=${normalizedMaxDivergencePct}%)`,
  );

  // ── Enforce threshold ──
  if (divergenceBps > maxDivergenceBps) {
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
      code: "BLOCKED",
      reason:
        `⚠️ Swap Shield blocked: the DEX quote diverges ${divergencePctDisplay}% from the oracle price ` +
        `(max allowed: ${normalizedMaxDivergencePct}%). ` +
        `This likely indicates significant price impact, a bad route, or stale liquidity.\n\n` +
        `To proceed anyway, you can temporarily disable the swap shield (10 min): "disable swap shield"\n` +
        `Or split the trade into smaller amounts using a TWAP order to reduce price impact.`,
    };
  }

  // Block if DEX is suspiciously favorable (>10% better than oracle)
  // This catches stale oracle prices or manipulated DEX routes.
  if (divergenceBps < 0n) {
    const favorableBps = -divergenceBps;
    const favorablePctDisplay = formatBpsAsPct(favorableBps);
    if (favorableBps > maxFavorableDivergenceBps) {
      console.warn(
        `[SwapShield] ✗ BLOCKED: DEX quote ${favorablePctDisplay}% BETTER than oracle — ` +
        `likely stale oracle or manipulated route`,
      );
      return {
        allowed: false,
        verified: true,
        oracleAmount: oracleAmountRaw.toString(),
        dexAmount: dexExpectedOutRaw.toString(),
        // divergencePctDisplay already carries the leading minus for negative bps;
        // using it directly avoids a double-sign like "--20.00".
        divergencePct: divergencePctDisplay,
        code: "BLOCKED",
        reason:
          `⚠️ Swap Shield blocked: the DEX quote is ${favorablePctDisplay}% better than the oracle price. ` +
          `This likely indicates a stale oracle or manipulated route — proceeding could expose ` +
          `the vault to a sandwich attack.\n\n` +
          `To proceed anyway, you can temporarily disable the swap shield (10 min): "disable swap shield"`,
      };
    }
  }

  console.log(
    `[SwapShield] ✓ ALLOWED: divergence ${divergencePctDisplay}% within ${normalizedMaxDivergencePct}% limit`,
  );

  return {
    allowed: true,
    verified: true,
    oracleAmount: oracleAmountRaw.toString(),
    dexAmount: dexExpectedOutRaw.toString(),
    divergencePct: divergencePctDisplay,
  };
}

// ── Opt-out helpers ──────────────────────────────────────────────────

/**
 * Check if the swap shield is currently disabled for this operator+vault.
 * Returns true if disabled (opt-out active), false otherwise.
 */
export async function isSwapShieldDisabled(
  kv: KVNamespace,
  operatorAddress: string,
  vaultAddress: string,
): Promise<boolean> {
  const key = `${SWAP_SHIELD_DISABLED_PREFIX}${operatorAddress.toLowerCase()}:${vaultAddress.toLowerCase()}`;
  const val = await kv.get(key);
  return val !== null;
}

/**
 * Temporarily disable the swap shield (10-minute TTL).
 */
export async function disableSwapShield(
  kv: KVNamespace,
  operatorAddress: string,
  vaultAddress: string,
): Promise<void> {
  const key = `${SWAP_SHIELD_DISABLED_PREFIX}${operatorAddress.toLowerCase()}:${vaultAddress.toLowerCase()}`;
  await kv.put(key, String(Date.now()), { expirationTtl: SWAP_SHIELD_DISABLE_TTL });
  console.log(
    `[SwapShield] Disabled for ${operatorAddress} on vault ${vaultAddress} (10 min TTL)`,
  );
}

/**
 * Re-enable the swap shield (delete opt-out key).
 */
export async function enableSwapShield(
  kv: KVNamespace,
  operatorAddress: string,
  vaultAddress: string,
): Promise<void> {
  const key = `${SWAP_SHIELD_DISABLED_PREFIX}${operatorAddress.toLowerCase()}:${vaultAddress.toLowerCase()}`;
  await kv.delete(key);
  console.log(
    `[SwapShield] Re-enabled for ${operatorAddress} on vault ${vaultAddress}`,
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

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Normalize token address for EOracle:
 * - Native ETH (zero address or 0xEeee...) → address(0)
 * - WETH → address(0)
 * - Everything else → unchanged
 */
function normalizeTokenAddress(token: Address, chainId: number): Address {
  const lower = token.toLowerCase();

  // Zero address = native ETH
  if (lower === NATIVE_ETH) return NATIVE_ETH;

  // 0xEeee... convention used by some DEX APIs for native ETH
  if (lower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return NATIVE_ETH;

  // WETH/wrapped native on this chain → address(0)
  const weth = WRAPPED_NATIVE_ADDRESSES[chainId];
  if (weth && lower === weth.toLowerCase()) return NATIVE_ETH;

  return token;
}
