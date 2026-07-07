/**
 * NAV Sync Strategy Skill — deterministic periodic cross-chain NAV synchronisation.
 *
 * Builds on top of the `crosschain_sync` atomic tool. On each cron tick, for every
 * active NavSyncConfig the skill:
 *   1. Reads aggregated NAV across all chains via getAggregatedNav().
 *   2. Computes a single global unit-less target unitary from aggregate USDC total
 *      assets divided by aggregate USDC value of effective supplies.
 *   3. Flags chains whose base-token price deviates from the global target
 *      by more than `thresholdBps`. Bridges FROM chains above the target TO chains
 *      below the target using deterministic NAV equalization.
 *   4. Reports outcomes via Telegram if the operator has a Telegram pairing.
 *
 * Like TWAP, this is fully deterministic — no LLM judgment in the execution loop.
 * Each sync transaction goes through the full safety stack (NAV shield, delegation,
 * 7-point validation).
 */

import type { Env, RequestContext, TransactionDraft } from "../types.js";
import type { Address } from "viem";
import type { StrategySkill, SkillToolDefinition, SkillToolResult } from "./types.js";
import { getTelegramUserIdByAddress } from "../services/telegramPairing.js";
import { sendMessage, escapeHtml } from "../services/telegram.js";
import { executeTxList, formatOutcomesMarkdown } from "../services/execution.js";
import { formatUnits } from "viem";
import { sanitizeError, resolveChainName } from "../config.js";
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
      `Interval: every ${intervalMinutes} min | Threshold: ${(thresholdBps / 100).toFixed(2)}% deviation from global target\n` +
      `The skill will automatically sync NAV across all active chains whenever a chain's base-token unitary deviates more than the threshold.`,
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
    s => !s.error && s.effectiveSupply > 0n && s.unitaryValue > 0n,
  );

  // 3. Compute deviation of each chain's base-token unitary from the global
  //    unit-less target. Chains above the target are sources; chains below are destinations.
  const globalTarget = parseFloat(agg.globalNav.targetPrice);
  const deviations = activeSnaps
    .map((snap) => {
      const unitaryBase = Number(formatUnits(snap.unitaryValue, snap.baseTokenDecimals));
      const deviationBps = globalTarget > 0
        ? Math.round(((unitaryBase - globalTarget) / globalTarget) * 10000)
        : 0;
      return { snap, unitaryBase, deviationBps };
    });

  const above = deviations.filter((d) => d.deviationBps > config.thresholdBps);
  const below = deviations.filter((d) => d.deviationBps < -config.thresholdBps);

  // Sync the most-above chain with the most-below chain, second-most with second-most, etc.
  above.sort((a, b) => b.deviationBps - a.deviationBps);
  below.sort((a, b) => a.deviationBps - b.deviationBps);

  const pairs: { src: typeof activeSnaps[number]; dst: typeof activeSnaps[number] }[] = [];
  const pairCount = Math.min(above.length, below.length);
  for (let i = 0; i < pairCount; i++) {
    pairs.push({ src: above[i].snap, dst: below[i].snap });
  }

  if (pairs.length === 0) {
    return;
  }

  // 5. Execute deterministic NAV equalization for each pair.
  const outcomes: string[] = [];

  for (const { src, dst } of pairs) {
    try {
      const { buildCrosschainSync } = await import("../services/crosschain.js");

      const result = await buildCrosschainSync({
        vaultAddress: config.vaultAddress as Address,
        srcChainId: src.chainId,
        dstChainId: dst.chainId,
        alchemyKey: env.ALCHEMY_API_KEY,
        operatorAddress: config.operatorAddress as Address,
      });

      const tx: TransactionDraft = {
        to: config.vaultAddress as Address,
        data: result.calldata,
        value: "0x0",
        chainId: src.chainId,
        description: result.description,
      };

      const [outcome] = await executeTxList(env, [tx], config.vaultAddress);
      const srcName = resolveChainName(src.chainId);
      const dstName = resolveChainName(dst.chainId);

      if (outcome.result?.confirmed && !outcome.result?.reverted) {
        outcomes.push(`✅ ${srcName} → ${dstName}: ${outcome.result.txHash}`);
      } else {
        outcomes.push(`⚠️ ${srcName} → ${dstName}: ${outcome.error || "unconfirmed"}`);
      }
    } catch (err) {
      const msg = sanitizeError(err instanceof Error ? err.message : String(err));
      outcomes.push(`❌ ${resolveChainName(src.chainId)} → ${resolveChainName(dst.chainId)}: ${msg}`);
    }
  }

  // 6. Notify operator
  if (outcomes.length > 0) {
    await notifyOperator(env, config,
      `📡 NAV sync #${config.id} executed (global-target deviation > ${(config.thresholdBps / 100).toFixed(2)}%):\n${outcomes.join("\n")}`
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
      description: "Create an automated NAV sync config that periodically synchronises NAV across chains when a chain's base-token unitary NAV deviates from the global unit-less target beyond a threshold.",
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
- create_nav_sync schedules PERIODIC cross-chain NAV synchronisation (default: every 30 min, threshold 2%).
- Syncs use a single global unit-less target unitary computed from aggregate USDC total assets divided by aggregate USDC value of effective supplies. The target is interpreted as the target number of base-token units per pool token on each chain.
- list_nav_syncs shows active configs.
- cancel_nav_sync stops a config.
- For a SINGLE immediate sync — including explicit amount/token syncs or deterministic NAV equalization — use the crosschain_sync tool directly, NOT create_nav_sync.`;

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
