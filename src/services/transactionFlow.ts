/**
 * TransactionFlow — unified execution-mode engine for web, Telegram, and tools.
 *
 * Responsibilities:
 *   1. Read the operator's execution-mode preference from a single KV key shared
 *      by all channels (`operator-pref:{operator}:exec-mode`).
 *   2. Decide whether to auto-execute (autonomous) or request confirmation.
 *   3. Run the shared safety stack (`executeTxList`) when auto-executing.
 *
 * Web, Telegram, and `/api/tools` all call this engine. Each channel implements
 * only the rendering/confirmation hooks.
 */

import type { Env, UnsignedTransaction } from "../types.js";
import type { TxExecOutcome } from "./execution.js";
import { executeTxList, storePendingSimulation } from "./execution.js";
import { ExecutionError } from "./executionError.js";

export type ExecutionModePreference = "autonomous" | "confirm";

export interface TransactionFlowResult {
  kind: "executed" | "pending_confirmation";
  /** Present when kind === "executed". */
  outcomes?: TxExecOutcome[];
  /** Present when kind === "pending_confirmation". */
  transactions?: UnsignedTransaction[];
  /**
   * Present when kind === "pending_confirmation". The frontend/Telegram must
   * send this operationId back (with confirmExecution:true) to execute the exact
   * stored simulation without re-running the LLM.
   */
  operationId?: string;
  /** Human-facing summary or confirmation prompt. */
  reply: string;
}

export interface ExecutionHooks {
  /** Called when the operator is in confirm mode. The hook should render the
   *  confirmation UI and return promptly; it must NOT execute the transactions. */
  requestConfirmation(txs: UnsignedTransaction[], ctx: { reply: string }): Promise<void>;
  /** Optional progress callback during autonomous execution. */
  onProgress?(event: ExecutionProgressEvent): Promise<void>;
  /** Optional completion callback during autonomous execution. */
  onComplete?(outcomes: TxExecOutcome[]): Promise<void>;
}

export interface ExecutionProgressEvent {
  type: "start" | "step" | "done";
  index?: number;
  total?: number;
  description?: string;
}

/** KV key for the operator's execution-mode preference. */
export function getOperatorExecModeKey(operatorAddress: string): string {
  return `operator-pref:${operatorAddress.toLowerCase()}:exec-mode`;
}

