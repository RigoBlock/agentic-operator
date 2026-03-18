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
import { executeTxList, formatOutcomesMarkdown } from "./execution.js";
import { sanitizeError } from "../config.js";

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

function strategyKey(vaultAddress: string): string {
  return `${STRATEGY_PREFIX}${vaultAddress.toLowerCase()}`;
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
  strategy: Omit<Strategy, "id" | "createdAt" | "consecutiveFailures" | "active"> & { autoExecute?: boolean },
): Promise<Strategy> {
  const existing = await getStrategies(kv, strategy.vaultAddress);
  if (existing.length >= MAX_STRATEGIES_PER_VAULT) {
    throw new Error(
      `Maximum ${MAX_STRATEGIES_PER_VAULT} strategies per vault. Remove one first.`,
    );
  }
  const nextId = existing.length > 0 ? Math.max(...existing.map((s) => s.id)) + 1 : 1;
  const newStrategy: Strategy = {
    ...strategy,
    id: nextId,
    active: true,
    createdAt: Date.now(),
    consecutiveFailures: 0,
    autoExecute: strategy.autoExecute || false,
  };
  existing.push(newStrategy);
  await saveStrategies(kv, strategy.vaultAddress, existing);
  return newStrategy;
}

export async function removeStrategy(
  kv: KVNamespace,
  vaultAddress: string,
  strategyId: number,
): Promise<boolean> {
  const existing = await getStrategies(kv, vaultAddress);
  const filtered = existing.filter((s) => s.id !== strategyId);
  if (filtered.length === existing.length) return false;
  await saveStrategies(kv, vaultAddress, filtered);
  return true;
}

export async function removeAllStrategies(
  kv: KVNamespace,
  vaultAddress: string,
): Promise<number> {
  const existing = await getStrategies(kv, vaultAddress);
  await kv.delete(strategyKey(vaultAddress));
  return existing.length;
}

// ── Strategy events (for web chat polling) ────────────────────────────

function eventsKey(vaultAddress: string): string {
  return `strategy-events:${vaultAddress.toLowerCase()}`;
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

      // Check if interval has elapsed
      const elapsed = now - (strategy.lastRun || 0);
      if (elapsed < strategy.intervalMinutes * 60_000) continue;

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
          ? `Execute the recommended actions immediately if they are safe and beneficial.`
          : `Do NOT execute any transactions — only describe what should be done and why.`;

        // Build synthetic message for the LLM
        const messages: ChatMessage[] = [
          {
            role: "user",
            content:
              `[AUTOMATED STRATEGY CHECK — ID: ${strategy.id}]\n\n` +
              `Instruction: ${strategy.instruction}\n\n` +
              `Analyze the current state and recommend specific actions. ` +
              executionInstruction +
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
        strategy.lastRecommendation = result.reply?.slice(0, 2000) || undefined;
        changed = true;

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

        // Send Telegram notification
        if (env.TELEGRAM_BOT_TOKEN && (result.reply || executionSummary)) {
          const telegramUserId = await getTelegramUserIdByAddress(
            kv,
            strategy.operatorAddress,
          );
          if (telegramUserId) {
            if (strategy.autoExecute && executionSummary) {
              // Autonomous mode: notify AFTER execution with results
              const text = [
                `<b>⚡ Strategy #${strategy.id} — auto-executed</b>`,
                `<i>${escapeHtml(strategy.instruction)}</i>`,
                ``,
                escapeHtml(executionSummary),
                result.reply ? `\n${escapeHtml(result.reply)}` : ``,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            } else if (result.reply) {
              // Manual mode: notify with recommendation, await operator confirmation
              const text = [
                `<b>⏰ Strategy #${strategy.id}</b>`,
                `<i>${escapeHtml(strategy.instruction)}</i>`,
                ``,
                escapeHtml(result.reply),
                ``,
                `Reply to act on this recommendation, or ignore to skip.`,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
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
      await saveStrategies(kv, vaultAddr, strategies);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
