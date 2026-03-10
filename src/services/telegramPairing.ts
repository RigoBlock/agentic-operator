/**
 * Telegram ↔ Web pairing service.
 *
 * Pairing flow:
 *   1. Web UI: user clicks "Pair Telegram" → POST /api/telegram/pair
 *      → generates a 6-char code, stores in KV with 5 min TTL
 *   2. Telegram: user sends `/pair ABC123` to the bot
 *      → verifies code, links telegramUserId → operatorAddress + vault
 *   3. Subsequent Telegram messages are routed to processChat() using stored context
 *
 * KV keys:
 *   `tg-pair:{code}`           → TelegramPairingCode (5 min TTL)
 *   `tg-user:{telegramUserId}` → TelegramUser (persistent)
 *   `tg-conv:{telegramUserId}` → TelegramConversation (24h TTL)
 *   `tg-addr:{operatorAddress}`→ telegramUserId (reverse lookup for web→tg push)
 */

import type {
  Env,
  TelegramUser,
  TelegramVaultLink,
  TelegramPairingCode,
  TelegramConversation,
  ChatMessage,
} from "../types.js";
import type { Address } from "viem";

// ── KV key helpers ────────────────────────────────────────────────────

function pairCodeKey(code: string): string {
  return `tg-pair:${code.toUpperCase()}`;
}

function tgUserKey(telegramUserId: number): string {
  return `tg-user:${telegramUserId}`;
}

function tgConvKey(telegramUserId: number): string {
  return `tg-conv:${telegramUserId}`;
}

function tgAddrKey(operatorAddress: string): string {
  return `tg-addr:${operatorAddress.toLowerCase()}`;
}

// ── TTLs ──────────────────────────────────────────────────────────────

const PAIR_CODE_TTL = 5 * 60;          // 5 minutes
const CONV_TTL = 24 * 60 * 60;         // 24 hours
const MAX_CONV_MESSAGES = 20;           // Keep last N messages per conversation

// ── Pairing code generation ───────────────────────────────────────────

/** Generate a short alphanumeric pairing code (6 chars, uppercase). */
export function generatePairCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// ── Create pairing code (called from web via POST /api/telegram/pair) ─

export async function createPairingCode(
  kv: KVNamespace,
  operatorAddress: Address,
  vaultAddress: Address,
  vaultName: string,
  chainId: number,
): Promise<string> {
  const code = generatePairCode();
  const data: TelegramPairingCode = {
    code,
    operatorAddress,
    vaultAddress,
    vaultName: vaultName || `${vaultAddress.slice(0, 6)}…${vaultAddress.slice(-4)}`,
    chainId,
    createdAt: Date.now(),
  };
  await kv.put(pairCodeKey(code), JSON.stringify(data), {
    expirationTtl: PAIR_CODE_TTL,
  });
  return code;
}

// ── Verify pairing code (called from Telegram /pair command) ──────────

export interface PairResult {
  success: boolean;
  message: string;
  user?: TelegramUser;
}

export async function verifyPairingCode(
  kv: KVNamespace,
  code: string,
  telegramUserId: number,
  telegramUsername?: string,
): Promise<PairResult> {
  const raw = await kv.get(pairCodeKey(code.toUpperCase()));
  if (!raw) {
    return { success: false, message: "Invalid or expired pairing code. Generate a new one from the web app." };
  }

  const pairData: TelegramPairingCode = JSON.parse(raw);

  // Delete the code (one-time use)
  await kv.delete(pairCodeKey(code.toUpperCase()));

  // Load or create the TelegramUser
  let user = await getTelegramUser(kv, telegramUserId);
  const vaultLink: TelegramVaultLink = {
    address: pairData.vaultAddress,
    chainId: pairData.chainId,
    name: pairData.vaultName,
  };

  if (user) {
    // Check if vault is already linked (same address AND chain)
    const existing = user.vaults.findIndex(
      (v) => v.address.toLowerCase() === pairData.vaultAddress.toLowerCase()
            && v.chainId === pairData.chainId,
    );
    if (existing >= 0) {
      // Update name
      user.vaults[existing] = vaultLink;
    } else {
      user.vaults.push(vaultLink);
    }
    user.activeVaultIndex = existing >= 0 ? existing : user.vaults.length - 1;
    user.operatorAddress = pairData.operatorAddress;
    if (telegramUsername) user.username = telegramUsername;
  } else {
    user = {
      telegramUserId,
      username: telegramUsername,
      operatorAddress: pairData.operatorAddress,
      vaults: [vaultLink],
      activeVaultIndex: 0,
      pairedAt: Date.now(),
    };
  }

  await saveTelegramUser(kv, user);

  // Reverse lookup: operator address → telegram user ID
  await kv.put(tgAddrKey(pairData.operatorAddress), String(telegramUserId));

  const vaultLabel = pairData.vaultName || `${pairData.vaultAddress.slice(0, 6)}…`;
  return {
    success: true,
    message: `✅ Paired! Vault "${vaultLabel}" is now active.\nYou can send trade commands directly here.`,
    user,
  };
}

