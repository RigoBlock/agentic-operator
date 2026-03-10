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
import type { Env, ChatMessage, RequestContext, ChatResponse, TelegramConversation } from "../types.js";
import type { Address } from "viem";
import { processChat } from "../llm/client.js";
import { isDelegationActive } from "../services/delegation.js";
import { executeViaDelegation, ExecutionError } from "../services/execution.js";
import { initTokenResolver } from "../services/tokenResolver.js";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  sendChatAction,
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
} from "../services/telegramPairing.js";
import { verifyOperatorAuth, AuthError } from "../services/auth.js";
import { getVaultInfo } from "../services/vault.js";
import { SUPPORTED_CHAINS, TESTNET_CHAINS } from "../config.js";
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
    return c.json({ error: msg }, 500);
  }
});

// ── Setup: register webhook URL with Telegram ─────────────────────────
// Exposed as both GET and POST to avoid Cloudflare WAF blocking bare POSTs.

const setupHandler = async (c: Context<{ Bindings: Env }>) => {
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

telegram.get("/debug", async (c) => {
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
        // Collect ALL chains where this vault exists and is owned by the operator
        type VaultResult = { address: Address; name: string; symbol: string; owner: Address; totalSupply: string; chainId: number };
        const foundVaults: VaultResult[] = [];
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.owner.toLowerCase() === user.operatorAddress.toLowerCase()) {
            foundVaults.push(r.value as VaultResult);
          }
        }

        if (foundVaults.length === 0) {
          await sendMessage(
            token, chatId,
            "Could not find a vault at that address owned by your paired wallet on any supported chain.",
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

  // Show "typing…"
  await sendChatAction(token, chatId);

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

  // Check if delegation is active (determines execution mode)
  const delegationActive = await isDelegationActive(env.KV, vault.address, vault.chainId);
  const executionMode = delegationActive ? "delegated" : "manual";

  const ctx: RequestContext = {
    vaultAddress: vault.address,
    chainId: vault.chainId,
    operatorAddress: user.operatorAddress,
    executionMode,
  };

  try {
    // Initialize token resolver
    if (env.KV) initTokenResolver(env.KV);

    const response: ChatResponse = await processChat(env, conv.messages as ChatMessage[], ctx);

    // Track chain switches in conversation state
    if (response.chainSwitch) {
      conv.chainId = response.chainSwitch;
      vault.chainId = response.chainSwitch;
    }

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

    // If there's a transaction and we're in delegated mode → show Execute/Cancel buttons
    if (response.transaction && executionMode === "delegated") {
      // Store the pending tx in KV for callback handling
      const txKey = `tg-pending-tx:${userId}`;
      await env.KV.put(txKey, JSON.stringify(response.transaction), {
        expirationTtl: 300, // 5 min expiry
      });

      const meta = response.transaction.swapMeta;
      const label = meta
        ? `${meta.sellAmount} ${meta.sellToken} → ${meta.buyAmount} ${meta.buyToken}`
        : response.transaction.description || "Execute transaction";

      const keyboard: TgInlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: "✅ Execute", callback_data: `exec:${userId}` },
            { text: "❌ Cancel", callback_data: `cancel:${userId}` },
          ],
        ],
      };

      replyParts.push(`\n🔔 <b>Trade ready:</b> ${escapeHtml(label)}`);
      const fullReply = replyParts.join("\n\n") || "Ready.";

      // Truncate if too long for Telegram (4096 char limit)
      const truncated = fullReply.length > 4000 ? fullReply.slice(0, 3990) + "…" : fullReply;
      await sendMessage(token, chatId, truncated, { replyMarkup: keyboard });
    } else if (response.transaction && executionMode === "manual") {
      // Manual mode — can't sign from Telegram
      replyParts.push("\n⚠️ This trade requires wallet signing. Please complete it in the web app, or set up delegation to execute from Telegram.");
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
    console.error("[telegram] processChat error:", err);
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await sendMessage(token, chatId, `⚠️ Error: ${escapeHtml(errMsg.slice(0, 200))}`);
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

    const tx = JSON.parse(raw) as {
      to: string;
      data: string;
      value: string;
      chainId: number;
      gas: string;
      description: string;
      swapMeta?: { sellAmount: string; sellToken: string; buyAmount: string; buyToken: string; price: string; dex: string };
    };

    // Delete pending tx
    await env.KV.delete(txKey);

    // Update message to show "executing…"
    await editMessageText(token, chatId, messageId, "⏳ Executing trade…");

    try {
      const result = await executeViaDelegation(
        env,
        {
          to: tx.to as Address,
          data: tx.data as `0x${string}`,
          value: tx.value,
          chainId: tx.chainId,
          gas: tx.gas,
          description: tx.description,
        },
        tx.to, // vault address
      );

      if (result.confirmed) {
        const meta = tx.swapMeta;
        const gasInfo = result.gasCostEth ? ` (gas: ${result.gasCostEth} ETH)` : "";
        const tradeLabel = meta
          ? `${meta.sellAmount} ${meta.sellToken} → ${meta.buyAmount} ${meta.buyToken}`
          : tx.description;
        const explorerLink = result.explorerUrl
          ? `<a href="${result.explorerUrl}">View on explorer</a>`
          : `Tx: <code>${result.txHash.slice(0, 14)}…</code>`;

        await editMessageText(
          token, chatId, messageId,
          `✅ <b>Trade confirmed</b> (block ${result.blockNumber || "?"})${gasInfo}\n${escapeHtml(tradeLabel)}\n${explorerLink}`,
        );
      } else if (result.reverted) {
        const explorerLink = result.explorerUrl
          ? `<a href="${result.explorerUrl}">View failed tx</a>`
          : "";
        await editMessageText(
          token, chatId, messageId,
          `❌ <b>Transaction reverted</b>\n${escapeHtml(tx.description)}\n${explorerLink}\n\nTry again with a fresh quote.`,
        );
      } else {
        await editMessageText(
          token, chatId, messageId,
          `⏳ Transaction submitted: <code>${result.txHash.slice(0, 14)}…</code>\nWaiting for confirmation…`,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Execution failed";
      await editMessageText(
        token, chatId, messageId,
        `⚠️ Execution error: ${escapeHtml(errMsg.slice(0, 200))}`,
      );
    }

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
