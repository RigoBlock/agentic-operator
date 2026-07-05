/**
 * Telegram webhook route — POST /api/telegram/webhook
 *
 * Receives updates from the Telegram Bot API and routes them:
 *   - /start, /help   → usage instructions
 *   - /pair <code>     → link Telegram to web account
 *   - /pool [name]     → switch active vault
 *   - /pools           → list paired vaults
 *   - /slippage <pct>  → set default slippage
 *   - /swapshield <pct>|reset → set/reset swap-shield tolerance
 *   - /navshield <pct>|reset  → set/reset NAV-shield threshold
 *   - /clear           → reset conversation
 *   - /unpair <addr>   → remove a vault link
 *   - text messages    → processChat() (LLM + tools)
 *   - callback queries → trade execution confirmation
 *
 * Also:
 *   POST /api/telegram/pair      → generate pairing code (from web)
 *   POST /api/telegram/setup     → register webhook URL with Telegram
 */

import { Hono, type Context } from "hono";
import type { Env, ChatMessage, RequestContext, ChatResponse, TelegramConversation, UnsignedTransaction } from "../types.js";
import { formatUnits, type Address } from "viem";
import { processChat, executeToolCall, type ToolResult } from "../llm/client.js";
import {
  handle_set_default_slippage,
  handle_set_swap_shield_tolerance,
  handle_enable_swap_shield,
  handle_set_nav_shield_threshold,
  handle_enable_nav_shield,
} from "../llm/handlers/settings.js";
import { getDelegationConfig, getActiveChains } from "../services/delegation.js";
import { getAgentWalletInfo } from "../services/agentWallet.js";
import { getCurrentDayBucket, DEFAULT_GAS_SPENDING_LIMIT_USD, GAS_SPEND_KEY } from "./gasPolicy.js";
import { executeTxList, checkPendingTxStatus, type TxExecOutcome } from "../services/execution.js";
import {
  runTransactionFlow,
  getExecutionModePreference,
  setExecutionModePreference,
} from "../services/transactionFlow.js";
import { initTokenResolver } from "../services/tokenResolver.js";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  sendChatAction,
  deleteMessage,
  setWebhook,
  deriveWebhookSecret,
  getWebhookSecret,
  WEBHOOK_URL_KV_KEY,
  formatForTelegram,
  escapeHtml,
  type TgUpdate,
  type TgInlineKeyboardMarkup,
} from "../services/telegram.js";
import {
  verifyPairingCode,
  getTelegramUser,
  saveTelegramUser,
  getConversation,
  saveConversation,
  clearConversation,
  switchActiveVault,
  unlinkVault,
  createPairingCode,
  getTelegramUserIdByAddress,
} from "../services/telegramPairing.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { getVaultInfo } from "../services/vault.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS, sanitizeError } from "../config.js";
import type { TelegramVaultLink } from "../types.js";

const telegram = new Hono<{ Bindings: Env }>();

/** Strip accidental tool-name prefixes like [build_vault_swap]: from LLM/tool output. */
function stripToolPrefix(text: string): string {
  return text.replace(/^\[[A-Za-z0-9_-]+\]:\s*/, "");
}

/** Format a numeric percentage string for Telegram display. */
function formatTelegramPct(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  let formatted = num.toFixed(4).replace(/\.?0+$/, "");
  if (formatted === "-0") formatted = "0";
  return `${formatted}%`;
}

/** Detect whether a reply contains a non-blocking safety warning that should
 *  change the confirmation header from "Trade ready" to "Trade ready with warning".
 */
function hasSafetyWarning(reply: string): boolean {
  return /⚠️\s*Swap Shield|⚠️\s*NAV|⚠️\s*Simulation warning|not oracle-verified/i.test(reply);
}

/** Format per-transaction safety metrics for Telegram confirmation messages. */
function formatTelegramTxMetrics(tx: UnsignedTransaction): string {
  if (!tx.metrics) return "";
  const m = tx.metrics as Record<string, Record<string, unknown>>;
  const lines: string[] = [];
  if (m.navShield?.navImpactPct != null) {
    // impactPct is signed: positive = NAV improved, negative = NAV dropped.
    lines.push(`📉 NAV impact: ${formatTelegramPct(m.navShield.navImpactPct)}`);
  }
  if (m.swapShield?.divergencePct != null) {
    lines.push(`🔮 Oracle divergence: ${formatTelegramPct(m.swapShield.divergencePct)}`);
  }
  return lines.length ? lines.join("\n") : "";
}

/** Build the KV key for a message-bound pending transaction.
 *  Each confirm-mode message gets its own key so that tapping Execute on one
 *  message can never act on a transaction prepared for a different message.
 */
export function pendingTxKey(userId: string | number, messageId: number): string {
  return `tg-pending-tx:${userId}:${messageId}`;
}

/** Delete every pending-tx KV key for a user (including any legacy shared key)
 *  and return the stored entries so their Telegram messages can be edited. */
