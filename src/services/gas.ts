/**
 * Gas fee estimation, transaction simulation, and revert decoding with safety caps.
 *
 * Single source of truth for EIP-1559 fee estimation, gas unit estimation,
 * and parsing common simulation revert reasons. All chains use the same code
 * path; only the per-chain caps differ.
 */

import { parseGwei, formatGwei, type PublicClient, type Chain, type Hex } from "viem";

/**
 * Hard caps on gas fees to protect agent wallet balances and the paymaster.
 * These are absolute maximums — the agent will NEVER pay more than this.
 *
 * The priority fee cap is the safety net against rogue values from
 * estimateMaxPriorityFeePerGas(). Unlike baseFee (set by protocol, only burned),
 * the priority fee is fully paid to the block builder — so a rogue high value
 * directly drains the agent wallet. These caps ensure bounded worst-case cost
 * even if the RPC returns an absurd priority fee estimate.
 *
 * Mainnet uses a small, fixed-ish priority fee cap (0.01 gwei) because it is a
 * minimal part of the total fee and we want fast inclusion. Other chains use the
 * RPC-estimated priority fee, clamped to their cap.
 */
export const GAS_CAPS: Record<number, { maxFeePerGas: bigint; maxPriorityFee: bigint }> = {
  1:        { maxFeePerGas: parseGwei("5"),    maxPriorityFee: parseGwei("0.01") },
  10:       { maxFeePerGas: parseGwei("0.04"), maxPriorityFee: parseGwei("0.01") },
  56:       { maxFeePerGas: parseGwei("0.2"),  maxPriorityFee: parseGwei("0.1") },
  130:      { maxFeePerGas: parseGwei("0.04"), maxPriorityFee: parseGwei("0.01") },
  137:      { maxFeePerGas: parseGwei("500"),  maxPriorityFee: parseGwei("100") },
  8453:     { maxFeePerGas: parseGwei("0.04"), maxPriorityFee: parseGwei("0.01") },
  42161:    { maxFeePerGas: parseGwei("0.04"), maxPriorityFee: parseGwei("0.01") },
  // Testnets
  11155111: { maxFeePerGas: parseGwei("10"),    maxPriorityFee: parseGwei("0.1") },
  84532:    { maxFeePerGas: parseGwei("1"),    maxPriorityFee: parseGwei("0.01") },
};

const BASE_FEE_MULTIPLIER = 1.5;

/** Default fee bump percentage for transaction replacement. */
export const RESUBMIT_FEE_BUMP_PCT = 15n; // 15% bump

export interface GasFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface StoredGasFees {
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
}

/**
 * Estimate EIP-1559 fees and clamp to chain-specific caps.
 *
 * Uses viem's estimateFeesPerGas with a 1.5x base-fee multiplier so the
 * transaction remains valid even if the base fee rises over the next few
 * blocks. All chains follow the same path; differences are only in the caps.
 *
 * Throws if the RPC cannot return a valid fee estimate. No fallback: if the
 * fee market is unreadable, the transaction should not be prepared.
 */
export async function estimateGasFees(
  publicClient: PublicClient,
  chainId: number,
): Promise<GasFees> {
  const caps = GAS_CAPS[chainId];
  if (!caps) {
    throw new Error(`Unsupported chain ID: ${chainId}. Gas fee caps are not configured for this chain.`);
  }

  // Apply a 1.5x multiplier to the base fee via the chain config so the
  // transaction is likely to be included even if the base fee rises over the
  // next few blocks. This is the only place where we tune the fee estimate.
  const chain = publicClient.chain;
  const chainWithMultiplier: Chain = {
    ...chain,
    fees: {
      ...chain?.fees,
      baseFeeMultiplier: BASE_FEE_MULTIPLIER,
    },
  } as Chain;

  const estimated = await publicClient.estimateFeesPerGas({ chain: chainWithMultiplier });

  if (
    !estimated ||
    typeof estimated.maxFeePerGas !== "bigint" ||
    typeof estimated.maxPriorityFeePerGas !== "bigint"
  ) {
    throw new Error(`Chain ${chainId} returned an invalid EIP-1559 fee estimate.`);
  }

  let priorityFee = estimated.maxPriorityFeePerGas;
  if (priorityFee > caps.maxPriorityFee) {
    priorityFee = caps.maxPriorityFee;
  }

  let maxFee = estimated.maxFeePerGas;
  if (maxFee < priorityFee) {
    maxFee = priorityFee;
  }
  if (maxFee > caps.maxFeePerGas) {
    maxFee = caps.maxFeePerGas;
  }

  console.log(
    `[gas] Chain ${chainId}: maxFee=${formatGwei(maxFee)} gwei, ` +
      `priority=${formatGwei(priorityFee)} gwei ` +
      `(caps: ${formatGwei(caps.maxFeePerGas)} / ${formatGwei(caps.maxPriorityFee)} gwei)`,
  );

  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priorityFee };
}

/** Bump fees by RESUBMIT_FEE_BUMP_PCT (15%) for replacement, capped at chain limits. */
export function bumpGasFees(
  fees: GasFees,
  chainId: number,
  bumpPct = RESUBMIT_FEE_BUMP_PCT,
): GasFees {
  const caps = GAS_CAPS[chainId];
  if (!caps) {
    throw new Error(`Unsupported chain ID: ${chainId}. Cannot bump fees for an unconfigured chain.`);
  }

  const bumpedMaxFee = fees.maxFeePerGas + (fees.maxFeePerGas * bumpPct) / 100n;
  const bumpedPriority = fees.maxPriorityFeePerGas + (fees.maxPriorityFeePerGas * bumpPct) / 100n;

  return {
    maxFeePerGas: bumpedMaxFee < caps.maxFeePerGas ? bumpedMaxFee : caps.maxFeePerGas,
    maxPriorityFeePerGas: bumpedPriority < caps.maxPriorityFee ? bumpedPriority : caps.maxPriorityFee,
  };
}

/** Clamp a fee estimate to the chain-specific caps and ensure maxFee >= priorityFee. */
export function clampGasFees(
  fees: GasFees,
  chainId: number,
): GasFees {
  const caps = GAS_CAPS[chainId];
  if (!caps) return fees;

  const priority = fees.maxPriorityFeePerGas < caps.maxPriorityFee
    ? fees.maxPriorityFeePerGas
    : caps.maxPriorityFee;

  let maxFee = fees.maxFeePerGas;
  if (maxFee < priority) maxFee = priority;
  if (maxFee > caps.maxFeePerGas) maxFee = caps.maxFeePerGas;

  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

/**
 * Extract and validate the EIP-1559 fee fields stored on an unsigned transaction.
 * Returns the fees as bigints, clamped to the chain caps. Throws if either field
 * is missing — a finalized transaction must always carry a fee estimate.
 */
export function getTransactionFees(
  tx: { maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex },
  chainId: number,
): GasFees {
  if (!tx.maxFeePerGas || !tx.maxPriorityFeePerGas) {
    throw new Error(`Gas fee estimate is missing for this transaction. Rebuild the transaction to estimate fees.`);
  }
  return clampGasFees(
    {
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    },
    chainId,
  );
}


