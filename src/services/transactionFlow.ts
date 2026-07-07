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
import { executeTxList } from "./execution.js";

export type ExecutionModePreference = "autonomous" | "confirm";

export interface TransactionFlowResult {
  kind: "executed" | "pending_confirmation";
  /** Present when kind === "executed". */
  outcomes?: TxExecOutcome[];
  /** Present when kind === "pending_confirmation". */
  transactions?: UnsignedTransaction[];
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

  // Confirm mode: hand off to the channel hook. The engine does not execute.
  await hooks.requestConfirmation(transactions, { reply: baseReply });
  return { kind: "pending_confirmation", transactions, reply: baseReply };
}
