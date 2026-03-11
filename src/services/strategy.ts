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

import type { Env, ChatMessage, RequestContext } from "../types.js";
import type { Address } from "viem";
import { getTelegramUserIdByAddress } from "./telegramPairing.js";
import { sendMessage } from "./telegram.js";

// ── Constants ─────────────────────────────────────────────────────────

export const MAX_STRATEGIES_PER_VAULT = 3;
export const MIN_INTERVAL_MINUTES = 5;
const MAX_CONSECUTIVE_FAILURES = 3;

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
  strategy: Omit<Strategy, "id" | "createdAt" | "consecutiveFailures" | "active">,
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

// ── Cron orchestration ────────────────────────────────────────────────

export type ProcessChatFn = (
  env: Env,
  messages: ChatMessage[],
  ctx: RequestContext,
) => Promise<{ reply: string }>;

/**
 * Run all due strategies. Called from the Cloudflare scheduled() handler.
 *
 * For each active strategy whose interval has elapsed:
 * 1. Send instruction to the LLM (forced manual mode — only recommends, never executes)
 * 2. Forward the LLM's recommendation via Telegram
 * 3. Track success/failure; auto-pause after 3 consecutive failures
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
        // Build synthetic message for the LLM
        const messages: ChatMessage[] = [
          {
            role: "user",
            content:
              `[AUTOMATED STRATEGY CHECK — ID: ${strategy.id}]\n\n` +
              `Instruction: ${strategy.instruction}\n\n` +
              `Analyze the current state and recommend specific actions. ` +
              `Do NOT execute any transactions — only describe what should be done and why.`,
          },
        ];

        const ctx: RequestContext = {
          vaultAddress: strategy.vaultAddress as Address,
          chainId: strategy.chainId,
          operatorAddress: strategy.operatorAddress as Address,
          executionMode: "manual", // never auto-execute from cron
        };

        const result = await processChat(env, messages, ctx);

        // Update strategy state
        strategy.lastRun = now;
        strategy.consecutiveFailures = 0;
        strategy.lastError = undefined;
        changed = true;

        // Send Telegram notification
        if (env.TELEGRAM_BOT_TOKEN && result.reply) {
          const telegramUserId = await getTelegramUserIdByAddress(
            kv,
            strategy.operatorAddress,
          );
          if (telegramUserId) {
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
      } catch (err) {
        strategy.lastRun = now;
        strategy.consecutiveFailures += 1;
        strategy.lastError = err instanceof Error ? err.message : String(err);
        changed = true;

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
