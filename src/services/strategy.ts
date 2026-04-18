/**
 * Generic strategy engine.
 *
 * Stores per-vault automated strategies in KV. A Cloudflare Cron Trigger
 * runs every 5 minutes — for each active strategy whose interval has elapsed,
 * the engine sends the strategy instruction through the LLM (processChat)
 * and forwards the recommendation to the operator via Telegram.
 *
 * The operator confirms by replying in Telegram, which flows through the
 * normal LLM chat pipeline for execution.
 *
 * Features:
 *   - Up to MAX_STRATEGIES_PER_VAULT (3) strategies per vault
 *   - Configurable interval (min MIN_INTERVAL_MINUTES = 5)
 *   - Natural language instructions (any strategy the LLM can handle)
 *   - Auto-pause after MAX_CONSECUTIVE_FAILURES (3) consecutive errors
 *   - Manual execution mode forced (never auto-executes)
 *
 * KV key: `strategies:{vaultAddress}` → Strategy[] (JSON array)
 */

import type { Env, ChatMessage, ChatResponse, RequestContext } from "../types.js";
import type { Address } from "viem";
import { getTelegramUserIdByAddress } from "./telegramPairing.js";
import { sendMessage } from "./telegram.js";
import type { TgInlineKeyboardMarkup } from "./telegram.js";
import { executeTxList, formatOutcomesMarkdown } from "./execution.js";
import { sanitizeError } from "../config.js";

/**
 * Clean up Telegram recommendation cache when strategies are removed.
 * Deletes `tg-strategy-rec:{userId}` so stale recommendations can't
 * be acted on after the underlying strategy is gone.
 */
