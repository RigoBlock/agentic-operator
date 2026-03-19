/**
 * Telegram webhook route — POST /api/telegram/webhook
 *
 * Receives updates from the Telegram Bot API and routes them:
 *   - /start, /help   → usage instructions
 *   - /pair <code>     → link Telegram to web account
 *   - /pool [name]     → switch active vault
 *   - /pools           → list paired vaults
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
import type { Address } from "viem";
import { processChat } from "../llm/client.js";
import { isDelegationActive, isDelegationActiveAnyChain, getDelegationConfig, getActiveChains } from "../services/delegation.js";
import { executeTxList, type TxExecOutcome } from "../services/execution.js";
import { initTokenResolver } from "../services/tokenResolver.js";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  sendChatAction,
  deleteMessage,
  setWebhook,
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

/**
 * Derive a deterministic webhook secret from AGENT_WALLET_SECRET.
 * This is sent to Telegram via setWebhook(secret_token) and verified
 * on every incoming request via X-Telegram-Bot-Api-Secret-Token header.
 * This way, even if the bot token leaks, attackers can't call our webhook.
 */
async function deriveWebhookSecret(agentSecret: string): Promise<string> {
  const data = new TextEncoder().encode(`tg-webhook-secret:${agentSecret}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  // Telegram allows 1-256 chars, A-Za-z0-9_-
  const bytes = new Uint8Array(hash);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from(bytes.slice(0, 32), (b) => chars[b % chars.length]).join("");
}

// ── Webhook: receives Telegram updates ────────────────────────────────

telegram.post("/webhook", async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return c.json({ error: "Telegram not configured" }, 503);
  }

  // Verify the webhook secret (prevents forged requests even if bot token leaks)
  if (c.env.AGENT_WALLET_SECRET) {
    const expected = await deriveWebhookSecret(c.env.AGENT_WALLET_SECRET);
    const received = c.req.header("x-telegram-bot-api-secret-token") || "";
    if (received !== expected) {
      console.warn("[telegram] Webhook secret mismatch — rejecting request");
      return c.json({ ok: true }); // silent ack to avoid Telegram retries
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
// Protected: requires AGENT_WALLET_SECRET as query param or X-Admin-Secret header.

function verifyAdminSecret(c: Context<{ Bindings: Env }>): boolean {
  const secret = c.env.AGENT_WALLET_SECRET;
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

  // Derive a webhook secret so Telegram sends it with every update
  const secret = c.env.AGENT_WALLET_SECRET
    ? await deriveWebhookSecret(c.env.AGENT_WALLET_SECRET)
    : undefined;

  await setWebhook(token, webhookUrl, secret);
  return c.json({ ok: true, webhookUrl });
};

telegram.post("/setup", setupHandler);
telegram.get("/setup", setupHandler);

// ── Diagnostic: check webhook status from Telegram's side ─────────────
// Protected: requires AGENT_WALLET_SECRET.

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

  // Check if delegation is active on current chain OR any chain
  // This allows multi-chain swaps where target chains have delegation
  const delegationOnCurrentChain = await isDelegationActive(env.KV, vault.address, vault.chainId);
  const delegationOnAnyChain = delegationOnCurrentChain || await isDelegationActiveAnyChain(env.KV, vault.address);
  const executionMode = delegationOnAnyChain ? "delegated" : "manual";

  const ctx: RequestContext = {
    vaultAddress: vault.address,
    chainId: vault.chainId,
    operatorAddress: vault.operatorAddress || user.operatorAddress,
    executionMode,
  };

  try {
    // Initialize token resolver
    if (env.KV) initTokenResolver(env.KV);

    // Track progress message for intermediate tool results
    let progressMsgId: number | undefined;
    const progressLines: string[] = [];

    const response: ChatResponse = await processChat(
      env,
      conv.messages as ChatMessage[],
      ctx,
      async (toolName, result, isError) => {
        // Show intermediate tool results as a live-updating message
        const prefix = isError ? "⚠️ " : "✅ ";
        // Show a short summary — first line of the result, max 200 chars
        const firstLine = result.split("\n")[0].slice(0, 200);
        progressLines.push(`${prefix}${escapeHtml(firstLine)}`);
        const text = progressLines.join("\n");
        if (!progressMsgId) {
          const sent = await sendMessage(token, chatId, text).catch(() => null);
          if (sent?.message_id) progressMsgId = sent.message_id;
        } else {
          await editMessageText(token, chatId, progressMsgId, text).catch(() => {});
        }
      },
    );
    clearInterval(typingInterval);

    // Delete progress message — final reply will contain full details
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

    // Build the Telegram reply
    let replyParts: string[] = [];

    // Tool results
    if (response.toolCalls?.length) {
      for (const tc of response.toolCalls) {
        if (tc.result && !tc.error) {
          replyParts.push(formatForTelegram(tc.result));
        }
        if (tc.error && tc.result) {
          replyParts.push(`⚠️ ${formatForTelegram(tc.result)}`);
        }
      }
    }

    // LLM reply
    if (response.reply) {
      replyParts.push(formatForTelegram(response.reply));
    }

    // Handle transactions
    if (txList.length > 0 && executionMode === "delegated") {
      // Pre-check per-chain delegation for each transaction
      const delegConfig = await getDelegationConfig(env.KV, vault.address);
      const activeDelegChains = delegConfig ? getActiveChains(delegConfig) : [];
      const executableTxs: UnsignedTransaction[] = [];
      const blockedTxs: { tx: UnsignedTransaction; chainName: string }[] = [];

      for (const tx of txList) {
        const chainName = SUPPORTED_CHAINS.find(ch => ch.id === tx.chainId)?.name
          || TESTNET_CHAINS.find(ch => ch.id === tx.chainId)?.name
          || String(tx.chainId);
        if (activeDelegChains.includes(tx.chainId)) {
          executableTxs.push(tx);
        } else {
          blockedTxs.push({ tx, chainName });
        }
      }

      // Warn about chains without delegation
      if (blockedTxs.length > 0) {
        const blockedLabels = blockedTxs.map(({ tx, chainName }) => {
          const meta = tx.swapMeta;
          const label = meta
            ? `${meta.sellAmount} ${meta.sellToken} → ${meta.buyAmount} ${meta.buyToken}`
            : tx.description || "Transaction";
          return `• ${escapeHtml(label)} — <b>${chainName}</b>`;
        });
        replyParts.push(
          `⚠️ <b>Delegation not active on ${blockedTxs.length === 1 ? "this chain" : "these chains"}:</b>\n` +
          blockedLabels.join("\n") +
          `\n\nSet up delegation at <a href="https://trader.rigoblock.com">trader.rigoblock.com</a> to execute from Telegram.`,
        );
      }

      if (executableTxs.length > 0) {
        // Store executable transactions with timestamp for staleness detection
        const txKey = `tg-pending-tx:${userId}`;
        const payload = { txs: executableTxs, createdAt: Date.now() };
        await env.KV.put(txKey, JSON.stringify(payload), {
          expirationTtl: 120, // 2 min — swap quotes expire quickly
        });

        // Build trade summary for executable transactions
        const tradeLabels: string[] = [];
        for (const tx of executableTxs) {
          const meta = tx.swapMeta;
          const label = meta
            ? `${meta.sellAmount} ${meta.sellToken} → ${meta.buyAmount} ${meta.buyToken}`
            : tx.description || "Transaction";
          const chainName = SUPPORTED_CHAINS.find(ch => ch.id === tx.chainId)?.name
            || TESTNET_CHAINS.find(ch => ch.id === tx.chainId)?.name
            || String(tx.chainId);
          tradeLabels.push(`• ${escapeHtml(label)} (${chainName})`);
        }

        const tradeCount = executableTxs.length > 1 ? `${executableTxs.length} trades` : "Trade";
        replyParts.push(`\n🔔 <b>${tradeCount} ready:</b>\n${tradeLabels.join("\n")}`);

        const keyboard: TgInlineKeyboardMarkup = {
          inline_keyboard: [
            [
              { text: `✅ Execute${executableTxs.length > 1 ? " All" : ""}`, callback_data: `exec:${userId}` },
              { text: "❌ Cancel", callback_data: `cancel:${userId}` },
            ],
          ],
        };

        const fullReply = replyParts.join("\n\n") || "Ready.";
        const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;
        await sendMessage(token, chatId, truncated, { replyMarkup: keyboard });
      } else {
        // All transactions blocked — no Execute button
        const fullReply = replyParts.join("\n\n") || "No executable trades.";
        const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;
        await sendMessage(token, chatId, truncated);
      }
    } else if (txList.length > 0 && executionMode === "manual") {
      // Manual mode — can't sign from Telegram
      const tradeCount = txList.length > 1 ? `These ${txList.length} trades require` : "This trade requires";
      replyParts.push(`\n⚠️ ${tradeCount} wallet signing. Please complete in the web app, or set up delegation to execute from Telegram.`);
      const fullReply = replyParts.join("\n\n") || "Ready.";
      const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;
      await sendMessage(token, chatId, truncated);
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

    // Store assistant reply in conversation
    if (response.reply) {
      conv.messages.push({ role: "assistant", content: response.reply });
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

  // ── Suggestion chip: inject as a user message ──
  if (data.startsWith("say:")) {
    const text = data.slice(4);
    await answerCallbackQuery(token, query.id);
    // Handle as if the user typed this message
    await handleMessage(env, token, {
      message_id: 0,
      from: query.from,
      chat: { id: chatId },
      text,
    });
    return;
  }

  // ── Trade execution ──
  if (data.startsWith("exec:")) {
    await answerCallbackQuery(token, query.id, "Executing…");

    const txKey = `tg-pending-tx:${userId}`;
    const raw = await env.KV.get(txKey);
    if (!raw) {
      await editMessageText(token, chatId, messageId, "⏰ Trade expired. Please request a new quote.");
      return;
    }

    // Parse stored transactions — supports legacy (array/single tx) and new { txs, createdAt } format
    const parsed = JSON.parse(raw);
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

    const outcomes = await executeTxList(env, txList, vaultAddress, async (idx, total, soFar) => {
      if (total > 1) {
        const done = soFar.length > 0 ? "\n\n" + formatTelegramOutcomes(soFar) : "";
        await editMessageText(
          token, chatId, messageId,
          `⏳ Executing trade ${idx + 1} of ${total}…${done}`,
        ).catch(() => {});
      }
    });

    // We need outcomes to be available inside the callback, so collect them first
    const resultLines = formatTelegramOutcomes(outcomes);
    const allSuccess = outcomes.every(o => o.result?.confirmed && !o.result?.reverted);

    // Detect stale swap quote failures: simulation failed on a swap that sat too long
    const hasSimFailure = outcomes.some(o => o.error?.includes("simulation failed") || o.error?.includes("would revert"));
    let staleHint = "";
    if (hasSimFailure && hasSwaps) {
      staleHint = isLikelyStale
        ? "\n\n💡 The swap quote likely expired before execution. Swap quotes are valid for ~2 minutes. Please request the swap again for a fresh quote."
        : "\n\n💡 The swap may have reverted due to an expired quote or changed market conditions. Please request the swap again for a fresh quote.";
    }

    // Final summary
    const header = allSuccess
      ? (txList.length > 1 ? `✅ <b>All ${txList.length} trades confirmed</b>` : "✅ <b>Trade confirmed</b>")
      : "⚠️ <b>Some trades failed</b>";
    const finalMsg = `${header}\n\n${resultLines}${staleHint}`;
    const truncated = finalMsg.length > 4000 ? finalMsg.slice(0, 3990) + "…" : finalMsg;
    await editMessageText(token, chatId, messageId, truncated);

    return;
  }

  // ── Trade cancellation ──
  if (data.startsWith("cancel:")) {
    await answerCallbackQuery(token, query.id, "Cancelled");
    const txKey = `tg-pending-tx:${userId}`;
    await env.KV.delete(txKey);
    await editMessageText(token, chatId, messageId, "Trade cancelled.");
    return;
  }

  await answerCallbackQuery(token, query.id);
}

/** Format TxExecOutcome[] as Telegram HTML lines */
function formatTelegramOutcomes(outcomes: TxExecOutcome[]): string {
  const lines: string[] = [];
  for (const { tx, result, error } of outcomes) {
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
      lines.push(`⏳ ${escapeHtml(desc)} — submitted: <code>${result.txHash.slice(0, 14)}…</code>`);
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
      } else {
        lines.push(`⚠️ ${escapeHtml(desc)} — ${escapeHtml(error.slice(0, 150))}`);
      }
    }
  }
  return lines.join("\n");
}

// ── Help message ──────────────────────────────────────────────────────

async function sendHelpMessage(token: string, chatId: number): Promise<void> {
  const text = [
    "<b>🤖 Rigoblock Vault Operator</b>",
    "",
    "Control your smart pool from Telegram — no wallet app needed.",
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
    "/clear — reset conversation",
    "/unpair &lt;addr&gt; — unlink a vault",
    "/help — this message",
    "",
    "<b>Note:</b> Trades execute automatically via your agent wallet (delegation). Set up delegation in the <a href=\"https://trader.rigoblock.com\">web app</a> first.",
  ].join("\n");

  await sendMessage(token, chatId, text);
}

export { telegram };
