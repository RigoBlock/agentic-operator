/**
 * NAV Sync Strategy Skill — deterministic periodic cross-chain NAV synchronisation.
 *
 * Builds on top of the `crosschain_sync` atomic tool. On each cron tick, for every
 * active NavSyncConfig the skill:
 *   1. Reads aggregated NAV across all chains via getAggregatedNav().
 *   2. Finds chain pairs whose unitary-value deviates from the highest observed value
 *      by more than `thresholdBps` basis points.
 *   3. Issues a crosschain_sync for each deviant pair (source = deviant chain →
 *      destination = chain with the highest unitary value).
 *   4. Reports outcomes via Telegram if the operator has a Telegram pairing.
 *
 * Like TWAP, this is fully deterministic — no LLM judgment in the execution loop.
 * Each sync transaction goes through the full safety stack (NAV shield, delegation,
 * 7-point validation).
 */

import type { Env, RequestContext, UnsignedTransaction } from "../types.js";
import type { Address } from "viem";
import type { StrategySkill, SkillToolDefinition, SkillToolResult } from "./types.js";
import { getTelegramUserIdByAddress } from "../services/telegramPairing.js";
import { sendMessage, escapeHtml } from "../services/telegram.js";
import { executeTxList, formatOutcomesMarkdown } from "../services/execution.js";
import { sanitizeError, resolveChainId, resolveChainName } from "../config.js";
import { getAggregatedNav } from "../services/crosschain.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface NavSyncConfig {
  id: number;
  vaultAddress: string;
  operatorAddress: string;
  /** Minimum NAV deviation (in bps) between chains that triggers a sync. Default 200 (2%). */
  thresholdBps: number;
  /** How often to evaluate, in minutes. Minimum 5. Default 30. */
  intervalMinutes: number;
  active: boolean;
  createdAt: number;
  lastRunAt?: number;
  consecutiveFailures: number;
  lastError?: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const MAX_NAV_SYNC_CONFIGS_PER_VAULT = 1; // one config per vault is enough
const MIN_INTERVAL_MINUTES = 5;
const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_THRESHOLD_BPS = 200; // 2%
const MAX_CONSECUTIVE_FAILURES = 3;

// ── KV helpers ────────────────────────────────────────────────────────

const NS_PREFIX = "navsync:";

function nsKey(vaultAddress: string): string {
  return `${NS_PREFIX}${vaultAddress.toLowerCase()}`;
}

export async function getNavSyncConfigs(kv: KVNamespace, vaultAddress: string): Promise<NavSyncConfig[]> {
  const raw = await kv.get(nsKey(vaultAddress));
  return raw ? (JSON.parse(raw) as NavSyncConfig[]) : [];
}