async function cleanupTelegramStrategyCache(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<void> {
  try {
    const userId = await getTelegramUserIdByAddress(kv, operatorAddress);
    if (userId) {
      await kv.delete(`tg-strategy-rec:${userId}`);
    }
  } catch {
    // Non-critical — don't fail strategy removal if cache cleanup fails
  }
}

// ── Constants ─────────────────────────────────────────────────────────

export const MAX_STRATEGIES_PER_VAULT = 3;
export const MIN_INTERVAL_MINUTES = 5;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Max steps in a single autonomous strategy run (agentic loop) */
const MAX_STRATEGY_STEPS = 6;
/** Max recent events stored per vault */
const MAX_EVENTS = 20;
/** TTL for strategy events in KV (24 hours) */
const EVENTS_TTL = 24 * 60 * 60;

// ── Types ─────────────────────────────────────────────────────────────

export interface Strategy {
  /** Unique ID within a vault's strategy list (1, 2, 3) */
  id: number;
  /** Natural language instruction for the LLM */
  instruction: string;
  /** Interval between checks in minutes (min 5) */
  intervalMinutes: number;
  /** Vault address */
  vaultAddress: string;
  /** Chain ID (primary chain for the vault) */
  chainId: number;
  /** Operator wallet address */
  operatorAddress: string;
  /** Whether the strategy is active */
  active: boolean;
  /** When created (ms epoch) */
  createdAt: number;
  /** When last evaluated (ms epoch) */
  lastRun?: number;
  /** Consecutive LLM/network failures */
  consecutiveFailures: number;
  /** Last error message (for diagnostics) */
  lastError?: string;
  /** When true, the agent executes transactions immediately without operator confirmation */
  autoExecute?: boolean;
  /** LLM recommendation from the last run (carried forward as context for the next run) */
  lastRecommendation?: string;
  /** Max number of cron runs before auto-removal. undefined = unlimited (recurring). */
  maxExecutions?: number;
  /** Number of cron runs so far (incremented on every run, not just when transactions execute). */
  executionCount?: number;
  /** Set when the LLM signals "STRATEGY COMPLETE:" — strategy goal reached, auto-remove. */
  completedAt?: number;
}

/** A compact event record for strategy runs, stored in KV for web polling. */
export interface StrategyEvent {
  /** Strategy ID */
  strategyId: number;
  /** Timestamp (ms epoch) */
  timestamp: number;
  /** Whether the run was autonomous */
  autoExecute: boolean;
  /** Short summary of what happened */
  summary: string;
  /** Whether the run succeeded */
  success: boolean;
}

// ── KV helpers ────────────────────────────────────────────────────────

const STRATEGY_PREFIX = "strategies:";
/** Tombstone prefix: written on delete, checked on save. Prevents in-flight
 *  cron runs (old code) from resurrecting deleted strategies via KV save. */
const TOMBSTONE_PREFIX = "strategy-deleted:";
/** Tombstone TTL — long enough to outlive any in-flight cron run (LLM calls
 *  can take several minutes, and old code may not have staleness checks). */
const TOMBSTONE_TTL = 1800; // 30 minutes

function strategyKey(vaultAddress: string): string {
  return `${STRATEGY_PREFIX}${vaultAddress.toLowerCase()}`;
}

function tombstoneKey(vaultAddress: string): string {
  return `${TOMBSTONE_PREFIX}${vaultAddress.toLowerCase()}`;
}

export async function getStrategies(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<Strategy[]> {
  const raw = await kv.get(strategyKey(vaultAddress));
  return raw ? (JSON.parse(raw) as Strategy[]) : [];
}

export async function saveStrategies(
  kv: KVNamespace,
  vaultAddress: string,
  strategies: Strategy[],
): Promise<void> {
  if (strategies.length === 0) {
    await kv.delete(strategyKey(vaultAddress));
  } else {
    await kv.put(strategyKey(vaultAddress), JSON.stringify(strategies));
  }
}

export async function addStrategy(
  kv: KVNamespace,
  strategy: Omit<Strategy, "id" | "createdAt" | "consecutiveFailures" | "active" | "executionCount"> & { autoExecute?: boolean; maxExecutions?: number },
): Promise<Strategy> {
  const validatedInterval = Math.round(Number(strategy.intervalMinutes));
  if (!Number.isFinite(validatedInterval) || validatedInterval < MIN_INTERVAL_MINUTES) {
    throw new Error(
      `Strategy interval must be at least ${MIN_INTERVAL_MINUTES} minutes.`,
    );
  }

  const validatedMaxExecutions = strategy.maxExecutions === undefined
    ? undefined
    : Math.round(Number(strategy.maxExecutions));
  if (
    validatedMaxExecutions !== undefined &&
    (!Number.isFinite(validatedMaxExecutions) || validatedMaxExecutions < 1)
  ) {
    throw new Error("maxExecutions must be at least 1.");
  }

  const existing = await getStrategies(kv, strategy.vaultAddress);
  if (existing.length >= MAX_STRATEGIES_PER_VAULT) {
    throw new Error(
      `Maximum ${MAX_STRATEGIES_PER_VAULT} strategies per vault. Remove one first.`,
    );
  }
  const nextId = existing.length > 0 ? Math.max(...existing.map((s) => s.id)) + 1 : 1;
  const newStrategy: Strategy = {
    ...strategy,
    intervalMinutes: validatedInterval,
    id: nextId,
    active: true,
    createdAt: Date.now(),
    consecutiveFailures: 0,
    autoExecute: strategy.autoExecute ?? true,
    maxExecutions: validatedMaxExecutions,
    executionCount: 0,
  };
  existing.push(newStrategy);
  await saveStrategies(kv, strategy.vaultAddress, existing);
  return newStrategy;
}

export async function removeStrategy(
  kv: KVNamespace,
  vaultAddress: string,
  strategyId: number,
  operatorAddress?: string,
): Promise<boolean> {
  const existing = await getStrategies(kv, vaultAddress);
  const filtered = existing.filter((s) => s.id !== strategyId);
  if (filtered.length === existing.length) return false;
  // Write tombstone so in-flight cron runs can't resurrect this strategy
  await kv.put(tombstoneKey(vaultAddress), Date.now().toString(), {
    expirationTtl: TOMBSTONE_TTL,
  });
  await saveStrategies(kv, vaultAddress, filtered);
  // Clean up Telegram recommendation cache for this operator
  if (operatorAddress) {
    await cleanupTelegramStrategyCache(kv, operatorAddress);
  }
  return true;
}

export async function removeAllStrategies(
  kv: KVNamespace,
  vaultAddress: string,
  operatorAddress?: string,
): Promise<number> {
  const existing = await getStrategies(kv, vaultAddress);
  // Write tombstone so in-flight cron runs can't resurrect deleted strategies
  await kv.put(tombstoneKey(vaultAddress), Date.now().toString(), {
    expirationTtl: TOMBSTONE_TTL,
  });
  await kv.delete(strategyKey(vaultAddress));
  // Clean up Telegram recommendation cache for this operator
  if (operatorAddress) {
    await cleanupTelegramStrategyCache(kv, operatorAddress);
  }
  return existing.length;
}

// ── Strategy events (for web chat polling) ────────────────────────────

function eventsKey(vaultAddress: string): string {
  return `strategy-events:${vaultAddress.toLowerCase()}`;
}

/**
 * Check if a strategy has been deleted or replaced in KV since we loaded it.
 * Returns true if the strategy no longer exists or has a different createdAt
 * (meaning the user deleted and re-created a strategy with the same ID).
 */
async function isStrategyStale(
  kv: KVNamespace,
  strategy: Strategy,
): Promise<boolean> {
  const current = await getStrategies(kv, strategy.vaultAddress);
  const match = current.find((s) => s.id === strategy.id);
  return !match || match.createdAt !== strategy.createdAt;
}

/** Append a strategy event. Keeps last MAX_EVENTS, 24h TTL. */
async function recordEvent(
  kv: KVNamespace,
  vaultAddress: string,
  event: StrategyEvent,
): Promise<void> {
  const raw = await kv.get(eventsKey(vaultAddress));
  const events: StrategyEvent[] = raw ? JSON.parse(raw) : [];
  events.push(event);
  // Keep only the most recent events
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  await kv.put(eventsKey(vaultAddress), JSON.stringify(events), {
    expirationTtl: EVENTS_TTL,
  });
}

/** Get strategy events since a given timestamp. */
export async function getStrategyEvents(
  kv: KVNamespace,
  vaultAddress: string,
  since?: number,
): Promise<StrategyEvent[]> {
  const raw = await kv.get(eventsKey(vaultAddress));
  if (!raw) return [];
  const events: StrategyEvent[] = JSON.parse(raw);
  if (since) return events.filter(e => e.timestamp > since);
  return events;
}

// ── Cron orchestration ────────────────────────────────────────────────

export type ProcessChatFn = (
  env: Env,
  messages: ChatMessage[],
  ctx: RequestContext,
) => Promise<ChatResponse>;

/**
 * Run all due strategies. Called from the Cloudflare scheduled() handler.
 *
 * For each active strategy whose interval has elapsed:
 * - If autoExecute is OFF (default): send instruction in manual mode, notify via Telegram
 * - If autoExecute is ON: send instruction in delegated mode, auto-execute transactions,
 *   then notify via Telegram with the execution results
 *
 * In both modes, the previous recommendation is carried forward as context so the LLM
 * can reference what it recommended last time and how the market has moved.
 */
export async function runDueStrategies(
  env: Env,
  processChat: ProcessChatFn,
): Promise<void> {
  const kv = env.KV;
  const now = Date.now();

  // Scan all strategy keys
  const list = await kv.list({ prefix: STRATEGY_PREFIX });

  for (const key of list.keys) {
    // Check tombstone — if strategies were recently deleted, note the
    // deletion time. Strategies created AFTER the tombstone are safe to
    // run; strategies that existed before it are skipped (prevents
    // in-flight cron from resurrecting deleted strategies).
    const vaultAddr = key.name.slice(STRATEGY_PREFIX.length);
    const tombstone = await kv.get(tombstoneKey(vaultAddr));
    const tombstoneTime = tombstone ? parseInt(tombstone, 10) : 0;

    let strategies: Strategy[];
    try {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      strategies = JSON.parse(raw) as Strategy[];
    } catch {
      continue;
    }

    let changed = false;

    for (const strategy of strategies) {
      if (!strategy.active) continue;

      // Skip strategies that predate a recent deletion tombstone
      if (tombstoneTime && strategy.createdAt <= tombstoneTime) {
        console.log(`Strategy ${strategy.id} predates tombstone — skipping.`);
        continue;
      }

      // Check if interval has elapsed
      const elapsed = now - (strategy.lastRun || 0);
      if (elapsed < strategy.intervalMinutes * 60_000) continue;

      // Early staleness check: verify this strategy still exists in KV
      // before starting the expensive LLM evaluation. Catches deletions
      // that happened after we loaded the strategies array.
      if (await isStrategyStale(kv, strategy)) {
        console.log(`Strategy ${strategy.id} (${strategy.vaultAddress}) deleted — skipping.`);
        continue;
      }

      try {
        // Build context with previous recommendation for continuity
        let contextNote = "";
        if (strategy.lastRecommendation && strategy.lastRun) {
          const minsAgo = Math.round((now - strategy.lastRun) / 60_000);
          contextNote =
            `\n\nPrevious recommendation (${minsAgo} minutes ago):\n${strategy.lastRecommendation}\n\n` +
            `Consider whether this is still relevant or if market conditions have changed.`;
        }

        const executionInstruction = strategy.autoExecute
          ? `Execute the recommended actions immediately if they are safe and beneficial. ` +
            `Follow the instruction EXACTLY — use the exact token amounts, thresholds, and conditions specified. ` +
            `Do NOT change amounts, invent conditions, or deviate from what the instruction says. ` +
            `If the strategy goal is fully achieved this run (e.g. accumulated the target total balance, ` +
            `reached a buy/sell target, or the task is permanently done), start your reply with ` +
            `"STRATEGY COMPLETE: [reason]" so the engine auto-removes the strategy.`
          : `Do NOT execute any transactions — only recommend what should be done. ` +
            `Be CONCISE: state what action to take and why in 2-3 short sentences. ` +
            `Do NOT show your reasoning process, analysis steps, or tool call plans. ` +
            `Just give the actionable recommendation.`;

        const comparisonGuidance =
          `IMPORTANT: If the instruction contains a price condition (e.g. "if price is below X"), ` +
          `you MUST verify the comparison carefully. Check: is the actual price LESS THAN the threshold? ` +
          `For example, 0.000045 < 0.001 means the condition "below 0.001" IS met. ` +
          `Double-check your comparison before concluding whether to act or wait. ` +
          `If NO action is needed, start your reply with "NO ACTION:" followed by the reason.`;

        // Build synthetic message for the LLM
        const messages: ChatMessage[] = [
          {
            role: "user",
            content:
              `[AUTOMATED STRATEGY CHECK — ID: ${strategy.id}]\n\n` +
              `Instruction: ${strategy.instruction}\n\n` +
              `Analyze the current state and recommend specific actions. ` +
              executionInstruction + `\n\n` +
              comparisonGuidance +
              contextNote,
          },
        ];

        const ctx: RequestContext = {
          vaultAddress: strategy.vaultAddress as Address,
          chainId: strategy.chainId,
          operatorAddress: strategy.operatorAddress as Address,
          executionMode: strategy.autoExecute ? "delegated" : "manual",
        };

        // ── Agentic loop: multi-step autonomous execution ──
        // The LLM may need multiple tool calls to complete a complex action
        // (e.g., check health → reduce LP → swap → bridge → add collateral).
        // In autonomous mode, we execute each transaction and feed results back
        // so the LLM can decide the next step. In manual mode, we run once.
        const conversation: ChatMessage[] = [...messages];
        let lastResult: ChatResponse | undefined;
        let executionSummary = "";
        const allOutcomes: string[] = [];
        const maxSteps = strategy.autoExecute ? MAX_STRATEGY_STEPS : 1;

        for (let step = 0; step < maxSteps; step++) {
          const result = await processChat(env, conversation, ctx);
          lastResult = result;

          // Track chain switches
          if (result.chainSwitch) {
            ctx.chainId = result.chainSwitch;
          }

          if (!strategy.autoExecute) break; // Manual mode: single pass

          // Collect transactions from this step
          const txList = result.transactions && result.transactions.length > 0
            ? result.transactions
            : result.transaction
              ? [result.transaction]
              : [];

          if (txList.length === 0) {
            // No transactions — LLM is done analyzing or no action needed
            break;
          }

          // Before executing, verify the strategy hasn't been deleted/replaced
          // while the LLM was thinking. Prevents stale cron runs from executing
          // trades for a strategy the user already removed.
          if (await isStrategyStale(kv, strategy)) {
            console.log(`Strategy ${strategy.id} (${strategy.vaultAddress}) is stale — skipping execution.`);
            break;
          }

          // Execute and record outcomes
          const outcomes = await executeTxList(env, txList, strategy.vaultAddress);
          const stepSummary = formatOutcomesMarkdown(outcomes);
          allOutcomes.push(`Step ${step + 1}: ${stepSummary}`);

          // If any transaction failed/reverted, stop — don't continue the chain
          const hasFailure = outcomes.some(o => o.error || o.result?.reverted);
          if (hasFailure) break;

          // Still have steps left? Feed results back and let the LLM decide next
          if (step < maxSteps - 1) {
            conversation.push({ role: "assistant", content: result.reply || "" });
            conversation.push({
              role: "user",
              content:
                `[EXECUTION RESULT — Step ${step + 1}]\n${stepSummary}\n\n` +
                `If there are more operations needed to complete the strategy action, proceed to the next step. ` +
                `If the objective is complete, summarize the final state.`,
            });
          }
        }

        if (allOutcomes.length > 0) {
          executionSummary = allOutcomes.join("\n\n");
        }

        const result = lastResult!;

        // Update strategy state
        strategy.lastRun = now;
        strategy.consecutiveFailures = 0;
        strategy.lastError = undefined;
        // For autonomous strategies that executed transactions, save the execution
        // summary as the recommendation context — not the post-execution "NO ACTION"
        // cleanup reply the LLM produces after being asked to summarize final state.
        // That cleanup reply ("NO ACTION: strategy completed for this run") would
        // mislead the next cron run into thinking no action is needed.
        strategy.lastRecommendation = (strategy.autoExecute && executionSummary)
          ? executionSummary.slice(0, 2000)
          : result.reply?.slice(0, 2000) || undefined;
        changed = true;

        // Increment executionCount on every successful cron run (not just when transactions
        // executed). This ensures time-bounded strategies ("buy every 5 min for 20 min"
        // → maxExecutions=4) stop correctly even when a run produces no transactions.
        strategy.executionCount = (strategy.executionCount || 0) + 1;

        // Auto-remove if maxExecutions reached
        if (strategy.maxExecutions && strategy.executionCount >= strategy.maxExecutions) {
          strategy.active = false;
        }

        // Detect "STRATEGY COMPLETE:" signal — LLM indicates the goal is fully achieved
        // (e.g. target balance reached, DCA amount accumulated). Auto-remove the strategy.
        const replyText = result.reply || "";
        if (/STRATEGY COMPLETE:/i.test(replyText)) {
          strategy.active = false;
          strategy.completedAt = now;
        }

        // Record event for web polling
        await recordEvent(kv, strategy.vaultAddress, {
          strategyId: strategy.id,
          timestamp: now,
          autoExecute: !!strategy.autoExecute,
          summary: executionSummary
            ? executionSummary.slice(0, 500)
            : (result.reply || "No action needed").slice(0, 500),
          success: true,
        });

        // Before notifying, verify the strategy hasn't been deleted/replaced
        // while the LLM was thinking. Prevents stale cron runs from sending
        // notifications for old strategies the user already replaced.
        if (await isStrategyStale(kv, strategy)) {
          console.log(`Strategy ${strategy.id} (${strategy.vaultAddress}) is stale — skipping notification.`);
          changed = false; // Don't merge stale state
          continue;
        }

        // Send Telegram notification
        if (env.TELEGRAM_BOT_TOKEN && (result.reply || executionSummary)) {
          const telegramUserId = await getTelegramUserIdByAddress(
            kv,
            strategy.operatorAddress,
          );
          if (telegramUserId) {
            if (strategy.autoExecute && executionSummary) {
              // Autonomous mode: notify AFTER execution with results
              const completedNote = strategy.completedAt
                ? `\n\n✅ Strategy completed — goal reached, auto-removed.`
                : (!strategy.active && strategy.maxExecutions)
                  ? `\n\n✅ Strategy completed (${strategy.executionCount}/${strategy.maxExecutions} runs) — auto-removed.`
                  : "";
              const text = [
                `<b>⚡ Strategy #${strategy.id} — auto-executed</b>`,
                `<i>${escapeHtml(strategy.instruction)}</i>`,
                ``,
                escapeHtml(executionSummary),
                completedNote,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            } else if (strategy.autoExecute && result.reply) {
              // Autonomous mode, no action taken this run — plain notification, no buttons.
              // Never show Act/Skip buttons for autonomous strategies.
              const isNoAction = /^NO ACTION:/i.test(result.reply.trim());
              const displayText = isNoAction
                ? result.reply.replace(/^NO ACTION:\s*/i, "")
                : result.reply;
              const text = [
                `<b>⏰ Strategy #${strategy.id} — evaluated, no action</b>`,
                `<i>${escapeHtml(strategy.instruction)}</i>`,
                ``,
                escapeHtml(displayText),
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            } else if (result.reply) {
              // Manual mode: notify with recommendation, await operator confirmation.
              // If the LLM says "no action needed", send a plain notification (no buttons).
              const isNoAction = /^NO ACTION:/i.test(result.reply.trim());
              const hasTx = !!(result.transaction || (result.transactions && result.transactions.length > 0));

              if (!isNoAction && (hasTx || !result.reply.toLowerCase().includes("no action"))) {
                // Actionable recommendation — store payload and show Act/Skip buttons
                const recPayload = {
                  strategyId: strategy.id,
                  instruction: strategy.instruction,
                  recommendation: result.reply,
                  vaultAddress: strategy.vaultAddress,
                  chainId: strategy.chainId,
                  operatorAddress: strategy.operatorAddress,
                  createdAt: Date.now(),
                };
                await kv.put(
                  `tg-strategy-rec:${telegramUserId}`,
                  JSON.stringify(recPayload),
                  { expirationTtl: strategy.intervalMinutes * 60 },
                );

                const text = [
                  `<b>⏰ Strategy #${strategy.id}</b>`,
                  `<i>${escapeHtml(strategy.instruction)}</i>`,
                  ``,
                  escapeHtml(result.reply),
                ].join("\n");

                const keyboard: TgInlineKeyboardMarkup = {
                  inline_keyboard: [
                    [
                      { text: "✅ Act on this", callback_data: `strategy-act:${telegramUserId}` },
                      { text: "❌ Skip", callback_data: `strategy-skip:${telegramUserId}` },
                    ],
                  ],
                };

                await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text, { replyMarkup: keyboard });
              } else {
                // No-action recommendation — plain notification, no buttons
                const text = [
                  `<b>⏰ Strategy #${strategy.id}</b>`,
                  `<i>${escapeHtml(strategy.instruction)}</i>`,
                  ``,
                  escapeHtml(result.reply.replace(/^NO ACTION:\s*/i, "")),
                ].join("\n");
                await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
              }
            }
          }
        }
      } catch (err) {
        strategy.lastRun = now;
        strategy.consecutiveFailures += 1;
        const rawError = err instanceof Error ? err.message : String(err);
        strategy.lastError = sanitizeError(rawError);
        changed = true;

        // Record failure event (sanitized — no API keys or secrets)
        await recordEvent(kv, strategy.vaultAddress, {
          strategyId: strategy.id,
          timestamp: now,
          autoExecute: !!strategy.autoExecute,
          summary: `Error: ${strategy.lastError.slice(0, 400)}`,
          success: false,
        }).catch(() => {}); // Don't fail the whole run if event recording fails

        // Auto-pause after too many consecutive failures
        if (strategy.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          strategy.active = false;

          // Notify operator about auto-pause
          if (env.TELEGRAM_BOT_TOKEN) {
            const telegramUserId = await getTelegramUserIdByAddress(
              kv,
              strategy.operatorAddress,
            );
            if (telegramUserId) {
              const text = [
                `<b>⚠️ Strategy #${strategy.id} auto-paused</b>`,
                `<i>${escapeHtml(strategy.instruction)}</i>`,
                ``,
                `Paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
                `Last error: <code>${escapeHtml(strategy.lastError || "unknown")}</code>`,
                ``,
                `Reply "resume strategy ${strategy.id}" to re-enable.`,
              ].join("\n");

              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            }
          }
        } else if (env.TELEGRAM_BOT_TOKEN) {
          // Notify on each individual failure (before auto-pause)
          const telegramUserId = await getTelegramUserIdByAddress(
            kv,
            strategy.operatorAddress,
          );
          if (telegramUserId) {
            const text = [
              `<b>❌ Strategy #${strategy.id} — evaluation failed</b>`,
              `Error: <code>${escapeHtml(strategy.lastError || "unknown")}</code>`,
              `Failures: ${strategy.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} (pauses at ${MAX_CONSECUTIVE_FAILURES})`,
            ].join("\n");
            await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
          }
        }

        console.error(
          `Strategy ${strategy.id} (${strategy.vaultAddress}) failed:`,
          err,
        );
      }
    }

    if (changed) {
      // Extract vault address from key: "strategies:0x..."
      const vaultAddr = key.name.slice(STRATEGY_PREFIX.length);

      // Re-read from KV to avoid overwriting concurrent deletions.
      // If the operator removed a strategy while the cron was running,
      // we must not restore it by saving our stale copy.
      const freshStrategies = await getStrategies(kv, vaultAddr);
      const freshIds = new Set(freshStrategies.map((s) => s.id));

      // Merge: only update strategies that still exist in KV AND have
      // the same createdAt (prevents a stale cron run from overwriting
      // a newly created strategy that reused the same ID).
      // Also remove completed one-shot strategies (maxExecutions reached)
      let merged = freshStrategies
        .map((fresh) => {
          const updated = strategies.find(
            (s) => s.id === fresh.id && s.createdAt === fresh.createdAt,
          );
          return updated || fresh;
        })
        .filter((s) => {
          // Remove strategies that have hit their run limit
          if (s.maxExecutions && (s.executionCount || 0) >= s.maxExecutions) return false;
          // Remove strategies the LLM signalled as goal-complete ("STRATEGY COMPLETE:")
          if (s.completedAt) return false;
          return true;
        });

      // If all strategies were removed, don't re-create them
      if (freshIds.size === 0 && freshStrategies.length === 0) {
        continue;
      }

      // Check tombstone: if strategies were recently deleted, filter out
      // strategies that predate the deletion. Strategies created after the
      // tombstone are safe to save (they're genuinely new, not resurrected).
      const tombstoneForSave = await kv.get(tombstoneKey(vaultAddr));
      if (tombstoneForSave) {
        const ts = parseInt(tombstoneForSave, 10);
        merged = merged.filter((s) => s.createdAt > ts);
        if (merged.length === 0) {
          console.log(`Strategy tombstone found for ${vaultAddr} — all strategies predate it, skipping save.`);
          continue;
        }
      }

      await saveStrategies(kv, vaultAddr, merged);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
