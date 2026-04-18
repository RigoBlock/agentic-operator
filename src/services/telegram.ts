/**
 * Telegram Bot API client.
 *
 * Thin wrapper over the Telegram Bot HTTP API.
 * All methods are stateless — just HTTP calls with the bot token.
 *
 * Docs: https://core.telegram.org/bots/api
 */

// ── Telegram API types (minimal subset we need) ──────────────────────

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  date: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  first_name?: string;
  username?: string;
}

export interface TgInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TgInlineKeyboardMarkup {
  inline_keyboard: TgInlineKeyboardButton[][];
}

// ── Bot API client ───────────────────────────────────────────────────

const API_BASE = "https://api.telegram.org/bot";

/** Call a Telegram Bot API method. */
async function callTg<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API ${method}: ${data.description || "unknown error"}`);
  }
  return data.result as T;
}

/** Send a text message (Markdown V2). */
export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  options?: {
    replyMarkup?: TgInlineKeyboardMarkup;
    parseMode?: "MarkdownV2" | "HTML";
  },
): Promise<TgMessage> {
  return callTg<TgMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode ?? "HTML",
    reply_markup: options?.replyMarkup,
    disable_web_page_preview: true,
  });
}

/** Edit an existing message's text. */
export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  options?: {
    replyMarkup?: TgInlineKeyboardMarkup;
    parseMode?: "MarkdownV2" | "HTML";
  },
): Promise<void> {
  await callTg(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: options?.parseMode ?? "HTML",
    reply_markup: options?.replyMarkup,
    disable_web_page_preview: true,
  });
}

/** Answer a callback query (dismiss the loading indicator on inline buttons). */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await callTg(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

/** Send a "typing…" chat action. */
export async function sendChatAction(
  token: string,
  chatId: number,
): Promise<void> {
  await callTg(token, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

/** Delete a message by ID. */
export async function deleteMessage(
  token: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  await callTg(token, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/** Set the webhook URL for the bot. Called once during setup. */
export async function setWebhook(
  token: string,
  url: string,
  secret?: string,
): Promise<void> {
  await callTg(token, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40,
  });
}

// KV key for the registered webhook URL (used by cron re-registration)
export const WEBHOOK_URL_KV_KEY = "tg-webhook-url";

/**
 * Derive a deterministic webhook secret from a base secret string.
 * Telegram allows 1–256 chars, A-Za-z0-9_- only.
 *
 * @deprecated Use getWebhookSecret(env) instead. This exists only for
 * backwards-compatibility when TELEGRAM_WEBHOOK_SECRET is not set.
 */
export async function deriveWebhookSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(`tg-webhook-secret:${secret}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from(bytes.slice(0, 32), (b) => chars[b % chars.length]).join("");
}

/**
 * Get the effective webhook secret.
 * Prefers TELEGRAM_WEBHOOK_SECRET directly (no derivation needed).
 * Falls back to deriving from CDP_WALLET_SECRET for backwards compatibility.
 */
export async function getWebhookSecret(
  env: { TELEGRAM_WEBHOOK_SECRET?: string; CDP_WALLET_SECRET?: string },
): Promise<string | undefined> {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    return env.TELEGRAM_WEBHOOK_SECRET;
  }
  if (env.CDP_WALLET_SECRET) {
    return deriveWebhookSecret(env.CDP_WALLET_SECRET);
  }
  return undefined;
}

/**
 * Re-register the webhook using a URL stored in KV.
 * Called from the cron trigger to keep the webhook registration fresh.
 * No-ops silently if no URL is stored yet (webhook not set up via /pair or /setup).
 */
export async function ensureWebhookRegistered(
  token: string,
  kv: KVNamespace,
  secret?: string,
): Promise<void> {
  const storedUrl = await kv.get(WEBHOOK_URL_KV_KEY);
  if (!storedUrl) return; // never set up — operator must generate a pairing code first
  try {
    await setWebhook(token, storedUrl, secret);
    console.log(`[telegram] Webhook refreshed from cron: ${storedUrl}`);
  } catch (err) {
    console.warn(`[telegram] Cron webhook refresh failed: ${err}`);
  }
}

/** Remove the webhook (for debugging / switching to polling). */
export async function deleteWebhook(token: string): Promise<void> {
  await callTg(token, "deleteWebhook", { drop_pending_updates: true });
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Escape special characters for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert LLM response text to Telegram-friendly HTML.
 * Strips markdown tables (Telegram doesn't render them) and converts
 * markdown bold/code to HTML tags.
 */
export function formatForTelegram(text: string): string {
  let result = escapeHtml(text);
  // **bold** → <b>bold</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Markdown links [text](url) → HTML <a>
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2">$1</a>',
  );
  // Collapse triple+ newlines
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}
