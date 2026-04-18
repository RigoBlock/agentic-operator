/**
 * Telegram Webhook Registration Script
 *
 * Registers the Cloudflare Worker as the Telegram bot webhook, using the same
 * derived secret that the worker uses to verify incoming updates.
 *
 * WHEN TO RUN THIS SCRIPT:
 *   - First deployment (webhook has never been registered)
 *   - After changing TELEGRAM_WEBHOOK_SECRET or CDP_WALLET_SECRET
 *   - After changing TELEGRAM_BOT_TOKEN (new bot)
 *   - After changing the worker URL (e.g. custom domain change)
 *   - If the Telegram bot stops responding after any infra change
 *
 * This is an INFRASTRUCTURE SETUP script, not a per-user operation.
 * Individual users pair their own Telegram accounts via the web UI pairing flow
 * (which uses their operator wallet signature — no server secrets needed).
 *
 * Webhook secret priority (must match the worker):
 *   1. TELEGRAM_WEBHOOK_SECRET env var — used directly (recommended)
 *   2. CDP_WALLET_SECRET env var       — derived via SHA-256 (backwards compat)
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npx tsx scripts/setup-telegram.ts
 *
 *   Or with .dev.vars loaded via:
 *   source <(grep -v '^#' .dev.vars | sed 's/^/export /') && npx tsx scripts/setup-telegram.ts
 *
 *   Or with a custom worker URL:
 *   WORKER_URL=https://trader.rigoblock.com TELEGRAM_BOT_TOKEN=... CDP_WALLET_SECRET=... npx tsx scripts/setup-telegram.ts
 */

const WORKER_URL = process.env.WORKER_URL ?? "https://trader.rigoblock.com";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET_DIRECT = process.env.TELEGRAM_WEBHOOK_SECRET;
const CDP_SECRET = process.env.CDP_WALLET_SECRET;

if (!TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN is not set.");
  console.error("  Set it via environment variable or load from .dev.vars.");
  process.exit(1);
}

if (!WEBHOOK_SECRET_DIRECT && !CDP_SECRET) {
  console.error("Error: Neither TELEGRAM_WEBHOOK_SECRET nor CDP_WALLET_SECRET is set.");
  console.error("  Set TELEGRAM_WEBHOOK_SECRET (recommended) or CDP_WALLET_SECRET.");
  process.exit(1);
}

/**
 * Derives the webhook secret token from CDP_WALLET_SECRET.
 * Must match the server-side deriveWebhookSecret() in src/services/telegram.ts.
 *
 * Algorithm: SHA-256("tg-webhook-secret:{secret}") → first 32 bytes → base64url
 */
async function deriveWebhookSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(`tg-webhook-secret:${secret}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from(bytes.slice(0, 32), (b) => chars[b % chars.length]).join("");
}

async function main() {
  const webhookUrl = `${WORKER_URL}/api/telegram/webhook`;

  console.log(`\nRegistering Telegram webhook`);
  console.log(`  Bot token: ${TOKEN!.slice(0, 10)}...`);
  console.log(`  Webhook URL: ${webhookUrl}`);

  // 1. Check current webhook status
  const infoRes = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
  const info = await infoRes.json() as any;
  let pendingCount = 0;
  let lastErrorDate = 0;
  if (info.ok) {
    const current = info.result.url;
    pendingCount = info.result.pending_update_count || 0;
    lastErrorDate = info.result.last_error_date || 0;
    console.log(`\nCurrent webhook: ${current || "(none)"}`);
    if (pendingCount > 0) console.log(`  Pending updates: ${pendingCount}`);
    if (info.result.last_error_message) {
      console.warn(`  Last error: ${info.result.last_error_message}`);
    }
  }

  // 2. Drop pending updates + reset Telegram retry backoff.
  //    After repeated 403 failures, Telegram exponentially backs off and eventually
  //    stops calling the webhook entirely. deleteWebhook+drop_pending_updates resets
  //    this backoff counter so Telegram starts delivering immediately after re-register.
  console.log(`\nResetting webhook (drops ${pendingCount} stale pending updates to clear Telegram backoff)...`);
  const deleteRes = await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook?drop_pending_updates=true`);
  const deleteResult = await deleteRes.json() as any;
  if (!deleteResult.ok) {
    console.warn(`  Warning: deleteWebhook failed: ${JSON.stringify(deleteResult)}`);
  } else {
    console.log(`  ✓ Webhook deleted, pending updates dropped`);
  }

  // 3. Resolve webhook secret (matches server-side priority in getWebhookSecret())
  let webhookSecret: string;
  let secretSource: string;
  if (WEBHOOK_SECRET_DIRECT) {
    webhookSecret = WEBHOOK_SECRET_DIRECT;
    secretSource = "TELEGRAM_WEBHOOK_SECRET (used directly)";
  } else {
    webhookSecret = await deriveWebhookSecret(CDP_SECRET!);
    secretSource = "CDP_WALLET_SECRET (derived via SHA-256 — consider setting TELEGRAM_WEBHOOK_SECRET instead)";
  }
  console.log(`\nWebhook secret: ${webhookSecret.slice(0, 8)}... (${webhookSecret.length} chars)`);
  console.log(`  Source: ${secretSource}`);

  // 4. Register webhook with Telegram
  console.log("\nCalling Telegram setWebhook...");
  const setRes = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      // Only receive message and callback_query updates
      allowed_updates: ["message", "callback_query"],
    }),
  });
  const result = await setRes.json() as any;

  if (result.ok) {
    console.log(`✓ Webhook registered successfully`);
    console.log(`  URL: ${webhookUrl}`);
    console.log(`  Secret source: ${secretSource}`);
    console.log(`\nTelegram will now send updates to this worker.`);
    console.log(`Individual users can pair their Telegram accounts via the web UI.`);
  } else {
    console.error(`✗ setWebhook failed: ${JSON.stringify(result)}`);
    process.exit(1);
  }

  // 4. Verify
  const verifyRes = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
  const verify = await verifyRes.json() as any;
  if (verify.ok && verify.result.url === webhookUrl) {
    console.log(`\n✓ Verified: webhook is active`);
    if (verify.result.last_error_message) {
      console.warn(`  Last error: ${verify.result.last_error_message} (at ${verify.result.last_error_date})`);
      console.warn(`  This may indicate the worker URL is unreachable or the secret check is failing.`);
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