// ── TelegramUser CRUD ─────────────────────────────────────────────────

export async function getTelegramUser(
  kv: KVNamespace,
  telegramUserId: number,
): Promise<TelegramUser | null> {
  const raw = await kv.get(tgUserKey(telegramUserId));
  return raw ? (JSON.parse(raw) as TelegramUser) : null;
}

export async function saveTelegramUser(
  kv: KVNamespace,
  user: TelegramUser,
): Promise<void> {
  await kv.put(tgUserKey(user.telegramUserId), JSON.stringify(user));
}

/** Check if an operator address has a linked Telegram user. */
export async function getTelegramUserIdByAddress(
  kv: KVNamespace,
  operatorAddress: string,
): Promise<number | null> {
  const raw = await kv.get(tgAddrKey(operatorAddress));
  return raw ? Number(raw) : null;
}

// ── Conversation state ────────────────────────────────────────────────

export async function getConversation(
  kv: KVNamespace,
  telegramUserId: number,
): Promise<TelegramConversation | null> {
  const raw = await kv.get(tgConvKey(telegramUserId));
  return raw ? (JSON.parse(raw) as TelegramConversation) : null;
}

export async function saveConversation(
  kv: KVNamespace,
  telegramUserId: number,
  conv: TelegramConversation,
): Promise<void> {
  // Trim to max messages
  if (conv.messages.length > MAX_CONV_MESSAGES) {
    conv.messages = conv.messages.slice(-MAX_CONV_MESSAGES);
  }
  conv.lastActivity = Date.now();
  await kv.put(tgConvKey(telegramUserId), JSON.stringify(conv), {
    expirationTtl: CONV_TTL,
  });
}

export async function clearConversation(
  kv: KVNamespace,
  telegramUserId: number,
): Promise<void> {
  await kv.delete(tgConvKey(telegramUserId));
}

// ── Vault switching ───────────────────────────────────────────────────

/** Switch the active vault for a Telegram user. Returns the new active vault or null. */
export async function switchActiveVault(
  kv: KVNamespace,
  telegramUserId: number,
  vaultIdentifier: string, // name or address prefix
): Promise<TelegramVaultLink | null> {
  const user = await getTelegramUser(kv, telegramUserId);
  if (!user || user.vaults.length === 0) return null;

  const lower = vaultIdentifier.toLowerCase();
  const idx = user.vaults.findIndex(
    (v) =>
      v.name.toLowerCase().includes(lower) ||
      v.address.toLowerCase().startsWith(lower) ||
      v.address.toLowerCase() === lower,
  );
  if (idx < 0) return null;

  user.activeVaultIndex = idx;
  await saveTelegramUser(kv, user);

  // Clear conversation when switching vaults (different context)
  await clearConversation(kv, telegramUserId);

  return user.vaults[idx];
}

/** Unlink (unpair) a vault from Telegram. */
export async function unlinkVault(
  kv: KVNamespace,
  telegramUserId: number,
  vaultAddress: string,
): Promise<boolean> {
  const user = await getTelegramUser(kv, telegramUserId);
  if (!user) return false;

  const before = user.vaults.length;
  user.vaults = user.vaults.filter(
    (v) => v.address.toLowerCase() !== vaultAddress.toLowerCase(),
  );
  if (user.vaults.length === before) return false;

  // Adjust active index
  if (user.activeVaultIndex >= user.vaults.length) {
    user.activeVaultIndex = Math.max(0, user.vaults.length - 1);
  }
  await saveTelegramUser(kv, user);
  await clearConversation(kv, telegramUserId);
  return true;
}