async function saveNavSyncConfigs(kv: KVNamespace, vaultAddress: string, configs: NavSyncConfig[]): Promise<void> {
  const active = configs.filter(c => c.active);
  const closed = configs.filter(c => !c.active).slice(0, 5); // keep last 5 closed
  const pruned = [...active, ...closed];
  if (pruned.length === 0) {
    await kv.delete(nsKey(vaultAddress));
  } else {
    await kv.put(nsKey(vaultAddress), JSON.stringify(pruned));
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────

async function handleCreate(
  args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult> {
  if (!ctx.operatorVerified) {
    throw new Error("Operator authentication required to create a NAV sync config.");
  }

  const intervalMinutes = Math.max(
    MIN_INTERVAL_MINUTES,
    typeof args.intervalMinutes === "number" ? args.intervalMinutes : DEFAULT_INTERVAL_MINUTES,
  );
  const thresholdBps = Math.max(
    10,
    typeof args.thresholdBps === "number" ? args.thresholdBps : DEFAULT_THRESHOLD_BPS,
  );

  const existing = await getNavSyncConfigs(env.KV, ctx.vaultAddress);
  const active = existing.filter(c => c.active);
  if (active.length >= MAX_NAV_SYNC_CONFIGS_PER_VAULT) {
    throw new Error(`A NAV sync config already exists for this vault. Cancel it first.`);
  }

  const nextId = existing.length > 0 ? Math.max(...existing.map(c => c.id)) + 1 : 1;
  const config: NavSyncConfig = {
    id: nextId,
    vaultAddress: ctx.vaultAddress,
    operatorAddress: ctx.operatorAddress || "",
    thresholdBps,
    intervalMinutes,
    active: true,
    createdAt: Date.now(),
    consecutiveFailures: 0,
  };

  await saveNavSyncConfigs(env.KV, ctx.vaultAddress, [...existing, config]);

  return {
    message: `✅ NAV sync config #${config.id} created.\n` +
      `Interval: every ${intervalMinutes} min | Threshold: ${(thresholdBps / 100).toFixed(2)}% deviation\n` +
      `The skill will automatically sync NAV across all active chains whenever the unitary value deviates more than the threshold.`,
    suggestions: ["List NAV sync configs", "Cancel NAV sync"],
  };
}

async function handleList(
  _args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult> {
  if (!ctx.operatorVerified) {
    throw new Error("Operator authentication required to list NAV sync configs.");
  }

  const configs = await getNavSyncConfigs(env.KV, ctx.vaultAddress);
  const active = configs.filter(c => c.active);

  if (active.length === 0) {
    return {
      message: "No active NAV sync configs for this vault.",
      suggestions: ["Create a NAV sync", "Sync NAV manually"],
    };
  }

  const lines = active.map(c => {
    const last = c.lastRunAt ? new Date(c.lastRunAt).toISOString() : "never";
    const err = c.consecutiveFailures > 0 ? ` ⚠️ ${c.consecutiveFailures} failure(s): ${c.lastError || "unknown"}` : "";
    return `#${c.id} | every ${c.intervalMinutes}min | threshold ${(c.thresholdBps / 100).toFixed(2)}% | last run: ${last}${err}`;
  });

  return {
    message: `**Active NAV sync configs:**\n${lines.join("\n")}`,
    suggestions: ["Cancel NAV sync", "Sync NAV manually"],
  };
}

async function handleCancel(
  args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult> {
  if (!ctx.operatorVerified) {
    throw new Error("Operator authentication required to cancel a NAV sync config.");
  }

  const configs = await getNavSyncConfigs(env.KV, ctx.vaultAddress);
  const id = typeof args.configId === "number" ? args.configId : undefined;

  let updated: NavSyncConfig[];
  if (id !== undefined) {
    const target = configs.find(c => c.id === id && c.active);
    if (!target) throw new Error(`NAV sync config #${id} not found or already inactive.`);
    updated = configs.map(c => c.id === id ? { ...c, active: false } : c);
  } else {
    // Cancel all active
    updated = configs.map(c => c.active ? { ...c, active: false } : c);
  }

  await saveNavSyncConfigs(env.KV, ctx.vaultAddress, updated);
  const cancelled = configs.filter(c => c.active && (id === undefined || c.id === id));
  return {
    message: `Cancelled ${cancelled.length} NAV sync config(s).`,
    suggestions: ["Create a new NAV sync"],
  };
}

// ── Cron executor ─────────────────────────────────────────────────────

/**
 * Scan all active NavSyncConfigs across all vaults and execute syncs for those that are due.
 * Called from the scheduled() handler in index.ts via runAllSkills().
 */
export async function runDueNavSyncs(env: Env): Promise<void> {
  // List all navsync:* keys
  const list = await env.KV.list({ prefix: NS_PREFIX });
  const now = Date.now();

  for (const { name: key } of list.keys) {
    const raw = await env.KV.get(key);
    if (!raw) continue;

    let configs: NavSyncConfig[];
    try {
      configs = JSON.parse(raw) as NavSyncConfig[];
    } catch {
      continue;
    }

    let dirty = false;

    for (const config of configs) {
      if (!config.active) continue;

      const intervalMs = config.intervalMinutes * 60 * 1000;
      const lastRun = config.lastRunAt ?? 0;
      if (now - lastRun < intervalMs) continue;

      dirty = true;
      config.lastRunAt = now;

      try {
        await executeNavSync(env, config);
        config.consecutiveFailures = 0;
        config.lastError = undefined;
      } catch (err) {
        config.consecutiveFailures += 1;
        config.lastError = sanitizeError(err instanceof Error ? err.message : String(err));
        console.error(`[NavSync] config #${config.id} vault ${config.vaultAddress} failed:`, config.lastError);

        if (config.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          config.active = false;
          console.warn(`[NavSync] config #${config.id} auto-paused after ${MAX_CONSECUTIVE_FAILURES} failures.`);
          await notifyOperator(env, config,
            `⚠️ NAV sync config #${config.id} paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.\nLast error: ${config.lastError}`
          );
        }
      }
    }

    if (dirty) {
      await env.KV.put(key, JSON.stringify(configs));
    }
  }
}

async function executeNavSync(env: Env, config: NavSyncConfig): Promise<void> {
  // 1. Read aggregated NAV across all chains
  const agg = await getAggregatedNav(
    config.vaultAddress as Address,
    env.ALCHEMY_API_KEY,
    env.KV,
  );

  // 2. Find chains with real data (non-zero supply, no error)
  const activeSnaps = agg.chains.filter(
    s => !s.error && s.totalSupply > 0n && s.unitaryValue > 0n,
  );

  if (activeSnaps.length < 2) {
    // Nothing to sync — only one chain active
    return;
  }

  // 3. Find the reference (highest unitary value)
  const reference = activeSnaps.reduce((best, s) =>
    s.unitaryValue > best.unitaryValue ? s : best,
  );

  // 4. Find deviant chains
  const thresholdPct = config.thresholdBps / 10000;
  const deviant = activeSnaps.filter(s => {
    if (s.chainId === reference.chainId) return false;
    const deviation = Number(reference.unitaryValue - s.unitaryValue) / Number(reference.unitaryValue);
    return deviation > thresholdPct;
  });

  if (deviant.length === 0) {
    console.log(`[NavSync] config #${config.id}: no deviation > ${(thresholdPct * 100).toFixed(2)}% — no sync needed.`);
    return;
  }

  // 5. Sync each deviant chain (source = deviant chain, destination = reference chain)
  const ctx: RequestContext = {
    vaultAddress: config.vaultAddress as Address,
    chainId: reference.chainId,
    operatorAddress: config.operatorAddress as Address,
    executionMode: "delegated",
    operatorVerified: true,
  };

  const outcomes: string[] = [];

  for (const snap of deviant) {
    try {
      const { buildCrosschainSync } = await import("../services/crosschain.js");

      const result = await buildCrosschainSync({
        vaultAddress: config.vaultAddress as Address,
        srcChainId: snap.chainId,
        dstChainId: reference.chainId,
        alchemyKey: env.ALCHEMY_API_KEY,
        operatorAddress: config.operatorAddress as Address,
      });

      const tx: UnsignedTransaction = {
        to: config.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: snap.chainId,
        gas: "0x7a120", // 500k gas — standard for crosschain sync
        description: result.description,
      };

      const [outcome] = await executeTxList(env, [tx], config.vaultAddress);
      const srcName = resolveChainName(snap.chainId);
      const dstName = resolveChainName(reference.chainId);

      if (outcome.result?.confirmed && !outcome.result?.reverted) {
        outcomes.push(`✅ ${srcName} → ${dstName}: ${outcome.result.txHash}`);
      } else {
        outcomes.push(`⚠️ ${srcName} → ${dstName}: ${outcome.error || "unconfirmed"}`);
      }
    } catch (err) {
      const msg = sanitizeError(err instanceof Error ? err.message : String(err));
      outcomes.push(`❌ chain ${snap.chainId}: ${msg}`);
    }
  }

  // 6. Notify operator
  if (outcomes.length > 0) {
    await notifyOperator(env, config,
      `📡 NAV sync #${config.id} executed (deviation > ${(thresholdPct * 100).toFixed(2)}%):\n${outcomes.join("\n")}`
    );
  }
}

async function notifyOperator(env: Env, config: NavSyncConfig, text: string): Promise<void> {
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const userId = await getTelegramUserIdByAddress(env.KV, config.operatorAddress);
    if (!userId) return;
    await sendMessage(token, Number(userId), escapeHtml(text));
  } catch {
    // Telegram notification failure is non-critical
  }
}

// ── Tool definitions ──────────────────────────────────────────────────

const navSyncTools: SkillToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_nav_sync",
      description: "Create an automated NAV sync config that periodically synchronises NAV across chains when unitary value deviates beyond a threshold.",
      parameters: {
        type: "object",
        properties: {
          intervalMinutes: {
            type: "number",
            description: "How often to check and sync, in minutes. Minimum 5, default 30.",
          },
          thresholdBps: {
            type: "number",
            description: "Minimum NAV deviation in basis points that triggers a sync. Default 200 (= 2%).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_nav_syncs",
      description: "List active NAV sync configs for this vault.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_nav_sync",
      description: "Cancel an active NAV sync config.",
      parameters: {
        type: "object",
        properties: {
          configId: {
            type: "number",
            description: "Config ID to cancel. Omit to cancel all active configs.",
          },
        },
        required: [],
      },
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────

const navSyncSystemPrompt = `NAV SYNC AUTOMATION:
- create_nav_sync schedules periodic cross-chain NAV synchronisation (default: every 30 min, threshold 2%).
- list_nav_syncs shows active configs.
- cancel_nav_sync stops a config.
- For one-off manual syncs, use crosschain_sync directly.`;

// ── Skill export ──────────────────────────────────────────────────────

export const navSyncSkill: StrategySkill = {
  name: "navsync",
  description: "Automated periodic cross-chain NAV synchronisation.",
  toolNames: navSyncTools.map(t => t.function.name),
  tools: navSyncTools,
  systemPrompt: navSyncSystemPrompt,

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
    ctx: RequestContext,
  ): Promise<SkillToolResult> {
    switch (toolName) {
      case "create_nav_sync": return handleCreate(args, env, ctx);
      case "list_nav_syncs": return handleList(args, env, ctx);
      case "cancel_nav_sync": return handleCancel(args, env, ctx);
      default: throw new Error(`navSyncSkill: unknown tool ${toolName}`);
    }
  },

  async runDue(env: Env, _processChat: unknown): Promise<void> {
    await runDueNavSyncs(env);
  },
};