/** Read the operator's execution-mode preference. Defaults to "confirm". */
export async function getExecutionModePreference(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<ExecutionModePreference> {
  const raw = await kv.get(getOperatorExecModeKey(operatorAddress));
  return raw === "autonomous" ? "autonomous" : "confirm";
}

/** Persist the operator's execution-mode preference. */
export async function setExecutionModePreference(
  kv: KVNamespace,
  operatorAddress: string,
  mode: ExecutionModePreference,
): Promise<void> {
  await kv.put(getOperatorExecModeKey(operatorAddress), mode);
}

/**
 * Ensure every transaction is executable via delegation. Non-executable
 * results (operatorOnly, failed simulation, missing gas/fees, or skipped NAV
 * shield) are rejected here so the chat can surface a clear error instead of
 * confusing "gas missing" failures later.
 */
function assertExecutableTransactions(txs: UnsignedTransaction[]): void {
  for (const tx of txs) {
    const label = tx.description || "Transaction";

    // Pre-validate each executable field individually so callers get a clear
    // error and we can diagnose which step failed in production.
    // NOTE: maxPriorityFeePerGas may legitimately be 0x0 on chains like Arbitrum
    // that do not use priority fees. We only check that the field is present.
    const missingGas = !tx.gas || tx.gas === "0x0";
    const missingMaxFee = !tx.maxFeePerGas || tx.maxFeePerGas === "0x0";
    const missingPriorityFee = !tx.maxPriorityFeePerGas;
    const missingNav = !tx.navShieldChecked;

    if (missingGas || missingMaxFee || missingPriorityFee || missingNav) {
      console.error(
        `[transactionFlow] Pre-validation failed for "${label}": ` +
        `gas=${tx.gas}, maxFeePerGas=${tx.maxFeePerGas}, maxPriorityFeePerGas=${tx.maxPriorityFeePerGas}, navShieldChecked=${tx.navShieldChecked}`
      );
    }

    if (tx.operatorOnly) {
      throw new ExecutionError(
        `"${label}" requires the vault owner to sign directly from their wallet.`,
        "OPERATOR_ONLY",
        true,
      );
    }

    if (tx.revertWarning) {
      throw new ExecutionError(
        `"${label}" simulation failed: ${tx.revertWarning}`,
        "SIMULATION_FAILED",
        true,
      );
    }

    if (!tx.gas || tx.gas === "0x0") {
      throw new ExecutionError(
        `"${label}" is missing a gas limit. The preparation step failed to estimate gas.`,
        "GAS_ESTIMATION_FAILED",
        true,
      );
    }

    if (!tx.maxFeePerGas || tx.maxFeePerGas === "0x0") {
      throw new ExecutionError(
        `"${label}" is missing a max fee per gas. The preparation step failed to estimate fees.`,
        "GAS_ESTIMATION_FAILED",
        true,
      );
    }

    if (!tx.maxPriorityFeePerGas) {
      throw new ExecutionError(
        `"${label}" is missing a max priority fee per gas. The preparation step failed to estimate fees.`,
        "GAS_ESTIMATION_FAILED",
        true,
      );
    }

    if (!tx.navShieldChecked) {
      throw new ExecutionError(
        `"${label}" has not passed NAV-shield verification. The preparation step skipped the NAV check.`,
        "NAV_SHIELD_INCOMPLETE",
        true,
      );
    }
  }
}

/**
 * Run the unified transaction flow.
 *
 * @param env Worker environment (must include KV and RPC credentials).
 * @param operatorAddress Vault owner address (lowercased internally).
 * @param vaultAddress Vault address the transactions target.
 * @param transactions Unsigned transactions produced by `processChat`.
 * @param baseReply Human-friendly reply from the tool handler (e.g. "✅ NAV sync ready...").
 * @param hooks Channel-specific rendering hooks.
 * @returns A result describing either executed outcomes or pending confirmation.
 */
export async function runTransactionFlow(
  env: Env,
  operatorAddress: string,
  vaultAddress: string,
  transactions: UnsignedTransaction[],
  baseReply: string,
  hooks: ExecutionHooks,
  modeOverride?: ExecutionModePreference,
  requestCache?: Map<string, Promise<{ unitaryValue: bigint; totalValue: bigint; timestamp: bigint }>>,
): Promise<TransactionFlowResult> {
  if (transactions.length === 0) {
    return { kind: "pending_confirmation", transactions: [], reply: baseReply };
  }

  const mode = modeOverride ?? await getExecutionModePreference(env.KV, operatorAddress);

  if (mode === "autonomous") {
    // Autonomous mode: execute immediately through the shared safety stack.
    const executableTxs = transactions.filter(tx => !tx.operatorOnly);
    if (executableTxs.length === 0) {
      return { kind: "pending_confirmation", transactions, reply: baseReply };
    }

    await hooks.onProgress?.({ type: "start", total: executableTxs.length });

    const outcomes = await executeTxList(env, executableTxs, vaultAddress, async (idx, total) => {
      await hooks.onProgress?.({
        type: "step",
        index: idx,
        total,
        description: executableTxs[idx]?.description,
      });
    }, requestCache);

    await hooks.onComplete?.(outcomes);

    // Return outcomes even if some (or all) failed — the channel formatter
    // surfaces per-transaction errors and success states to the user.
    return { kind: "executed", outcomes, reply: baseReply };
  }

  // Confirm mode: operatorOnly transactions can never be agent-executed — the
  // vault owner must sign them directly from their wallet (e.g. pool
  // deployment, where msg.sender becomes the pool owner). They are returned
  // for direct wallet signing; only the delegated transactions go through the
  // executable assertion and the stored confirmation bundle. Mixing them into
  // the stored bundle would let the agent sign a deployment, making the AGENT
  // the pool owner — so they are filtered out before storePendingSimulation.
  const executableTxs = transactions.filter(tx => !tx.operatorOnly);

  if (executableTxs.length === 0) {
    // Nothing the agent can execute — the channel renders the transactions
    // for direct wallet signing (web wallet modal / manual instructions).
    return { kind: "pending_confirmation", transactions, reply: baseReply };
  }

  // Confirm mode: reject non-executable delegated txs early, store the
  // executable bundle in KV, and return an operationId for confirmation.
  assertExecutableTransactions(executableTxs);

  const operationId = await storePendingSimulation(
    env.KV,
    vaultAddress,
    baseReply,
    executableTxs,
    operatorAddress,
  );

  await hooks.requestConfirmation(executableTxs, { reply: baseReply });
  return { kind: "pending_confirmation", transactions, operationId, reply: baseReply };
}