export async function deleteAllPendingTxKeys(kv: KVNamespace, userId: string | number): Promise<{ messageId?: number }[]> {
  const prefix = `tg-pending-tx:${userId}:`;
  const entries: { messageId?: number }[] = [];

  // Message-bound keys
  const list = await kv.list<{ messageId?: number }>({ prefix });
  for (const key of list.keys) {
    try {
      const raw = await kv.get(key.name);
      const parsed = raw ? (JSON.parse(raw) as { messageId?: number }) : { messageId: key.metadata?.messageId };
      entries.push(parsed);
    } catch {
      entries.push({});
    }
    await kv.delete(key.name);
  }

  // Legacy shared key — kept during transition so old buttons become no-ops
  try {
    const raw = await kv.get(`tg-pending-tx:${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { messageId?: number };
      entries.push(parsed);
    }
  } catch {
    // ignore parse errors
  }
  await kv.delete(`tg-pending-tx:${userId}`);

  return entries;
}

/**
 * Parse a suggestion-chip label to see if it should bypass the LLM entirely.
 * Returns a direct action (tool invocation or static reply) for known GMX chips.
 */
export function parseTelegramDirectChip(label: string):
  | { type: "tool"; toolName: string; args: Record<string, unknown> }
  | { type: "reply"; text: string }
  | null {
  const lower = label.toLowerCase().trim();

  // Fully-specified, read-only chips → invoke tool directly
  if (lower === "refresh positions") {
    return { type: "tool", toolName: "gmx_get_positions", args: {} };
  }
  if (lower === "show gmx markets") {
    return { type: "tool", toolName: "gmx_get_markets", args: {} };
  }

  // Opening a position requires parameters we can't collect from an inline button.
  // Reply with a concrete prompt instead of routing through the LLM.
  if (lower === "open new position" || lower === "open a position") {
    return {
      type: "reply",
      text:
        "To open a new GMX position, type your request, for example:\n" +
        "• <code>long 1000 ETHUSDC 5x</code>\n" +
        "• <code>short 500 BTC 10x</code>",
    };
  }
  if (lower === "open a long") {
    return {
      type: "reply",
      text: "To open a long, type:\n<code>long &lt;size&gt; &lt;market&gt; &lt;leverage&gt;</code>\nExample: <code>long 1000 ETHUSDC 5x</code>",
    };
  }
  if (lower === "open a short") {
    return {
      type: "reply",
      text: "To open a short, type:\n<code>short &lt;size&gt; &lt;market&gt; &lt;leverage&gt;</code>\nExample: <code>short 500 BTC 10x</code>",
    };
  }

  // Cancel order needs an order key — prompt for it directly.
  if (lower === "cancel order") {
    return {
      type: "reply",
      text:
        "To cancel a pending order, type:\n" +
        "<code>cancel order 0xOrderKey</code>\n" +
        "You can get the order key from your positions.",
    };
  }

  return null;
}

/**
 * Send the result of a direct tool invocation to Telegram and persist the turn.
 * Handles read-only tool results (message + suggestion chips + conversation).
 */
async function sendDirectToolResult(
  env: Env,
  token: string,
  userId: number,
  chatId: number,
  ctx: RequestContext,
  toolResult: ToolResult,
  userMessageText: string,
): Promise<void> {
  const replyParts: string[] = [];
  if (toolResult.message) {
    replyParts.push(formatForTelegram(stripToolPrefix(toolResult.message)));
  }
  const fullReply = replyParts.join("\n\n") || "Done.";
  const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;

  let keyboard: TgInlineKeyboardMarkup | undefined;
  if (toolResult.suggestions?.length) {
    keyboard = {
      inline_keyboard: [
        toolResult.suggestions.slice(0, 3).map((s) => ({
          text: s,
          callback_data: `say:${s.slice(0, 60)}`,
        })),
      ],
    };
  }

  await sendMessage(token, chatId, truncated, { replyMarkup: keyboard });

  // Persist the turn so follow-up messages retain context.
  let conv = await getConversation(env.KV, userId);
  if (!conv || conv.vaultAddress.toLowerCase() !== (ctx.vaultAddress as Address).toLowerCase()) {
    conv = {
      messages: [],
      vaultAddress: ctx.vaultAddress as Address,
      chainId: ctx.chainId,
      lastActivity: Date.now(),
    };
  }
  conv.messages.push({ role: "user", content: userMessageText });
  const assistantContent = toolResult.message ? stripToolPrefix(toolResult.message).slice(0, 1500) : "";
  if (assistantContent.trim()) {
    conv.messages.push({ role: "assistant", content: assistantContent });
  }
  if (toolResult.chainSwitch) {
    conv.chainId = toolResult.chainSwitch;
  }
  await saveConversation(env.KV, userId, conv);
}

// ── Webhook: receives Telegram updates ────────────────────────────────

telegram.post("/webhook", async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return c.json({ error: "Telegram not configured" }, 503);
  }

  // Verify the webhook secret (prevents forged requests even if bot token leaks)
  const expected = await getWebhookSecret(c.env);
  if (expected) {
    const received = c.req.header("x-telegram-bot-api-secret-token") || "";
    if (received !== expected) {
      // Secret mismatch means the webhook was registered without a secret (or the
      // secret rotated). Re-register with the correct secret in the background so
      // future updates arrive with the correct token.
      const webhookUrl = `${new URL(c.req.url).origin}/api/telegram/webhook`;
      console.warn(`[telegram] Webhook secret mismatch — re-registering ${webhookUrl} (processing update anyway)`);
      c.executionCtx.waitUntil(
        Promise.all([
          setWebhook(token, webhookUrl, expected)
            .then(() => {})
            .catch(err => console.warn("[telegram] Webhook re-registration failed:", err)),
          c.env.KV.put(WEBHOOK_URL_KV_KEY, webhookUrl),
        ]),
      );
      // IMPORTANT: Do NOT drop the update — process it below. The bot token itself
      // already authenticates this webhook URL (only Telegram knows it). Dropping
      // updates on secret mismatch causes complete bot silence when the webhook was
      // registered without a secret or the secret rotated.
    }
  }

  let update: TgUpdate;
  try {
    update = await c.req.json<TgUpdate>();
  } catch {
    return c.json({ ok: true }); // malformed — acknowledge silently
  }

  // Process async — Telegram expects a fast 200 OK
  c.executionCtx.waitUntil(handleUpdate(c.env, token, update));

  return c.json({ ok: true });
});

// ── Pair endpoint (called from web UI) ────────────────────────────────

// ── Unpair endpoint (called from web UI) ──────────────────────────────

telegram.post("/unpair", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      authSignature: string;
      authTimestamp: number;
      chainId: number;
    }>();

    // Verify the caller is actually the vault owner
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    // Find their Telegram user ID via operator address
    const tgUserId = await getTelegramUserIdByAddress(
      c.env.KV,
      body.operatorAddress as Address,
    );
    if (!tgUserId) {
      return c.json({ error: "No Telegram account paired to this wallet" }, 404);
    }

    const removed = await unlinkVault(c.env.KV, tgUserId, body.vaultAddress);
    if (!removed) {
      return c.json({ error: "Vault not found in linked list" }, 404);
    }

    return c.json({ ok: true, message: "Vault unlinked from Telegram" });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    const msg = err instanceof Error ? err.message : "Internal error";
    return c.json({ error: sanitizeError(msg) }, 500);
  }
});

// ── Pair endpoint (called from web UI) ────────────────────────────────

telegram.post("/pair", async (c) => {
  try {
    const body = await c.req.json<{
      operatorAddress: string;
      vaultAddress: string;
      vaultName: string;
      chainId: number;
      authSignature: string;
      authTimestamp: number;
    }>();

    // Verify the caller is actually the vault owner
    await verifyOperatorAuth({
      operatorAddress: body.operatorAddress,
      vaultAddress: body.vaultAddress,
      authSignature: body.authSignature,
      authTimestamp: body.authTimestamp,
      preferredChainId: body.chainId,
      alchemyKey: c.env.ALCHEMY_API_KEY,
    });

    const code = await createPairingCode(
      c.env.KV,
      body.operatorAddress as Address,
      body.vaultAddress as Address,
      body.vaultName,
      body.chainId,
    );

    // Auto-register the webhook with the correct secret and store the URL in KV
    // so the cron trigger can keep it fresh even without user action.
    if (c.env.TELEGRAM_BOT_TOKEN) {
      try {
        const webhookSecret = await getWebhookSecret(c.env);
        const webhookUrl = `${new URL(c.req.url).origin}/api/telegram/webhook`;
        await setWebhook(c.env.TELEGRAM_BOT_TOKEN, webhookUrl, webhookSecret);
        await c.env.KV.put(WEBHOOK_URL_KV_KEY, webhookUrl);
      } catch (err) {
        // Don't fail the pairing — code is still valid even if webhook update fails
        console.warn(`[telegram] Webhook registration failed on pair: ${err}`);
      }
    }

    return c.json({ code });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    const msg = err instanceof Error ? err.message : "Internal error";
    return c.json({ error: sanitizeError(msg) }, 500);
  }
});

// ── Setup: register webhook URL with Telegram ─────────────────────────
// Exposed as both GET and POST to avoid Cloudflare WAF blocking bare POSTs.
// Protected: requires CDP_WALLET_SECRET as query param or X-Admin-Secret header.

function verifyAdminSecret(c: Context<{ Bindings: Env }>): boolean {
  const secret = c.env.CDP_WALLET_SECRET;
  if (!secret) return false;
  const provided = c.req.query("secret") || c.req.header("x-admin-secret") || "";
  return provided === secret;
}

const setupHandler = async (c: Context<{ Bindings: Env }>) => {
  if (!verifyAdminSecret(c)) return c.json({ error: "Unauthorized" }, 401);

  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);

  let urlOverride: string | undefined;
  if (c.req.method === "POST") {
    const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
    urlOverride = body.url;
  } else {
    urlOverride = c.req.query("url");
  }
  const host = urlOverride || new URL(c.req.url).origin;
  const webhookUrl = `${host}/api/telegram/webhook`;

  // Get the webhook secret so Telegram sends it with every update
  const secret = await getWebhookSecret(c.env);

  await setWebhook(token, webhookUrl, secret);
  await c.env.KV.put(WEBHOOK_URL_KV_KEY, webhookUrl);
  return c.json({ ok: true, webhookUrl });
};

telegram.post("/setup", setupHandler);
telegram.get("/setup", setupHandler);

// ── Diagnostic: check webhook status from Telegram's side ─────────────
// Protected: requires CDP_WALLET_SECRET.

telegram.get("/debug", async (c) => {
  if (!verifyAdminSecret(c)) return c.json({ error: "Unauthorized" }, 401);

  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);

  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json();
  return c.json(data);
});

// ── Update handler (runs async after 200 OK) ─────────────────────────

async function handleUpdate(env: Env, token: string, update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(env, token, update.callback_query);
      return;
    }

    if (update.message?.text) {
      await handleMessage(env, token, update.message);
      return;
    }
  } catch (err) {
    console.error("[telegram] handleUpdate error:", err);
    // Try to notify the user about the error
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await sendMessage(token, chatId, `⚠️ Internal error: ${escapeHtml(sanitizeError(msg).slice(0, 200))}`).catch(() => {});
    }
    // Don't re-throw — Telegram will retry endlessly
  }
}

// ── Message handler ───────────────────────────────────────────────────

async function handleMessage(
  env: Env,
  token: string,
  msg: { message_id: number; from?: { id: number; username?: string }; chat: { id: number }; text?: string },
): Promise<void> {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text?.trim() || "";
  const username = msg.from?.username;

  if (!userId) return;

  // ── Command routing ──
  if (text.startsWith("/")) {
    const [cmd, ...args] = text.split(/\s+/);
    const command = cmd.toLowerCase();

    switch (command) {
      case "/start": {
        // Deep link: /start CODE → auto-pair
        const deepLinkCode = args[0];
        if (deepLinkCode && deepLinkCode.length >= 4) {
          const result = await verifyPairingCode(env.KV, deepLinkCode, userId, username);
          await sendMessage(token, chatId, result.message);
          return;
        }
        await sendHelpMessage(token, chatId);
        return;
      }
      case "/help":
        await sendHelpMessage(token, chatId);
        return;

      case "/pair": {
        const code = args[0];
        if (!code) {
          await sendMessage(token, chatId, "Usage: <code>/pair CODE</code>\n\nGenerate a code from the web app's Telegram pairing button.");
          return;
        }
        const result = await verifyPairingCode(env.KV, code, userId, username);
        await sendMessage(token, chatId, result.message);
        return;
      }

      case "/pools": {
        const user = await getTelegramUser(env.KV, userId);
        if (!user || user.vaults.length === 0) {
          await sendMessage(token, chatId, "No vaults paired. Use the web app to generate a pairing code.");
          return;
        }
        const lines = user.vaults.map((v, i) => {
          const active = i === user.activeVaultIndex ? " ✅" : "";
          const addr = `${v.address.slice(0, 6)}…${v.address.slice(-4)}`;
          const chainName = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS].find((c) => c.id === v.chainId)?.name || String(v.chainId);
          return `${i + 1}. <b>${escapeHtml(v.name)}</b> (${addr}) · ${chainName}${active}`;
        });
        await sendMessage(token, chatId, `<b>Your Vaults:</b>\n${lines.join("\n")}\n\nSwitch with: <code>/pool name</code>`);
        return;
      }

      case "/pool": {
        const identifier = args.join(" ");
        if (!identifier) {
          await sendMessage(token, chatId, "Usage: <code>/pool name-or-address</code>");
          return;
        }
        const vault = await switchActiveVault(env.KV, userId, identifier);
        if (vault) {
          await sendMessage(token, chatId, `Switched to <b>${escapeHtml(vault.name)}</b> (${vault.address.slice(0, 6)}…). Conversation reset.`);
        } else {
          await sendMessage(token, chatId, "No matching vault found. Use <code>/pools</code> to see your linked vaults.");
        }
        return;
      }

      case "/clear":
        await clearConversation(env.KV, userId);
        await sendMessage(token, chatId, "Conversation cleared.");
        return;

      case "/model": {
        const pick = args[0]?.toLowerCase();
        if (!pick) {
          await sendMessage(token, chatId,
            "Current model: <b>Kimi K2.7 Code</b>.\n\n" +
            "The agent handles reasoning, tool calling, and multi-step planning natively.",
          );
          return;
        }
        await sendMessage(token, chatId,
          "Model switching is no longer supported. Kimi K2.7 Code is the fixed model.",
        );
        return;
      }

      case "/mode": {
        // Toggle between autonomous (auto-execute) and confirm (show Execute button) modes.
        // The preference is stored in a unified KV key shared with the web UI.
        const modeUser = await getTelegramUser(env.KV, userId);
        const modeOperator = modeUser?.vaults[0]?.operatorAddress;
        const pick = args[0]?.toLowerCase();
        if (!pick) {
          const mode = modeOperator
            ? await getExecutionModePreference(env.KV, modeOperator)
            : "confirm";
          await sendMessage(token, chatId,
            `Current mode: <b>${mode === "autonomous" ? "⚡ Autonomous" : "🔔 Confirm"}</b>\n\n` +
            `<code>/mode autonomous</code> — execute trades immediately (requires delegation)\n` +
            `<code>/mode confirm</code> — show Execute/Cancel buttons before each trade`,
          );
          return;
        }
        if (!modeOperator) {
          await sendMessage(token, chatId, "No vault paired. Pair a vault first to set execution mode.");
          return;
        }
        if (pick === "autonomous" || pick === "auto") {
          await setExecutionModePreference(env.KV, modeOperator, "autonomous");
          await sendMessage(token, chatId, "Switched to <b>⚡ Autonomous</b> — trades execute immediately when delegation is active.");
        } else if (pick === "confirm" || pick === "manual") {
          await setExecutionModePreference(env.KV, modeOperator, "confirm");
          await sendMessage(token, chatId, "Switched to <b>🔔 Confirm</b> — you'll see Execute/Cancel buttons before each trade.");
        } else {
          await sendMessage(token, chatId,
            `Unknown mode "<code>${escapeHtml(pick)}</code>".\nUse <code>/mode autonomous</code> or <code>/mode confirm</code>.`,
          );
        }
        return;
      }

      case "/stipend": {
        const stipendUser = await getTelegramUser(env.KV, userId);
        if (!stipendUser || stipendUser.vaults.length === 0) {
          await sendMessage(token, chatId, "You haven't paired any vaults yet. Use the web app to pair Telegram first.");
          return;
        }
        const stipendVault = stipendUser.vaults[stipendUser.activeVaultIndex];
        if (!stipendVault) {
          await sendMessage(token, chatId, "No active vault. Use <code>/pools</code> to select one.");
          return;
        }
        const agentInfo = await getAgentWalletInfo(env.KV, stipendVault.address);
        if (!agentInfo) {
          await sendMessage(token, chatId, "No agent wallet found for this vault. Delegation may not be set up yet.");
          return;
        }
        const agentAddress = agentInfo.address.toLowerCase();
        const dayBucket = getCurrentDayBucket();
        const spendKey = `${GAS_SPEND_KEY}${agentAddress}:${dayBucket}`;

        const spentRaw = await env.KV.get(spendKey);
        const limitUsd = Number(env.GAS_SPENDING_LIMIT_USD || String(DEFAULT_GAS_SPENDING_LIMIT_USD));
        const spent = spentRaw ? Number(formatUnits(BigInt(spentRaw), 18)) : 0;
        const remaining = Math.max(0, limitUsd - spent);
        await sendMessage(
          token,
          chatId,
          `⛽ Gas sponsorship stipend\n\n` +
          `Vault: <code>${stipendVault.address}</code>\n` +
          `Agent wallet: <code>${agentInfo.address}</code>\n\n` +
          `Daily limit: <b>$${limitUsd.toFixed(2)}</b>\n` +
          `Spent today: <b>$${spent.toFixed(4)}</b>\n` +
          `Remaining: <b>$${remaining.toFixed(4)}</b>\n\n` +
          `The stipend is tracked per vault (agent wallet), matching Alchemy's per-sender metering. ` +
          `Resets at UTC midnight.`,
        );
        return;
      }

      case "/slippage":
      case "/swapshield":
      case "/navshield": {
        const settingsUser = await getTelegramUser(env.KV, userId);
        if (!settingsUser || settingsUser.vaults.length === 0) {
          await sendMessage(token, chatId, "You haven't paired any vaults yet. Use the web app to pair Telegram first.");
          return;
        }
        const settingsVault = settingsUser.vaults[settingsUser.activeVaultIndex];
        if (!settingsVault) {
          await sendMessage(token, chatId, "No active vault. Use <code>/pools</code> to select one.");
          return;
        }
        const settingsCtx: RequestContext = {
          vaultAddress: settingsVault.address,
          chainId: settingsVault.chainId,
          operatorAddress: settingsVault.operatorAddress || settingsUser.operatorAddress,
          operatorVerified: true,
          isBrowserRequest: false,
          executionMode: "manual",
        };
        try {
          let result: { message: string };
          if (command === "/slippage") {
            const value = args.join(" ").trim();
            if (!value) {
              await sendMessage(token, chatId,
                "Usage: <code>/slippage 0.5%</code>\nValid range: 0.1% – 5%.");
              return;
            }
            result = await handle_set_default_slippage(env, settingsCtx, { slippage: value }, "set_default_slippage");
          } else if (command === "/swapshield") {
            const value = args.join(" ").trim().toLowerCase();
            if (!value) {
              await sendMessage(token, chatId,
                "Usage: <code>/swapshield 30%</code> or <code>/swapshield reset</code>\nMax temporary tolerance: 50%.");
              return;
            }
            if (value === "reset") {
              result = await handle_enable_swap_shield(env, settingsCtx, {}, "enable_swap_shield");
            } else {
              result = await handle_set_swap_shield_tolerance(env, settingsCtx, { tolerance: value }, "set_swap_shield_tolerance");
            }
          } else {
            // /navshield
            const value = args.join(" ").trim().toLowerCase();
            if (!value) {
              await sendMessage(token, chatId,
                "Usage: <code>/navshield 15%</code> or <code>/navshield reset</code>\nValid range: 1% – 100%.");
              return;
            }
            if (value === "reset") {
              result = await handle_enable_nav_shield(env, settingsCtx, {}, "enable_nav_shield");
            } else {
              result = await handle_set_nav_shield_threshold(env, settingsCtx, { threshold: value }, "set_nav_shield_threshold");
            }
          }
          await sendMessage(token, chatId, formatForTelegram(result.message));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await sendMessage(token, chatId, `⚠️ ${escapeHtml(sanitizeError(msg).slice(0, 300))}`);
        }
        return;
      }

      case "/unpair": {
        const addr = args[0];
        if (!addr) {
          await sendMessage(token, chatId, "Usage: <code>/unpair 0xVaultAddress</code>");
          return;
        }
        const removed = await unlinkVault(env.KV, userId, addr);
        await sendMessage(token, chatId, removed ? "Vault unlinked." : "Vault not found in your linked list.");
        return;
      }

      case "/reset": {
        // Complete reset — wipe all Telegram state for this user
        const userToReset = await getTelegramUser(env.KV, userId);
        const keysToDelete: string[] = [
          `tg-user:${userId}`,
          `tg-conv:${userId}`,
          `tg-model:${userId}`,
        ];
        // Also clean up reverse lookups for all linked operators and the
        // unified execution-mode preference keys shared with the web UI.
        if (userToReset) {
          const operators = new Set(
            userToReset.vaults
              .map(v => v.operatorAddress?.toLowerCase())
              .filter(Boolean),
          );
          if (userToReset.operatorAddress) {
            operators.add(userToReset.operatorAddress.toLowerCase());
          }
          for (const op of operators) {
            keysToDelete.push(`tg-addr:${op}`);
            keysToDelete.push(`operator-pref:${op}:exec-mode`);
          }
        }
        await Promise.all([
          ...keysToDelete.map(k => env.KV.delete(k)),
          deleteAllPendingTxKeys(env.KV, userId),
        ]);
        await sendMessage(
          token,
          chatId,
          "🔄 Reset complete — all vaults, conversations, and preferences cleared.\n\nTo start fresh, pair a vault from the web app or use <code>/pair CODE</code>.",
        );
        return;
      }

      case "/addpool": {
        // Auto-discover vaults owned by the paired operator across all chains
        const user = await getTelegramUser(env.KV, userId);
        if (!user) {
          await sendMessage(token, chatId, "Pair at least one vault first using <code>/pair CODE</code>.");
          return;
        }
        await sendChatAction(token, chatId);
        const vaultAddr = args[0];
        if (!vaultAddr || vaultAddr.length !== 42 || !vaultAddr.startsWith("0x")) {
          await sendMessage(
            token, chatId,
            "Usage: <code>/addpool 0xVaultAddress</code>\n\nI'll check all supported chains for this vault and link it if you're the owner.",
          );
          return;
        }
        // Scan all chains in parallel
        const allChains = [...SUPPORTED_CHAINS, ...TESTNET_CHAINS];
        const results = await Promise.allSettled(
          allChains.map(async (ch) => {
            const info = await getVaultInfo(ch.id, vaultAddr as `0x${string}`, env.ALCHEMY_API_KEY);
            return { ...info, chainId: ch.id };
          }),
        );
        // Collect all known operator addresses from the user's vault links
        const knownOperators = new Set<string>();
        knownOperators.add(user.operatorAddress.toLowerCase());
        for (const v of user.vaults) {
          if (v.operatorAddress) knownOperators.add(v.operatorAddress.toLowerCase());
        }

        // Collect ALL chains where this vault exists and is owned by ANY known operator
        type VaultResult = { address: Address; name: string; symbol: string; owner: Address; totalSupply: string; chainId: number };
        const foundVaults: VaultResult[] = [];
        for (const r of results) {
          if (r.status === "fulfilled" && knownOperators.has(r.value.owner.toLowerCase())) {
            foundVaults.push(r.value as VaultResult);
          }
        }

        if (foundVaults.length === 0) {
          await sendMessage(
            token, chatId,
            "Could not find a vault at that address owned by any of your paired wallets on any supported chain.",
          );
          return;
        }

        // Add each chain variant to the user's vault list
        const addedNames: string[] = [];
        for (const vaultInfo of foundVaults) {
          const link: TelegramVaultLink = {
            address: vaultInfo.address,
            chainId: vaultInfo.chainId,
            name: vaultInfo.name,
            operatorAddress: vaultInfo.owner,  // use actual on-chain owner
          };
          const existing = user.vaults.findIndex(
            (v) => v.address.toLowerCase() === link.address.toLowerCase()
                  && v.chainId === link.chainId,
          );
          if (existing >= 0) {
            user.vaults[existing] = link;
          } else {
            user.vaults.push(link);
          }
          const chainName = allChains.find((c) => c.id === vaultInfo.chainId)?.name || String(vaultInfo.chainId);
          addedNames.push(`<b>${escapeHtml(vaultInfo.name)}</b> on ${chainName}`);
        }
        // Set the last added vault as active
        user.activeVaultIndex = user.vaults.length - 1;
        await saveTelegramUser(env.KV, user);
        await clearConversation(env.KV, userId);

        // Ensure reverse lookup exists for all operators (for strategy push notifications)
        const addedOperators = new Set(foundVaults.map((v) => v.owner.toLowerCase()));
        await Promise.all(
          [...addedOperators].map((op) =>
            env.KV.put(`tg-addr:${op}`, String(userId)),
          ),
        );

        const summary = addedNames.length === 1
          ? `✅ Found ${addedNames[0]}.\nIt's now your active vault — start trading!`
          : `✅ Found on ${addedNames.length} chains:\n${addedNames.map((n) => `• ${n}`).join("\n")}\n\nThe last one is active. Switch with <code>/pool name</code>.`;
        await sendMessage(token, chatId, summary);
        return;
      }

      default:
        // Unknown command — fall through to chat
        break;
    }
  }

  // ── Chat message → processChat() ──

  const user = await getTelegramUser(env.KV, userId);
  if (!user || user.vaults.length === 0) {
    await sendMessage(
      token,
      chatId,
      "You haven't paired any vaults yet.\n\n1. Open the web app\n2. Click the Telegram icon\n3. Send the code here with <code>/pair CODE</code>",
    );
    return;
  }

  const vault = user.vaults[user.activeVaultIndex];
  if (!vault) {
    await sendMessage(token, chatId, "No active vault. Use <code>/pools</code> to select one.");
    return;
  }

  // Show "typing…" and keep it alive while processing
  await sendChatAction(token, chatId);
  const typingInterval = setInterval(() => sendChatAction(token, chatId).catch(() => {}), 4000);

  // Load or create conversation
  let conv = await getConversation(env.KV, userId);
  if (!conv || conv.vaultAddress.toLowerCase() !== vault.address.toLowerCase()) {
    conv = {
      messages: [],
      vaultAddress: vault.address,
      chainId: vault.chainId,
      lastActivity: Date.now(),
    };
  }

  // Append user message
  conv.messages.push({ role: "user", content: text });

  // Discard any stale pending transaction. If the user sends a new message
  // instead of tapping Execute/Cancel, the old quote is no longer relevant
  // (sponsored transactions are only valid for ~3 minutes anyway).
  let staleTxNote: string | undefined;
  const stalePending = await deleteAllPendingTxKeys(env.KV, userId);
  if (stalePending.length > 0) {
    for (const pendingTx of stalePending) {
      if (pendingTx.messageId) {
        await editMessageText(
          token, chatId, pendingTx.messageId,
          "⏹️ Previous trade discarded — a new request replaced it.",
          { replyMarkup: { inline_keyboard: [] } },
        ).catch(() => {});
      }
    }
    staleTxNote = "The user's previous prepared transaction has been discarded because they sent a new request. Treat this as a fresh request.";
  }

  // Neutralize the last assistant turn if it advertised a pending transaction,
  // so the model doesn't ask the user about a stale confirmation state.
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === "assistant" && /🔔 .*ready\.|Tap ✅ Execute|Trade ready/i.test(conv.messages[i].content)) {
      conv.messages[i].content = "A transaction was prepared but not executed; it has been discarded because the user sent a new request.";
      staleTxNote = "The user's previous prepared transaction has been discarded. Treat this as a fresh request.";
      break;
    }
  }

  // Telegram is always treated as a delegated-style interface: the operator has
  // already verified vault ownership at pairing time, and we present Execute/Cancel
  // buttons for every ready transaction. The actual on-chain delegation check runs
  // when the user taps Execute.
  const executionMode = "delegated";

  // Telegram users proved vault ownership at pairing time (EIP-191 signature +
  // on-chain owner check). operatorVerified: true grants the same access as a
  // browser session with a signed auth message.
  const ctx: RequestContext = {
    vaultAddress: vault.address,
    chainId: vault.chainId,
    operatorAddress: vault.operatorAddress || user.operatorAddress,
    operatorVerified: true,
    isBrowserRequest: false,
    executionMode,
    aiModel: undefined,
    contextDocs: staleTxNote ? [staleTxNote] : undefined,
  };

  try {
    // Initialize token resolver
    if (env.KV) initTokenResolver(env.KV);

    // Live progress message: shows real-time status and tool results, then is deleted
    // before the final human-friendly reply is sent. This avoids duplicating output.
    let progressMsgId: number | undefined;
    let progressStatus = "Thinking…";
    const progressLines: string[] = [];

    const updateProgress = async () => {
      const parts: string[] = [escapeHtml(progressStatus)];
      if (progressLines.length > 0) {
        parts.push(progressLines.join("\n"));
      }
      const text = parts.join("\n\n");
      if (!progressMsgId) {
        const sent = await sendMessage(token, chatId, text).catch(() => null);
        if (sent?.message_id) progressMsgId = sent.message_id;
      } else {
        await editMessageText(token, chatId, progressMsgId, text).catch(() => {});
      }
    };

    const response: ChatResponse = await processChat(
      env,
      conv.messages as ChatMessage[],
      ctx,
      undefined,
      (event) => {
        switch (event.type) {
          case "status":
          case "text":
          case "reasoning":
            progressStatus = event.type === "status" ? event.message : "Reasoning…";
            void updateProgress().catch(() => {});
            break;
          case "tool_call":
            progressStatus = `Running ${event.name}…`;
            void updateProgress().catch(() => {});
            break;
          case "tool_result": {
            const resultText = stripToolPrefix(event.result);
            const hasWarning = !event.error && hasSafetyWarning(resultText);
            const prefix = event.error ? "⚠️ " : (hasWarning ? "⚠️ " : "✅ ");
            const firstLine = resultText.split("\n")[0].slice(0, 200);
            progressLines.push(`${prefix}${escapeHtml(firstLine)}`);
            void updateProgress().catch(() => {});
            break;
          }
          case "transaction":
            progressStatus = "Transaction ready";
            void updateProgress().catch(() => {});
            break;
        }
      },
    );
    clearInterval(typingInterval);

    // Delete progress message — final reply contains the single human-friendly output.
    if (progressMsgId) {
      await deleteMessage(token, chatId, progressMsgId).catch(() => {});
    }

    // Track chain switches in conversation state
    if (response.chainSwitch) {
      conv.chainId = response.chainSwitch;
      vault.chainId = response.chainSwitch;
    }

    // Collect all transactions (multi-tx or single)
    const txList = response.transactions && response.transactions.length > 0
      ? response.transactions
      : response.transaction
        ? [response.transaction]
        : [];

    // Build the Telegram reply from the single human-friendly LLM reply.
    // Tool results are intentionally NOT rendered again here — they were already
    // shown live in the progress message and are folded into response.reply.
    const replyParts: string[] = [];
    if (response.reply) {
      replyParts.push(formatForTelegram(stripToolPrefix(response.reply)));
    }

    // Handle transactions through the unified TransactionFlow engine.
    let executedNow = false;
    if (txList.length > 0) {
      const operatorAddress = vault.operatorAddress || user.operatorAddress;
      const mode = await getExecutionModePreference(env.KV, operatorAddress);

      // Shared helper: build per-transaction safety metrics lines.
      const buildMetricsLines = () => {
        const lines: string[] = [];
        for (let i = 0; i < txList.length; i++) {
          const metrics = formatTelegramTxMetrics(txList[i]);
          if (metrics) {
            lines.push(txList.length > 1 ? `<b>Trade ${i + 1}</b>\n${metrics}` : metrics);
          }
        }
        return lines;
      };

      // Optional: warn if delegation is not active on a transaction's chain.
      const delegConfig = await getDelegationConfig(env.KV, vault.address);
      const activeDelegChains = delegConfig ? getActiveChains(delegConfig) : [];
      const txChainIds = [...new Set(txList.map(tx => tx.chainId))];
      const missingChainNames = txChainIds
        .filter(chainId => !activeDelegChains.includes(chainId))
        .map(chainId => SUPPORTED_CHAINS.find(ch => ch.id === chainId)?.name
          || TESTNET_CHAINS.find(ch => ch.id === chainId)?.name
          || `Chain ${chainId}`);
      const delegationWarning = missingChainNames.length > 0
        ? `⚠️ Delegation is not active on ${missingChainNames.join(", ")}. ` +
          `Tapping Execute may fail until you set it up at <a href="https://trader.rigoblock.com">trader.rigoblock.com</a>.`
        : "";

      if (mode === "autonomous") {
        // ⚡ Autonomous mode — execute immediately, no confirmation needed
        const tradeCount = txList.length > 1 ? `${txList.length} trades` : "trade";
        const statusParts = [
          formatForTelegram(stripToolPrefix(response.reply)),
          `\n⚡ <b>Autonomous mode is ON — executing ${tradeCount} immediately.</b>`,
          `Use <code>/mode confirm</code> to require an Execute button before each trade.`,
          ...buildMetricsLines(),
          delegationWarning,
        ].filter(Boolean);
        const statusText = statusParts.join("\n\n");
        const truncated = statusText.length > 4000 ? statusText.slice(0, 3990) + "…" : statusText;
        const statusMsg = await sendMessage(token, chatId, truncated);
        const statusMsgId = statusMsg?.message_id;

        const flowResult = await runTransactionFlow(
          env,
          operatorAddress,
          vault.address,
          txList,
          response.reply,
          {
            requestConfirmation: async () => { /* autonomous path never calls this */ },
            onProgress: async (event) => {
              if (event.type === "start" && statusMsgId) {
                await editMessageText(token, chatId, statusMsgId, truncated).catch(() => {});
              }
            },
          },
          "autonomous",
        );

        if (flowResult.kind === "executed") {
          executedNow = true;
          const outcomes = flowResult.outcomes!;
          response.executionResults = outcomes
            .map(o => o.result)
            .filter((r): r is NonNullable<typeof r> => r != null);
          response.executionResult = response.executionResults[0];
          const summary = formatTelegramOutcomes(outcomes);
          const finalText = (truncated + "\n\n" + `✅ <b>Executed:</b>\n${summary}`).slice(0, 4000);
          if (statusMsgId) {
            await editMessageText(token, chatId, statusMsgId, finalText).catch(() => {});
          } else {
            await sendMessage(token, chatId, finalText);
          }
        }
      } else {
        // 🔔 Confirm mode (default) — show Execute/Cancel buttons for every ready tx
        const tradeCount = txList.length > 1 ? `${txList.length} trades` : "trade";
        const execLabel = txList.length > 1 ? "Execute All" : "Execute";
        const replyText = response.reply ?? "";
        const hasWarning = hasSafetyWarning(replyText);
        const confirmIcon = hasWarning ? "⚠️" : "🔔";
        const execIcon = hasWarning ? "⚠️" : "✅";
        const confirmParts = [
          formatForTelegram(stripToolPrefix(response.reply)),
          `\n${confirmIcon} <b>${tradeCount.charAt(0).toUpperCase() + tradeCount.slice(1)} ready${hasWarning ? " with warning" : ""}.</b>\nTap ${execIcon} ${execLabel} to confirm or ❌ Cancel.`,
          ...buildMetricsLines(),
          delegationWarning,
        ].filter(Boolean);
        const fullReply = confirmParts.join("\n\n");
        const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;
        const keyboard: TgInlineKeyboardMarkup = {
          inline_keyboard: [
            [
              { text: `${execIcon} ${execLabel}`, callback_data: `exec:${userId}` },
              { text: "❌ Cancel", callback_data: `cancel:${userId}` },
            ],
          ],
        };
        const sent = await sendMessage(token, chatId, truncated, { replyMarkup: keyboard });
        const messageId = sent?.message_id;
        if (messageId) {
          await env.KV.put(pendingTxKey(userId, messageId), JSON.stringify({ txs: txList, createdAt: Date.now(), messageId }), {
            expirationTtl: 120,
          });
        }

      }
    } else {
      const fullReply = replyParts.join("\n\n") || "Done.";
      const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;

      // Add suggestion chips as inline keyboard if present
      let keyboard: TgInlineKeyboardMarkup | undefined;
      if (response.suggestions?.length) {
        keyboard = {
          inline_keyboard: [
            response.suggestions.slice(0, 3).map((s) => ({
              text: s,
              callback_data: `say:${s.slice(0, 60)}`,
            })),
          ],
        };
      }

      await sendMessage(token, chatId, truncated, { replyMarkup: keyboard });
    }

    // Persist assistant turn — include tool results so the LLM has context on follow-ups.
    // Tool results are normally ephemeral (not in ChatMessage history), so we inline a
    // compact summary into the assistant message.  This avoids re-fetching balances,
    // positions, or NAV data that was already retrieved in this turn.
    {
      const toolSummary = (response.toolCalls ?? [])
        .filter(tc => !tc.error && tc.result)
        .map(tc => stripToolPrefix(tc.result!.slice(0, 500)))
        .join("\n---\n");
      // In confirm mode, make sure the saved history records that the transaction
      // was prepared but NOT executed. Otherwise the LLM may see a "ready" message
      // on a follow-up and hallucinate an execution result.
      const pendingNote =
        txList.length > 0 && !executedNow
          ? "🔔 Transaction ready in Telegram — awaiting your confirmation (tap Execute). It has NOT been executed yet."
          : "";
      const assistantContent = [
        pendingNote,
        toolSummary,
        response.reply,
      ].filter(Boolean).join("\n\n");
      if (assistantContent.trim()) {
        conv.messages.push({ role: "assistant", content: assistantContent });
      }
    }
    await saveConversation(env.KV, userId, conv);

  } catch (err) {
    clearInterval(typingInterval);
    console.error("[telegram] processChat error:", err);
    const rawMsg = err instanceof Error ? err.message : "Unknown error";
    const safeMsg = sanitizeError(rawMsg);
    await sendMessage(token, chatId, `⚠️ Error: ${escapeHtml(safeMsg.slice(0, 200))}`);
  }
}

