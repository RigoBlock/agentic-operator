/**
 * Gas fee estimation, transaction simulation, and revert decoding with safety caps.
 *
 * Single source of truth for EIP-1559 fee estimation, gas unit estimation,
 * and parsing common simulation revert reasons. All chains use the same code
 * path; only the per-chain caps differ.
 */

import { parseGwei, formatGwei, type PublicClient, type Chain, type Hex, type Address } from "viem";
import type { Env, RequestContext, TransactionDraft, UnsignedTransaction } from "../types.js";
import { sanitizeError, ZERO_ADDRESS } from "../config.js";
import { RIGOBLOCK_VAULT_ABI } from "../abi/rigoblockVault.js";
import { getDelegationConfig, getChainDelegation } from "./delegation.js";
import { checkNavImpact, getNavShieldThreshold } from "./navGuard.js";
import { getRpcProvider } from "./rpcClient.js";
import { decodeRevertData, getRevertDataFromError, extractRevertData } from "./errorDecoder.js";
import { ExecutionError } from "./executionError.js";

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

/**
 * Parse simulation revert messages to detect common ERC20/DEX token balance issues.
 * Returns a user-friendly message if detected, otherwise null.
 */
function parseSimulationRevert(raw: string): string | null {
  const lower = raw.toLowerCase();

  // Try to decode any raw revert hex data first — this gives the most precise reason.
  const revertData = extractRevertData(raw);
  if (revertData) {
    const decoded = decodeRevertData(revertData);
    if (decoded) {
      // Translate common decoded errors into actionable guidance.
      const decodedLower = decoded.toLowerCase();
      if (
        decodedLower.includes("erc20insufficientbalance") ||
        decodedLower.includes("toolittlereceived") ||
        decodedLower.includes("insufficientoutputamount") ||
        decodedLower.includes("safetransferfrom") ||
        decodedLower.includes("transfer amount exceeds")
      ) {
        return (
          "The vault does not hold enough of the sell token for this swap. " +
          "Check the vault's token balances and try a smaller amount."
        );
      }
      if (decodedLower.includes("transactiontooold") || decodedLower.includes("deadline")) {
        return "The swap quote has expired. Please request a fresh quote.";
      }
      if (
        decodedLower.includes("toomuchrequested") ||
        decodedLower.includes("slippage") ||
        decodedLower.includes("minimum amount")
      ) {
        return "The swap would result in too much slippage. Try again with a fresh quote or smaller amount.";
      }
      if (decodedLower.includes("notdelegated") || decodedLower.includes("unauthorized") || decodedLower.includes("onlyowner")) {
        return (
          "The agent wallet is not delegated for this swap selector on the vault. " +
          "Update your delegation settings, or sign this transaction directly from your wallet."
        );
      }
      return decoded;
    }
  }

  // Common ERC20 / Uniswap / 0x revert patterns indicating insufficient token balance
  if (
    lower.includes("stf") ||                             // Uniswap SafeTransferFrom
    lower.includes("transfer amount exceeds balance") ||
    lower.includes("transfer_from_failed") ||
    lower.includes("insufficient balance") ||
    lower.includes("erc20: transfer amount exceeds") ||
    lower.includes("safetransferfrom") ||
    lower.includes("subtraction overflow") ||             // balance underflow
    lower.includes("ds-math-sub-underflow") ||            // MakerDAO-style SafeMath
    lower.includes("not enough balance") ||
    lower.includes("exceeds allowance") ||                // approval-related
    lower.includes("v3_invalid_swap") ||                  // Uniswap V3 revert
    lower.includes("too little received")
  ) {
    return (
      "The vault does not hold enough of the sell token for this swap. " +
      "Check the vault's token balances and try a smaller amount."
    );
  }

  // Expired deadline
  if (lower.includes("transaction too old") || lower.includes("deadline")) {
    return "The swap quote has expired. Please request a fresh quote.";
  }

  // Slippage
  if (lower.includes("too much requested") || lower.includes("slippage") || lower.includes("minimum amount")) {
    return "The swap would result in too much slippage. Try again with a fresh quote or smaller amount.";
  }

  // GMX v2 acceptable price / execution price (includes "acceptable price", "execution price",
  // "empty primary price", "invalid primary price", and keeper-revert variants)
  if (
    lower.includes("acceptable price") ||
    lower.includes("execution price") ||
    lower.includes("empty primary price") ||
    lower.includes("invalid primary price") ||
    lower.includes("primary price") ||
    lower.includes("end of oracle")
  ) {
    return (
      "The GMX order could not be executed at the required price. " +
      "The oracle price moved beyond the 1% slippage bound before the keeper picked up the order. " +
      "Retry the order, or wait for less volatility."
    );
  }

  // Agent wallet has no ETH to cover gas (viem local pre-check before eth_call)
  if (lower.includes("total cost") && lower.includes("exceeds the balance")) {
    return (
      "Agent wallet has insufficient ETH for gas. " +
      "Enable gas sponsorship (Alchemy paymaster) or send a small amount of ETH to the agent wallet."
    );
  }

  return null;
}

