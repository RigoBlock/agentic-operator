/**
 * TWAP Strategy Skill — Time-Weighted Average Price.
 *
 * Self-contained skill module: types, tool definitions, handlers, cron executor.
 * Adding this skill requires only registering it in `src/skills/registry.ts`.
 *
 * Unlike the generic LLM strategy engine, TWAP orders are fully deterministic:
 * split a large swap into equal slices executed at regular intervals — no LLM
 * judgment in the execution loop.
 *
 * Safety: each slice goes through the full pipeline (NAV shield, delegation,
 * slippage). Auto-pauses after 3 consecutive failures.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../types.js";
import type { Address } from "viem";
import type { StrategySkill, SkillToolDefinition, SkillToolResult, ProcessChatFn } from "./types.js";
import { getTelegramUserIdByAddress } from "../services/telegramPairing.js";
import { sendMessage, escapeHtml } from "../services/telegram.js";
import { executeTxList, formatOutcomesMarkdown } from "../services/execution.js";
import { executeToolCall } from "../llm/client.js";
import { sanitizeError, resolveChainId, resolveChainName, resolveTokenAddress } from "../config.js";
import { initTokenResolver } from "../services/tokenResolver.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TwapOrder {
  id: number;
  /** "buy" = totalAmount is in buyToken (exact-output per slice).
   *  "sell" = totalAmount is in sellToken (exact-input per slice). */
  side: "buy" | "sell";
  sellToken: string;
  buyToken: string;
  /** Resolved contract address for sellToken on the target chain */
  sellTokenAddress?: string;
  /** Resolved contract address for buyToken on the target chain */
  buyTokenAddress?: string;
  /** Total amount — of buyToken when side="buy", of sellToken when side="sell". */
  totalAmount: string;
  amountSpent: string;
  sliceAmount: string;
  sliceCount: number;
  slicesExecuted: number;
  intervalMinutes: number;
  dex: string;
  chainId: number;
  vaultAddress: string;
  operatorAddress: string;
  active: boolean;
  createdAt: number;
  lastExecution?: number;
  consecutiveFailures: number;
  lastError?: string;
  completedAt?: number;
  totalBought: string;
  autoExecute: boolean;
}

