/**
 * Transaction preparation — run the safety stack once when the user prompts.
 *
 * Responsibilities:
 *   - Determine the executor (operator EOA or delegated agent wallet).
 *   - Run the NAV shield for vault-targeted transactions.
 *   - Estimate gas units and EIP-1559 fees from the executor address.
 *
 * This function does NOT read on-chain state that the tool handler has already
 * validated (vault owner, contract existence, etc.). It assumes the caller has
 * provided a valid RequestContext with operatorAddress and vaultAddress.
 */

import type { PublicClient, Hex, Address } from "viem";
import type { Env, RequestContext, TransactionDraft, UnsignedTransaction } from "../types.js";
import { ZERO_ADDRESS } from "../config.js";
import { getDelegationConfig } from "./delegation.js";
import { checkNavImpact, getNavShieldThreshold } from "./navGuard.js";
import { getRpcProvider } from "./rpcClient.js";
import { ExecutionError } from "./executionError.js";
import { estimateGasFees, type GasFees } from "./gas.js";

/**
 * Prepare a transaction for signing/broadcast.
 *
 * The returned `UnsignedTransaction` includes the executor (`from`), gas limit,
 * EIP-1559 fees, and the NAV-shield marker. The caller stores this exact object
 * server-side and replays it at execution time without re-estimating or
 * re-simulating.
 */
export async function prepareTransaction(
  env: Env,
  ctx: Pick<RequestContext, "vaultAddress" | "chainId" | "operatorAddress" | "operatorVerified" | "executionMode">,
  draft: TransactionDraft,
): Promise<{ tx: UnsignedTransaction; warning?: string }> {
  // Determine the executor (sender) before constructing the full transaction so
  // the `from` field is present from the start.
  let executor: Address;
  if (draft.operatorOnly || ctx.executionMode === "manual") {
    if (!ctx.operatorAddress) {
      throw new ExecutionError(
        "Operator address is required to prepare this transaction.",
        "OPERATOR_ADDRESS_REQUIRED",
      );
    }
    executor = ctx.operatorAddress;
  } else {
    if (!ctx.vaultAddress || ctx.vaultAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new ExecutionError(
        "Vault address is required to prepare a delegated transaction.",
        "VAULT_ADDRESS_REQUIRED",
      );
    }
    const config = await getDelegationConfig(env.KV, ctx.vaultAddress);
    if (!config || !config.enabled) {
      throw new ExecutionError(
        "Delegation not configured. Set up delegation on the vault first.",
        "DELEGATION_NOT_CONFIGURED",
      );
    }
    executor = config.agentAddress;
  }

  const tx: UnsignedTransaction = {
    ...draft,
    from: executor,
    gas: "0x0",
    maxFeePerGas: "0x0",
    maxPriorityFeePerGas: "0x0",
    navShieldChecked: false,
  };
  const publicClient = getRpcProvider(tx.chainId);
  const txValue = BigInt(tx.value || "0x0");

  // NAV shield only applies when the transaction targets the vault itself.
  const isVaultTarget = !!ctx.vaultAddress &&
    ctx.vaultAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
    tx.to.toLowerCase() === ctx.vaultAddress.toLowerCase();

  let navShieldWarning: string | undefined;
  if (isVaultTarget) {
    const storedNavThreshold = env.KV && ctx.operatorAddress
      ? await getNavShieldThreshold(env.KV, ctx.operatorAddress)
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

    if (navResult.code === "UNVERIFIED") {
      navShieldWarning = `⚠️ NAV verification unavailable — could not measure NAV impact atomically (${navResult.reason || "multicall simulation failed"}). Proceeding with gas estimate only.`;
    }

    tx.navShieldChecked = true;
  }

  // Estimate gas units and EIP-1559 fees directly from the executor. A revert here
  // is a trade-level failure and is surfaced directly so the tool handler can
  // translate it for the user.
  let gasEstimate: bigint;
  let fees: GasFees;
  try {
    [gasEstimate, fees] = await Promise.all([
      publicClient.estimateGas({ account: executor, to: tx.to, data: tx.data, value: txValue }),
      estimateGasFees(publicClient, tx.chainId),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ExecutionError(
      `Transaction preparation failed: ${msg}`,
      "PREPARATION_FAILED",
    );
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