/**
 * Shared transaction finalizer: run the NAV shield and estimate gas.
 *
 * This is the single place that turns a `TransactionDraft` into a full
 * `UnsignedTransaction`. For vault-targeted transactions, the NAV shield simulates
 * the swap via eth_simulateV1 and validates the post-swap unitary value does not
 * drop more than the allowed threshold. The operator may temporarily disable the
 * shield; in that case simulation is skipped but gas and fees are still estimated.
 * Gas units and EIP-1559 fees are estimated from the executor address in one
 * parallel pass, so every transaction (vault or not) leaves here with a real gas
 * estimate and bounded fees.
 *
 * Throws on any missing or invalid estimate; there is no fallback.
 */
export async function finalizeTransaction(
  env: Env,
  ctx: Pick<RequestContext, "vaultAddress" | "chainId" | "operatorAddress" | "operatorVerified" | "executionMode">,
  draft: TransactionDraft,
): Promise<{ tx: UnsignedTransaction; warning?: string }> {
  const tx: UnsignedTransaction = {
    ...draft,
    gas: "0x0",
    maxFeePerGas: "0x0",
    maxPriorityFeePerGas: "0x0",
    navShieldChecked: false,
  };
  const publicClient = getRpcProvider(tx.chainId);

  // Determine the operator/owner address for NAV shield threshold lookup.
  // If the caller didn't prove ownership, we read the on-chain owner.
  let operatorAddress: Address;
  if (ctx.operatorAddress) {
    operatorAddress = ctx.operatorAddress;
  } else {
    if (!ctx.vaultAddress || ctx.vaultAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new ExecutionError(
        "No operator address provided and no vault address configured for NAV simulation.",
        "VAULT_NOT_ON_CHAIN",
      );
    }
    try {
      operatorAddress = await publicClient.readContract({
        address: ctx.vaultAddress as Address,
        abi: RIGOBLOCK_VAULT_ABI,
        functionName: "owner",
      }) as Address;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (
        lower.includes("reverted") ||
        lower.includes("execution reverted") ||
        lower.includes("invalid") ||
        lower.includes("bad data") ||
        lower.includes("returned no data") ||
        lower.includes("no data") ||
        lower.includes("missing revert data") ||
        lower.includes("contract not found")
      ) {
        throw new ExecutionError(
          `Vault address ${ctx.vaultAddress.slice(0, 6)}…${ctx.vaultAddress.slice(-4)} is not a valid vault on chain ${tx.chainId}. ` +
          "The address may belong to a vault on another chain, or it may not be a vault contract.",
          "VAULT_NOT_ON_CHAIN",
        );
      }
      throw new ExecutionError(
        `Could not read vault owner for NAV simulation: ${sanitizeError(msg)}`,
        "RPC_UNAVAILABLE",
      );
    }
  }

  // Determine the transaction executor (sender for simulation / gas estimation).
  let executor: Address;
  if (tx.operatorOnly || ctx.executionMode === "manual") {
    executor = operatorAddress;
  } else {
    const config = await getDelegationConfig(env.KV, ctx.vaultAddress!);
    if (!config || !config.enabled) {
      throw new ExecutionError(
        "Delegation not configured. Set up delegation on the vault first.",
        "DELEGATION_NOT_CONFIGURED",
      );
    }
    executor = config.agentAddress;
  }

  const txValue = BigInt(tx.value || "0x0");

  // NAV shield only applies when the transaction targets the vault itself.
  const isVaultTarget = !!ctx.vaultAddress &&
    ctx.vaultAddress.toLowerCase() !== ZERO_ADDRESS &&
    tx.to.toLowerCase() === ctx.vaultAddress.toLowerCase();

  let navShieldWarning: string | undefined;
  if (isVaultTarget) {
    const storedNavThreshold = env.KV
      ? await getNavShieldThreshold(env.KV, operatorAddress)
      : null;

    const navResult = await checkNavImpact(
      ctx.vaultAddress as Address,
      tx.data,
      txValue,
      tx.chainId,
      executor,
      env.KV,
      storedNavThreshold ?? undefined,
    );

    if (!navResult.allowed) {
      if (navResult.code === "TRADE_REVERTS") {
        const warning = `⚠️ Simulation warning: ${navResult.reason || "transaction may revert on-chain"} — verify token approvals and vault adapter support before signing.`;
        tx.revertWarning = warning;
        tx.navShieldChecked = true;
        return { tx, warning };
      }
      throw new ExecutionError(
        navResult.reason || "Trade blocked by NAV protection — would reduce unit price too much",
        "NAV_SHIELD_BLOCKED",
      );
    }

    // When the operator intentionally disabled the NAV shield, proceed without a
    // warning so the execution UI stays normal (they were already warned once).
    // For other unverified cases, keep the warning but still estimate gas.
    if (navResult.code === "UNVERIFIED") {
      navShieldWarning = `⚠️ NAV verification unavailable — could not measure NAV impact atomically (${navResult.reason || "multicall simulation failed"}). Proceeding with gas estimate only.`;
    }

    tx.navShieldChecked = true;
  }

  // Estimate gas units and EIP-1559 fees directly from the executor for every transaction.
  // We use estimateGas (eth_estimateGas) because the agent builds raw calldata, not a
  // specific contract function with ABI. This single call both validates that the
  // transaction succeeds and returns the gas limit.
  let gasEstimate: bigint;
  let fees: GasFees;
  try {
    [gasEstimate, fees] = await Promise.all([
      publicClient.estimateGas({ account: executor, to: tx.to, data: tx.data, value: txValue }),
      estimateGasFees(publicClient, tx.chainId),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    // Reverts from eth_estimateGas are trade-level simulation failures.
    const isRevert =
      lower.includes("reverted") ||
      lower.includes("execution reverted") ||
      lower.includes("would revert");

    if (isRevert) {
      const revertData = getRevertDataFromError(err);
      const decoded = revertData ? decodeRevertData(revertData) : null;
      const friendly = decoded || parseSimulationRevert(msg);
      throw new ExecutionError(
        `Transaction simulation failed — the transaction would revert on-chain.${friendly ? ` ${friendly}` : ""}`,
        "SIMULATION_FAILED",
      );
    }

    // Anything else (RPC error, timeout, invalid fee market) is a gas-estimation failure.
    throw new ExecutionError(`Gas estimation failed: ${sanitizeError(msg)}`, "GAS_ESTIMATION_FAILED");
  }

  tx.gas = `0x${(gasEstimate + (gasEstimate * 25n) / 100n).toString(16)}`;
  tx.maxFeePerGas = `0x${fees.maxFeePerGas.toString(16)}` as Hex;
  tx.maxPriorityFeePerGas = `0x${fees.maxPriorityFeePerGas.toString(16)}` as Hex;

  // Non-vault transactions are not subject to the NAV shield.
  if (!isVaultTarget) {
    tx.navShieldChecked = true;
  }

  return { tx, ...(navShieldWarning ? { warning: navShieldWarning } : {}) };
}