export interface TwapEvent {
  orderId: number;
  timestamp: number;
  sliceNumber: number;
  totalSlices: number;
  sellAmount: string;
  buyAmount: string;
  success: boolean;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const MAX_TWAP_ORDERS_PER_VAULT = 3;
const MAX_STORED_CLOSED_ORDERS_PER_VAULT = 20;
const MIN_INTERVAL_MINUTES = 5;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_EVENTS = 20;
const EVENTS_TTL = 24 * 60 * 60;

// ── KV helpers ────────────────────────────────────────────────────────

const TWAP_PREFIX = "twap:";
const TWAP_EVENTS_PREFIX = "twap-events:";
const TWAP_HWM_PREFIX = "twap-hwm:";

function twapKey(vaultAddress: string): string {
  return `${TWAP_PREFIX}${vaultAddress.toLowerCase()}`;
}

function twapEventsKey(vaultAddress: string): string {
  return `${TWAP_EVENTS_PREFIX}${vaultAddress.toLowerCase()}`;
}

/** High-water-mark key: stores the highest ID ever assigned for this vault. Never deleted. */
function twapHwmKey(vaultAddress: string): string {
  return `${TWAP_HWM_PREFIX}${vaultAddress.toLowerCase()}`;
}

export async function getTwapOrders(kv: KVNamespace, vaultAddress: string): Promise<TwapOrder[]> {
  const raw = await kv.get(twapKey(vaultAddress));
  return raw ? (JSON.parse(raw) as TwapOrder[]) : [];
}

export async function saveTwapOrders(kv: KVNamespace, vaultAddress: string, orders: TwapOrder[]): Promise<void> {
  const active = orders.filter((o) => o.active);
  const closed = orders
    .filter((o) => !o.active)
    .sort((a, b) => {
      const at = a.completedAt || a.lastExecution || a.createdAt;
      const bt = b.completedAt || b.lastExecution || b.createdAt;
      return bt - at;
    })
    .slice(0, MAX_STORED_CLOSED_ORDERS_PER_VAULT);
  const pruned = [...active, ...closed];

  if (pruned.length === 0) {
    await kv.delete(twapKey(vaultAddress));
  } else {
    await kv.put(twapKey(vaultAddress), JSON.stringify(pruned));
  }
}

async function addTwapOrder(
  kv: KVNamespace,
  order: Omit<TwapOrder, "id" | "createdAt" | "consecutiveFailures" | "active" | "slicesExecuted" | "amountSpent" | "totalBought" | "completedAt">,
): Promise<TwapOrder> {
  const existing = await getTwapOrders(kv, order.vaultAddress);
  const activeCount = existing.filter((o) => o.active).length;
  if (activeCount >= MAX_TWAP_ORDERS_PER_VAULT) {
    throw new Error(`Maximum ${MAX_TWAP_ORDERS_PER_VAULT} TWAP orders per vault. Cancel one first.`);
  }
  // Use a persistent high-water-mark so IDs never restart, even if the order history is pruned.
  const hwmRaw = await kv.get(twapHwmKey(order.vaultAddress));
  const hwm = hwmRaw ? parseInt(hwmRaw, 10) : 0;
  const existingMax = existing.length > 0 ? Math.max(...existing.map((o) => o.id)) : 0;
  const nextId = Math.max(hwm, existingMax) + 1;
  const newOrder: TwapOrder = {
    ...order,
    id: nextId,
    active: true,
    createdAt: Date.now(),
    consecutiveFailures: 0,
    slicesExecuted: 0,
    amountSpent: "0",
    totalBought: "0",
  };
  existing.push(newOrder);
  await saveTwapOrders(kv, order.vaultAddress, existing);
  // Persist the HWM so future orders always get a higher ID.
  await kv.put(twapHwmKey(order.vaultAddress), String(nextId));
  return newOrder;
}

async function recordTwapEvent(kv: KVNamespace, vaultAddress: string, event: TwapEvent): Promise<void> {
  const raw = await kv.get(twapEventsKey(vaultAddress));
  const events: TwapEvent[] = raw ? JSON.parse(raw) : [];
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  await kv.put(twapEventsKey(vaultAddress), JSON.stringify(events), { expirationTtl: EVENTS_TTL });
}

export async function getTwapEvents(kv: KVNamespace, vaultAddress: string, since?: number): Promise<TwapEvent[]> {
  const raw = await kv.get(twapEventsKey(vaultAddress));
  if (!raw) return [];
  const events: TwapEvent[] = JSON.parse(raw);
  if (since) return events.filter((e) => e.timestamp > since);
  return events;
}

// ── Tool Definitions ──────────────────────────────────────────────────

const tools: SkillToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_twap_order",
      description:
        "Create a TWAP order that splits a large swap into equal time-slices. " +
        "DIRECTION RULES: 'buy 100 GRG with ETH only 20 every 5 min' " +
        "-> side='buy', buyToken='GRG', sellToken='ETH', totalAmount='100', sliceAmount='20'. " +
        "'sell 50 ETH for USDC every 10 min' -> side='sell', sellToken='ETH', buyToken='USDC', totalAmount='50'. " +
        "The number ALWAYS belongs to the token next to it.",
      parameters: {
        type: "object",
        properties: {
          side: {
            type: "string",
            enum: ["buy", "sell"],
            description:
              "'buy' = totalAmount is in buyToken. 'sell' = totalAmount is in sellToken. " +
              "'buy 100 GRG' -> side='buy'. 'sell 50 ETH' -> side='sell'.",
          },
          sellToken: {
            type: "string",
            description: "Token to sell (symbol or address), e.g. 'ETH', 'USDC'",
          },
          buyToken: {
            type: "string",
            description: "Token to buy (symbol or address), e.g. 'GRG', 'USDC', 'ETH'",
          },
          totalAmount: {
            type: "string",
            description:
              "Total amount across all slices. Of buyToken when side='buy', sellToken when side='sell'.",
          },
          sliceAmount: {
            type: "string",
            description:
              "Amount per slice (same token as totalAmount). 'only 20 every 5 min' -> sliceAmount='20'. " +
              "sliceCount = ceil(totalAmount/sliceAmount). Takes priority over sliceCount/durationMinutes.",
          },
          intervalMinutes: {
            type: "number",
            description: "Minutes between each slice. Minimum 5. Default: 5.",
          },
          durationMinutes: {
            type: "number",
            description: "Total duration in minutes. sliceCount = durationMinutes / intervalMinutes.",
          },
          sliceCount: {
            type: "number",
            description: "Explicit number of slices. Lower priority than sliceAmount.",
          },
          dex: {
            type: "string",
            description: "DEX to use: '0x' (default) or 'uniswap'.",
          },
          chain: {
            type: "string",
            description: "Chain name or ID. Uses current chain if omitted.",
          },
          autoExecute: {
            type: "boolean",
            description: "When true (default), auto-executes. When false, notifies only.",
          },
        },
        required: ["side", "sellToken", "buyToken", "totalAmount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_twap_order",
      description:
        "Cancel a TWAP order by ID. Use list_twap_orders to see IDs. Pass id=0 to cancel all.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "TWAP order ID to cancel, or 0 to cancel all.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_twap_orders",
      description:
        "List all TWAP orders for the current vault, showing progress (slices executed/total), " +
        "amounts spent/remaining, and status.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

// ── Tool Handlers ─────────────────────────────────────────────────────

async function handleCreate(
  args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected — cannot create TWAP order.");
  }

  const side = (args.side as string || "sell") as "buy" | "sell";
  const sellToken = args.sellToken as string;
  const buyToken = args.buyToken as string;
  const totalAmount = args.totalAmount as string;
  const intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.round(Number(args.intervalMinutes) || 5));
  const dex = (args.dex as string) || "0x";
  const chain = args.chain as string | undefined;
  const autoExecute = args.autoExecute !== false;

  // Resolve the target chain early — needed for token resolution
  const targetChainId = chain ? (resolveChainId(chain) ?? ctx.chainId) : ctx.chainId;

  // ── Resolve token addresses at creation time ──
  // This validates that both tokens exist on the target chain BEFORE creating
  // the strategy. Prevents cron-time failures like "GRG not found on chain 8453".
  // Stores resolved addresses so execution uses them directly (no CoinGecko needed).
  initTokenResolver(env.KV);
  let sellTokenAddress: string | undefined;
  let buyTokenAddress: string | undefined;
  try {
    sellTokenAddress = await resolveTokenAddress(targetChainId, sellToken);
  } catch (err) {
    throw new Error(
      `Cannot resolve sell token "${sellToken}" on ${resolveChainName(targetChainId)} (chain ${targetChainId}). ` +
      `${err instanceof Error ? err.message : String(err)}\n` +
      `Please provide the contract address instead of the symbol.`,
    );
  }
  try {
    buyTokenAddress = await resolveTokenAddress(targetChainId, buyToken);
  } catch (err) {
    throw new Error(
      `Cannot resolve buy token "${buyToken}" on ${resolveChainName(targetChainId)} (chain ${targetChainId}). ` +
      `${err instanceof Error ? err.message : String(err)}\n` +
      `Please provide the contract address instead of the symbol.`,
    );
  }

  // Slice count priority: sliceAmount > sliceCount > durationMinutes > default 5
  let sliceCount: number;
  if (args.sliceAmount) {
    const perSlice = parseFloat(args.sliceAmount as string);
    const total = parseFloat(totalAmount);
    sliceCount = (perSlice > 0 && total > 0) ? Math.max(1, Math.ceil(total / perSlice)) : 5;
  } else if (args.sliceCount) {
    sliceCount = Math.max(1, Math.round(Number(args.sliceCount)));
  } else if (args.durationMinutes) {
    sliceCount = Math.max(1, Math.round(Number(args.durationMinutes) / intervalMinutes));
  } else {
    sliceCount = 5;
  }

  const amountPerSlice = (parseFloat(totalAmount) / sliceCount).toFixed(6);
  const amountToken = side === "buy" ? buyToken : sellToken;

  const order = await addTwapOrder(env.KV, {
    vaultAddress: ctx.vaultAddress,
    chainId: targetChainId,
    operatorAddress: ctx.operatorAddress,
    side,
    sellToken,
    buyToken,
    sellTokenAddress,
    buyTokenAddress,
    totalAmount,
    sliceAmount: amountPerSlice,
    sliceCount,
    intervalMinutes,
    dex,
    autoExecute,
  });

  const totalDuration = sliceCount * intervalMinutes;
  const durationStr = totalDuration >= 60
    ? `${(totalDuration / 60).toFixed(totalDuration % 60 ? 1 : 0)} hour${totalDuration >= 120 ? "s" : ""}`
    : `${totalDuration} minutes`;

  const directionLabel = side === "buy"
    ? `Buy ${totalAmount} ${buyToken} with ${sellToken}`
    : `Sell ${totalAmount} ${sellToken} for ${buyToken}`;

  return {
    message:
      `✅ TWAP order #${order.id} created!\n\n` +
      `• ${directionLabel}\n` +
      `• ${sliceCount} slices of ~${amountPerSlice} ${amountToken} every ${intervalMinutes}m\n` +
      `• Duration: ${durationStr}\n` +
      `• DEX: ${dex}\n` +
      `• Mode: ${autoExecute ? "⚡ Auto-execute" : "🔔 Notify only"}\n` +
      `• First slice: next cron tick`,
    suggestions: ["List TWAP orders", "Cancel TWAP order"],
  };
}

async function handleCancel(
  args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult> {
  const id = Number(args.id);
  const orders = await getTwapOrders(env.KV, ctx.vaultAddress);

  if (id === 0) {
    const activeCount = orders.filter(o => o.active).length;
    const now = Date.now();
    const cancelled = orders.map(o => o.active ? { ...o, active: false, completedAt: now } : o);
    await saveTwapOrders(env.KV, ctx.vaultAddress, cancelled);
    return {
      message: activeCount > 0
        ? `✅ Cancelled all ${activeCount} active TWAP orders.`
        : "No active TWAP orders to cancel.",
      suggestions: ["Create a TWAP order"],
    };
  }

  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1 || !orders[idx].active) {
    return {
      message: `TWAP order #${id} not found or already completed. Use "list TWAP orders" to see active ones.`,
      suggestions: ["List TWAP orders"],
    };
  }
  orders[idx] = { ...orders[idx], active: false, completedAt: Date.now() };
  await saveTwapOrders(env.KV, ctx.vaultAddress, orders);
  return {
    message: `✅ TWAP order #${id} cancelled. ${orders[idx].slicesExecuted}/${orders[idx].sliceCount} slices were executed.`,
    suggestions: ["List TWAP orders", "Create a TWAP order"],
  };
}

async function handleList(
  _args: Record<string, unknown>,
  env: Env,
  ctx: RequestContext,
): Promise<SkillToolResult> {
  const orders = await getTwapOrders(env.KV, ctx.vaultAddress);

  if (orders.length === 0) {
    return {
      message: "No TWAP orders for this vault.",
      suggestions: ["Create a TWAP order"],
    };
  }

  const lines = orders.map(o => {
    const statusIcon = o.active ? "🔄" : o.completedAt ? "✅" : "❌";
    const statusLabel = o.active ? "active" : o.completedAt ? "completed" : "cancelled";
    const progress = `${o.slicesExecuted}/${o.sliceCount} slices`;
    const spent = o.amountSpent ? ` | Spent: ${parseFloat(o.amountSpent).toFixed(4)} ${o.sellToken}` : "";
    const bought = o.totalBought ? ` | Bought: ${parseFloat(o.totalBought).toFixed(4)} ${o.buyToken}` : "";
    const side = o.side || "sell";
    const dirLabel = side === "buy"
      ? `Buy ${o.totalAmount} ${o.buyToken} with ${o.sellToken}`
      : `Sell ${o.totalAmount} ${o.sellToken} → ${o.buyToken}`;
    return `  **#${o.id}** ${statusIcon} ${statusLabel} — ${dirLabel} | ${progress}${spent}${bought} | every ${o.intervalMinutes}m`;
  });

  return {
    message: `📋 **TWAP Orders:**\n\n${lines.join("\n")}`,
    suggestions: orders.some(o => o.active)
      ? ["Cancel TWAP order", "Create a TWAP order"]
      : ["Create a TWAP order"],
  };
}

// ── Cron Executor ─────────────────────────────────────────────────────

async function runDueTwapOrders(env: Env, _processChat: ProcessChatFn): Promise<void> {
  const kv = env.KV;
  const now = Date.now();
  const list = await kv.list({ prefix: TWAP_PREFIX });

  for (const key of list.keys) {
    const vaultAddr = key.name.slice(TWAP_PREFIX.length);
    let orders: TwapOrder[];
    try {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      orders = JSON.parse(raw) as TwapOrder[];
    } catch { continue; }

    let changed = false;

    for (const order of orders) {
      if (!order.active) continue;

      const elapsed = now - (order.lastExecution || order.createdAt);
      // Cloudflare cron ticks are not perfectly aligned to minute boundaries.
      // Allow a wider jitter window so a run at e.g. ~4m10s does not skip and
      // push the next execution to ~10m.
      const dueMs = order.intervalMinutes * 60_000;
      const jitterToleranceMs = 60_000;
      if (elapsed + jitterToleranceMs < dueMs) continue;

      if (order.slicesExecuted >= order.sliceCount) {
        order.active = false;
        order.completedAt = now;
        changed = true;
        continue;
      }

      const sliceNum = order.slicesExecuted + 1;
      const chainName = resolveChainName(order.chainId);
      const side = order.side || "sell";
      const sliceToken = side === "buy" ? order.buyToken : order.sellToken;
      console.log(
        `[TWAP] Executing slice ${sliceNum}/${order.sliceCount} for order #${order.id}: ` +
        `${side} ${order.sliceAmount} ${sliceToken} on ${chainName}`,
      );

      try {
        // Direct tool call — bypasses the LLM entirely for deterministic execution.
        // Each slice calls build_vault_swap with structured args (token addresses,
        // amount, chain, dex). This is faster, cheaper, and fully deterministic
        // compared to the old approach of formatting a natural language instruction
        // and routing it through processChat → LLM → tool call.
        const sellRef = order.sellTokenAddress || order.sellToken;
        const buyRef = order.buyTokenAddress || order.buyToken;

        const toolArgs: Record<string, unknown> = side === "buy"
          ? { tokenOut: buyRef, tokenIn: sellRef, amountOut: order.sliceAmount, dex: order.dex || "uniswap" }
          : { tokenIn: sellRef, tokenOut: buyRef, amountIn: order.sliceAmount, dex: order.dex || "uniswap" };
        toolArgs.chain = chainName;

        const ctx: RequestContext = {
          vaultAddress: order.vaultAddress as Address,
          chainId: order.chainId,
          operatorAddress: order.operatorAddress as Address,
          executionMode: order.autoExecute ? "delegated" : "manual",
        };

        const toolResult = await executeToolCall(env, ctx, "build_vault_swap", toolArgs);

        const txList = toolResult.transaction ? [toolResult.transaction] : [];

        if (txList.length === 0) {
          throw new Error(toolResult.message || "No swap transaction produced");
        }

        if (order.autoExecute) {
          const outcomes = await executeTxList(env, txList, order.vaultAddress);
          const hasFailure = outcomes.some((o) => o.error || o.result?.reverted);
          if (hasFailure) {
            throw new Error(`Slice execution failed: ${formatOutcomesMarkdown(outcomes)}`);
          }

          const sliceMeta = txList[0]?.swapMeta;
          const sellAmount = sliceMeta?.sellAmount || (side === "sell" ? order.sliceAmount : "0");
          const buyAmount = sliceMeta?.buyAmount || (side === "buy" ? order.sliceAmount : "0");

          const spentNum = parseFloat(order.amountSpent) + (parseFloat(sellAmount) || 0);
          const boughtNum = parseFloat(order.totalBought) + (parseFloat(buyAmount) || 0);
          order.amountSpent = spentNum.toString();
          order.totalBought = boughtNum.toString();
          order.slicesExecuted += 1;
          order.lastExecution = now;
          order.consecutiveFailures = 0;
          order.lastError = undefined;
          changed = true;

          if (order.slicesExecuted >= order.sliceCount) {
            order.active = false;
            order.completedAt = now;
          }

          await recordTwapEvent(kv, order.vaultAddress, {
            orderId: order.id, timestamp: now, sliceNumber: sliceNum,
            totalSlices: order.sliceCount, sellAmount,
            buyAmount, success: true,
          });

          if (env.TELEGRAM_BOT_TOKEN) {
            const telegramUserId = await getTelegramUserIdByAddress(kv, order.operatorAddress);
            if (telegramUserId) {
              const isComplete = !order.active;
              const completionNote = isComplete
                ? `\n\n✅ <b>TWAP order complete!</b> Total: ${order.amountSpent} ${order.sellToken} → ${order.totalBought} ${order.buyToken}`
                : side === "buy"
                  ? `\nProgress: ${order.slicesExecuted}/${order.sliceCount} slices (${order.totalBought}/${order.totalAmount} ${order.buyToken} target, ${order.amountSpent} ${order.sellToken} spent)`
                  : `\nProgress: ${order.slicesExecuted}/${order.sliceCount} slices (${order.amountSpent}/${order.totalAmount} ${order.sellToken} spent)`;
              const text = [
                `<b>⚡ TWAP #${order.id} — Slice ${sliceNum}/${order.sliceCount}</b>`,
                `Swapped ${sellAmount} ${order.sellToken} → ~${buyAmount} ${order.buyToken} on ${chainName}`,
                completionNote,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            }
          }
        } else {
          order.lastExecution = now;
          order.slicesExecuted += 1;
          changed = true;

          if (order.slicesExecuted >= order.sliceCount) {
            order.active = false;
            order.completedAt = now;
          }

          if (env.TELEGRAM_BOT_TOKEN) {
            const telegramUserId = await getTelegramUserIdByAddress(kv, order.operatorAddress);
            if (telegramUserId) {
              const text = [
                `<b>🔔 TWAP #${order.id} — Slice ${sliceNum}/${order.sliceCount} ready</b>`,
                `Swap ${order.sliceAmount} ${order.sellToken} → ${order.buyToken} on ${chainName}`,
                `\nSign in the web app or set up delegation for auto-execution.`,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            }
          }
        }
      } catch (err) {
        order.lastExecution = now;
        order.consecutiveFailures += 1;
        const rawError = err instanceof Error ? err.message : String(err);
        order.lastError = sanitizeError(rawError);
        changed = true;

        await recordTwapEvent(kv, order.vaultAddress, {
          orderId: order.id, timestamp: now, sliceNumber: sliceNum,
          totalSlices: order.sliceCount, sellAmount: order.sliceAmount,
          buyAmount: "0", success: false, error: order.lastError.slice(0, 400),
        }).catch(() => {});

        // Notify on EVERY failure, not just auto-pause
        if (env.TELEGRAM_BOT_TOKEN) {
          const telegramUserId = await getTelegramUserIdByAddress(kv, order.operatorAddress);
          if (telegramUserId) {
            if (order.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              order.active = false;
              const text = [
                `<b>⚠️ TWAP #${order.id} paused</b>`,
                `Paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
                `Last error: <code>${escapeHtml(order.lastError || "unknown")}</code>`,
                `Progress: ${order.slicesExecuted}/${order.sliceCount} slices completed.`,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            } else {
              const text = [
                `<b>❌ TWAP #${order.id} — Slice ${sliceNum}/${order.sliceCount} failed</b>`,
                `Error: <code>${escapeHtml(order.lastError || "unknown")}</code>`,
                `Failures: ${order.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} (pauses at ${MAX_CONSECUTIVE_FAILURES})`,
              ].join("\n");
              await sendMessage(env.TELEGRAM_BOT_TOKEN, telegramUserId, text);
            }
          }
        }
        console.error(`[TWAP] Order #${order.id} (${order.vaultAddress}) slice failed:`, err);
      }
    }

    if (changed) {
      await saveTwapOrders(kv, vaultAddr, orders);
    }
  }
}

// ── Skill Export ───────────────────────────────────────────────────────

export const twapSkill: StrategySkill = {
  name: "twap",
  description: "Time-Weighted Average Price — deterministic time-sliced swaps",

  tools,

  toolNames: ["create_twap_order", "cancel_twap_order", "list_twap_orders"],

  systemPrompt: [
    "TWAP ORDERS (TIME-WEIGHTED AVERAGE PRICE):",
    "- Use create_twap_order for time-sliced buying/selling. Each slice is a deterministic swap.",
    "- DIRECTION: 'buy 100 GRG with ETH only 20 every 5 min' -> side='buy', buyToken='GRG',",
    "  sellToken='ETH', totalAmount='100', sliceAmount='20'. The 100 and 20 refer to GRG (buy token).",
    "  'sell 50 ETH for USDC every 10 min' -> side='sell', sellToken='ETH', totalAmount='50'.",
    "- 'only N every X min' or 'N at a time' -> that N is sliceAmount.",
    "  sliceCount = ceil(totalAmount/sliceAmount). Do NOT set durationMinutes when sliceAmount is given.",
    "- Use create_twap_order for all automated time-sliced trades.",
    "- cancel_twap_order (id=0 cancels all). list_twap_orders shows progress.",
  ].join("\n"),

  async handleToolCall(toolName, args, env, ctx) {
    if (!ctx.operatorVerified) {
      throw new Error("Operator authentication required for TWAP operations.");
    }

    switch (toolName) {
      case "create_twap_order": return handleCreate(args, env, ctx);
      case "cancel_twap_order": return handleCancel(args, env, ctx);
      case "list_twap_orders":  return handleList(args, env, ctx);
      default: return null;
    }
  },

  runDue: runDueTwapOrders,
};