// ── Callback query handler (inline keyboard buttons) ──────────────────

async function handleCallbackQuery(
  env: Env,
  token: string,
  query: { id: string; from: { id: number; username?: string }; message?: { message_id: number; chat: { id: number } }; data?: string },
): Promise<void> {
  const data = query.data || "";
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    await answerCallbackQuery(token, query.id);
    return;
  }

  // ── Suggestion chip: bypass the LLM for known direct-action chips ──
  if (data.startsWith("say:")) {
    const text = data.slice(4);
    const direct = parseTelegramDirectChip(text);

    if (!direct) {
      // Unknown chip — fall back to normal LLM flow
      await answerCallbackQuery(token, query.id);
      await handleMessage(env, token, {
        message_id: 0,
        from: query.from,
        chat: { id: chatId },
        text,
      });
      return;
    }

    await answerCallbackQuery(token, query.id, "Processing…");

    if (direct.type === "reply") {
      await sendMessage(token, chatId, direct.text);
      return;
    }

    // Direct tool invocation
    await sendChatAction(token, chatId);

    const user = await getTelegramUser(env.KV, userId);
    if (!user || user.vaults.length === 0) {
      await sendMessage(
        token,
        chatId,
        "You haven't paired any vaults yet.\n\n1. Open the web app\n2. Click the Telegram icon\n3. Send the code here with <code>/pair CODE</code>",
      );
      return;
    }

    const vault = user.vaults[user.activeVaultIndex];
    if (!vault) {
      await sendMessage(token, chatId, "No active vault. Use <code>/pools</code> to select one.");
      return;
    }

    if (env.KV) initTokenResolver(env.KV);

    const ctx: RequestContext = {
      vaultAddress: vault.address,
      chainId: vault.chainId,
      operatorAddress: vault.operatorAddress || user.operatorAddress,
      operatorVerified: true,
      isBrowserRequest: false,
      executionMode: "delegated",
    };

    try {
      const toolResult = await executeToolCall(env, ctx, direct.toolName, direct.args);
      await sendDirectToolResult(env, token, userId, chatId, ctx, toolResult, text);
    } catch (err) {
      console.error("[telegram] direct tool error:", err);
      const rawMsg = err instanceof Error ? err.message : "Unknown error";
      const safeMsg = sanitizeError(rawMsg);
      await sendMessage(token, chatId, `⚠️ ${escapeHtml(safeMsg.slice(0, 300))}`);
    }
    return;
  }

  // ── Trade execution ──
  if (data.startsWith("exec:")) {
    await answerCallbackQuery(token, query.id, "Executing…");

    // The pending transaction is bound to the message the user tapped. This
    // prevents a stale shared KV entry from causing the wrong transaction to
    // be executed when multiple confirm-mode messages exist.
    const txKey = pendingTxKey(userId, messageId);
    const raw = await env.KV.get(txKey);
    if (!raw) {
      await editMessageText(token, chatId, messageId, "⏰ Trade expired. Please request a new quote.");
      return;
    }

    // Parse stored transactions — supports legacy (array/single tx) and new { txs, createdAt } format
    const parsed = JSON.parse(raw);
    // Defense-in-depth: reject if the stored entry belongs to a different message.
    if (parsed.messageId != null && parsed.messageId !== messageId) {
      await editMessageText(token, chatId, messageId, "⏰ Trade expired. Please request a new quote.");
      return;
    }
    const rawTxs = parsed.txs ? parsed.txs : (Array.isArray(parsed) ? parsed : [parsed]);
    const storedAt: number | undefined = parsed.createdAt;
    const txList: UnsignedTransaction[] = (rawTxs as Record<string, unknown>[]).map(
      (t: Record<string, unknown>) => ({
        to: t.to as Address,
        data: t.data as `0x${string}`,
        value: (t.value as string) || "0x0",
        chainId: t.chainId as number,
        gas: (t.gas as string) || "0x0",
        description: (t.description as string) || "",
        swapMeta: t.swapMeta as UnsignedTransaction["swapMeta"],
      }),
    );

    // Warn if the quote is likely stale (>90s old)
    const ageMs = storedAt ? Date.now() - storedAt : undefined;
    const isLikelyStale = ageMs !== undefined && ageMs > 90_000;
    const hasSwaps = txList.some(tx => tx.swapMeta);

    // Delete pending txs
    await env.KV.delete(txKey);

    // Update message to show "executing…"
    const progressLabel = txList.length > 1 ? `Executing ${txList.length} trades…` : "Executing trade…";
    await editMessageText(token, chatId, messageId, `⏳ ${progressLabel}`);

    // The vault address is always tx.to (validated by executeViaDelegation)
    const vaultAddress = txList[0].to;

    // Keep the user informed during long mainnet sponsorship polling. For a
    // single transaction, update the elapsed time every 5 seconds.
    const executionStart = Date.now();
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    if (txList.length === 1) {
      progressTimer = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - executionStart) / 1000);
        editMessageText(
          token, chatId, messageId,
          `⏳ Executing trade… (${elapsedSec}s)`,
        ).catch(() => {});
      }, 5_000);
    }

    const outcomes = await executeTxList(env, txList, vaultAddress, async (idx, total, soFar) => {
      if (total > 1) {
        const done = soFar.length > 0 ? "\n\n" + formatTelegramOutcomes(soFar) : "";
        await editMessageText(
          token, chatId, messageId,
          `⏳ Executing trade ${idx + 1} of ${total}…${done}`,
        ).catch(() => {});
      }
    });

    if (progressTimer) clearInterval(progressTimer);

    // Separate outcomes into final states vs. still-pending (e.g., sponsored
    // mainnet tx whose status check timed out before on-chain confirmation).
    const pendingOutcomes = outcomes.filter(o => o.result && !o.result.confirmed && !o.result.reverted);
    const finalOutcomes = outcomes.filter(o => !pendingOutcomes.includes(o));

    const hasErrors = finalOutcomes.some(o => o.error || o.result?.reverted);
    const allFinalSuccess = finalOutcomes.every(o => o.result?.confirmed && !o.result?.reverted) && finalOutcomes.length > 0;

    // Detect stale swap quote failures: simulation failed on a swap that sat too long
    const hasSimFailure = outcomes.some(o => o.error?.includes("simulation failed") || o.error?.includes("would revert"));
    let staleHint = "";
    if (hasSimFailure && hasSwaps) {
      staleHint = isLikelyStale
        ? "\n\n💡 The swap quote likely expired before execution. Swap quotes are valid for ~2 minutes. Please request the swap again for a fresh quote."
        : "\n\n💡 The swap may have reverted due to an expired quote or changed market conditions. Please request the swap again for a fresh quote.";
    }

    // Build the summary we have so far.
    const resultLines = formatTelegramOutcomes([...finalOutcomes, ...pendingOutcomes]);
    const header = allFinalSuccess && !hasErrors && pendingOutcomes.length === 0
      ? (txList.length > 1 ? `✅ <b>All ${txList.length} trades confirmed</b>` : "✅ <b>Trade confirmed</b>")
      : hasErrors
        ? "⚠️ <b>Some trades failed</b>"
        : (txList.length > 1 ? `⏳ <b>${txList.length} trades submitted</b>` : "⏳ <b>Trade submitted</b>");
    const finalMsg = `${header}\n\n${resultLines}${staleHint}`;
    const truncated = finalMsg.length > 4000 ? finalMsg.slice(0, 3990) + "…" : finalMsg;
    await editMessageText(token, chatId, messageId, truncated);

    // Update conversation context so the next user message doesn't see a stale
    // "Trade ready" prompt.
    await updatePendingAssistantMessage(
      env.KV,
      userId,
      allFinalSuccess && pendingOutcomes.length === 0
        ? (txList.length > 1 ? `All ${txList.length} trades confirmed.` : "Trade confirmed.")
        : hasErrors
          ? "Some trades failed."
          : "Trade submitted — waiting for on-chain confirmation.",
    );

    // For pending sponsored transactions, keep polling in the background and
    // update the Telegram message once they land. This handles the common case
    // where Alchemy's waitForCallsStatus times out before mainnet confirmation.
    if (pendingOutcomes.length > 0) {
      pollPendingTelegramTxs(env, token, chatId, messageId, pendingOutcomes, userId, staleHint).catch(err =>
        console.error("[telegram] Background pending-tx polling failed:", err),
      );
    }

    return;
  }

  // ── Trade cancellation ──
  if (data.startsWith("cancel:")) {
    await answerCallbackQuery(token, query.id, "Cancelled");
    const txKey = pendingTxKey(userId, messageId);
    await env.KV.delete(txKey);
    await editMessageText(token, chatId, messageId, "Trade cancelled.");

    // Update conversation context so the next user message doesn't see a stale
    // "Trade ready" prompt.
    await updatePendingAssistantMessage(env.KV, userId, "Trade cancelled.");
    return;
  }

  await answerCallbackQuery(token, query.id);
}

/** Format TxExecOutcome[] as Telegram HTML lines */
function formatTelegramOutcomes(outcomes: TxExecOutcome[]): string {
  const lines: string[] = [];
  for (const { tx, result, error, fallbackToManual } of outcomes) {
    const meta = tx.swapMeta;
    const desc = meta
      ? `${meta.sellAmount} ${meta.sellToken} → ${meta.buyAmount} ${meta.buyToken}`
      : tx.description || "Transaction";

    if (result?.confirmed) {
      const gasInfo = result.gasCostEth ? ` (gas: ${result.gasCostEth} ETH)` : "";
      const link = result.explorerUrl ? `<a href="${result.explorerUrl}">↗</a>` : "";
      lines.push(`✅ ${escapeHtml(desc)}${gasInfo} ${link}`);
    } else if (result?.reverted) {
      const link = result.explorerUrl ? `<a href="${result.explorerUrl}">↗</a>` : "";
      lines.push(`❌ ${escapeHtml(desc)} — reverted ${link}`);
    } else if (result) {
      const isSponsoredTimeout = result.sponsored && result.gasCostEth?.includes("timed out");
      const pendingNote = isSponsoredTimeout
        ? "\n(status check timed out; may still confirm)"
        : "";
      const isUserOpHash = result.sponsored && result.userOpHash && result.txHash === result.userOpHash;
      const hashLabel = isUserOpHash ? "UserOp hash" : "Hash";
      const sponsoredHint = result.sponsored && !isUserOpHash
        ? "\n(sponsored UserOp — may not appear in the public mempool until it lands)"
        : "";
      const userOpNote = isUserOpHash
        ? "\n(sponsored UserOp — not yet on-chain; the EVM tx hash will appear once it lands)"
        : "";
      lines.push(
        `⏳ ${escapeHtml(desc)} — submitted\n` +
        `${hashLabel}: <code>${escapeHtml(result.txHash)}</code>${sponsoredHint}${userOpNote}${pendingNote}\n` +
        `Reply with "status" or "is my transaction stuck?" for an update.`
      );
    } else if (error) {
      // Provide actionable guidance for delegation errors
      if (error.includes("not in the delegated selectors") || error.includes("selector") && error.includes("not")) {
        lines.push(
          `⚠️ ${escapeHtml(desc)} — a required function selector is not delegated. ` +
          `Visit <a href="https://trader.rigoblock.com">trader.rigoblock.com</a> to re-setup delegation on this chain.`,
        );
      } else if (error.includes("Delegation not active on chain") || error.includes("Delegation not configured")) {
        const chainName = SUPPORTED_CHAINS.find(ch => error.includes(String(ch.id)))?.name
          || TESTNET_CHAINS.find(ch => error.includes(String(ch.id)))?.name
          || "this chain";
        lines.push(`⚠️ ${escapeHtml(desc)} — delegation not set up on ${chainName}. Visit <a href="https://trader.rigoblock.com">trader.rigoblock.com</a> to activate.`);
      } else if (fallbackToManual || /sponsorship|sponsor|paymaster/i.test(error)) {
        lines.push(
          `⚠️ ${escapeHtml(desc)}\n\n${escapeHtml(error.slice(0, 400))}\n\n` +
          `This transaction cannot be executed from Telegram. ` +
          `Open <a href="https://trader.rigoblock.com">trader.rigoblock.com</a> to sign it from your wallet, ` +
          `or fund your agent wallet with native currency so future trades execute automatically.`,
        );
      } else {
        lines.push(`⚠️ ${escapeHtml(desc)} — ${escapeHtml(error.slice(0, 150))}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Background polling for Telegram trades that returned a pending status.
 * Keeps checking on-chain receipts and edits the original Telegram message
 * once each pending tx confirms or reverts.
 */
async function pollPendingTelegramTxs(
  env: Env,
  token: string,
  chatId: number,
  messageId: number,
  pendingOutcomes: TxExecOutcome[],
  userId: number,
  staleHint: string,
): Promise<void> {
  const pollIntervalMs = 5_000;
  const maxPollMs = 3 * 60 * 1_000; // 3 minutes matches Alchemy policy expiry
  const start = Date.now();

  const mutableOutcomes = pendingOutcomes.map(o => ({ ...o }));

  while (Date.now() - start < maxPollMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    let changed = false;
    for (const outcome of mutableOutcomes) {
      if (!outcome.result || outcome.result.confirmed || outcome.result.reverted) continue;

      const status = await checkPendingTxStatus(env, outcome.result.txHash, outcome.result.chainId).catch(() => null);
      if (status) {
        outcome.result = status;
        changed = true;
      }
    }

    if (!changed) continue;

    const allDone = mutableOutcomes.every(o => o.result?.confirmed || o.result?.reverted);
    const resultLines = formatTelegramOutcomes(mutableOutcomes);
    const allSuccess = mutableOutcomes.every(o => o.result?.confirmed && !o.result?.reverted);
    const hasErrors = mutableOutcomes.some(o => o.result?.reverted || o.error);

    const header = allSuccess
      ? (mutableOutcomes.length > 1 ? `✅ <b>All ${mutableOutcomes.length} trades confirmed</b>` : "✅ <b>Trade confirmed</b>")
      : hasErrors
        ? "⚠️ <b>Some trades failed</b>"
        : (mutableOutcomes.length > 1 ? `⏳ <b>${mutableOutcomes.length} trades submitted</b>` : "⏳ <b>Trade submitted</b>");
    const msg = `${header}\n\n${resultLines}${staleHint}`;
    const truncated = msg.length > 4000 ? msg.slice(0, 3990) + "…" : msg;
    await editMessageText(token, chatId, messageId, truncated).catch(() => {});

    await updatePendingAssistantMessage(
      env.KV,
      userId,
      allSuccess
        ? (mutableOutcomes.length > 1 ? `All ${mutableOutcomes.length} trades confirmed.` : "Trade confirmed.")
        : hasErrors
          ? "Some trades failed."
          : "Trade submitted — waiting for on-chain confirmation.",
    );

    if (allDone) break;
  }
}

/** Replace the last assistant message that advertised a pending Telegram transaction. */
async function updatePendingAssistantMessage(
  kv: KVNamespace,
  userId: number,
  replacement: string,
): Promise<void> {
  const conv = await getConversation(kv, userId);
  if (!conv) return;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === "assistant" && /🔔 .*ready\.|Tap ✅ Execute|Trade ready/i.test(conv.messages[i].content)) {
      conv.messages[i].content = replacement;
      break;
    }
  }
  await saveConversation(kv, userId, conv);
}

// ── Help message ──────────────────────────────────────────────────────

async function sendHelpMessage(token: string, chatId: number): Promise<void> {
  const text = [
    "<b>🤖 Rigoblock Trader</b>",
    "",
    "Control your smart pool directly from Telegram.",
    "",
    "<b>Setup:</b>",
    "1. Open <a href=\"https://trader.rigoblock.com\">trader.rigoblock.com</a> and click the Telegram icon (⬡)",
    "2. Click \"Open in Telegram\" — pairing is automatic!",
    "   Or manually: <code>/pair CODE</code>",
    "",
    "<b>Trading:</b>",
    "Just type what you want to do:",
    "• <i>swap 0.5 ETH for USDC</i>",
    "• <i>buy 100 GRG with ETH on Arbitrum</i>",
    "• <i>long 1000 ETHUSDC 5x</i>",
    "• <i>show my positions</i>",
    "",
    "<b>Commands:</b>",
    "/pools — list paired vaults",
    "/pool &lt;name&gt; — switch active vault",
    "/addpool &lt;0xAddr&gt; — add vault by address",
    "/slippage &lt;0.5%&gt; — set default slippage",
    "/swapshield &lt;30%&gt; | reset — temporary oracle-divergence tolerance",
    "/navshield &lt;15%&gt; | reset — max NAV drop threshold",
    "/mode [autonomous|confirm] — toggle auto-execute or confirm",
    "/clear — reset conversation",
    "/unpair &lt;addr&gt; — unlink a vault",
    "/reset — wipe all state and start fresh",
    "/help — this message",
    "",
    "<b>Note:</b> Trades execute automatically via your agent wallet (delegation). Set up delegation in the <a href=\"https://trader.rigoblock.com\">web app</a> first.",
  ].join("\n");

  await sendMessage(token, chatId, text);
}

export { telegram };
