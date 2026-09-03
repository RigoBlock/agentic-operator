/**
 * Telegram webhook authentication tests (F1 — forged updates).
 *
 * The webhook URL is publicly guessable, so every update must carry the
 * secret token that was registered with setWebhook:
 *   - secret configured + token mismatch/missing → 401, update NOT processed
 *   - no secret configured                        → 503 (fail closed)
 *   - TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK=1 with APP_ENV=development
 *                                                 → processed (local dev only)
 *   - TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK=1 without APP_ENV=development
 *                                                 → 503 (hatch is dead, fail closed)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const sentMessages: { chatId: number; text: string }[] = [];
const { mockGetWebhookSecret } = vi.hoisted(() => ({ mockGetWebhookSecret: vi.fn() }));

vi.mock("../src/services/telegram.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/telegram.js")>();
  return {
    ...mod,
    sendMessage: vi.fn(async (_token: string, chatId: number, text: string) => {
      sentMessages.push({ chatId, text });
      return { message_id: 1, chat: { id: chatId, type: "private" }, date: Date.now() } as any;
    }),
    sendChatAction: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    setWebhook: vi.fn(async () => ({ ok: true })),
    getWebhookSecret: mockGetWebhookSecret,
  };
});

import { telegram } from "../src/routes/telegram.js";
import { createPairingCode, verifyPairingCode } from "../src/services/telegramPairing.js";
import { getNavShieldThreshold } from "../src/services/navGuard.js";
import { withEnv } from "../src/services/envContext.js";
import type { Env } from "../src/types.js";

function makeExecutionCtx() {
  const waitUntilFns: (() => Promise<void>)[] = [];
  return {
    executionCtx: {
      waitUntil: (fn: Promise<void>) => {
        waitUntilFns.push(async () => { try { await fn; } catch {} });
      },
      passThroughOnException: () => {},
    },
    async flush() {
      for (const fn of waitUntilFns) await fn();
    },
  };
}

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    get: async (key: string) => store.get(key)?.value ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

async function createPairedUser(kv: KVNamespace) {
  const code = await createPairingCode(
    kv,
    "0xA0F9C380ad1E1be09046319fd907335B2B452B37" as `0x${string}`,
    "0x1234567890123456789012345678901234567890" as `0x${string}`,
    "MyPool",
    8453,
  );
  await verifyPairingCode(kv, code, 123456, "testuser");
}

function makeUpdate(text: string): object {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 123456, is_bot: false, first_name: "Test" },
      chat: { id: 789, type: "private" },
      text,
      date: Date.now(),
    },
  };
}

function createApp(kv: KVNamespace) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/telegram", telegram);
  return app;
}

async function postWebhook(
  app: Hono<{ Bindings: Env }>,
  kv: KVNamespace,
  headers: Record<string, string>,
) {
  const { executionCtx, flush } = makeExecutionCtx();
  const res = await app.request(
    "/api/telegram/webhook",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(makeUpdate("/navshield 90%")),
    },
    { KV: kv, TELEGRAM_BOT_TOKEN: "test-token" } as Env,
    executionCtx as any,
  );
  await flush();
  return res;
}

describe("telegram webhook secret authentication", () => {
  let kv: KVNamespace;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    kv = createMockKV();
    app = createApp(kv);
    sentMessages.length = 0;
    vi.clearAllMocks();
    mockGetWebhookSecret.mockResolvedValue("test-secret");
  });

  it("processes updates with the correct secret token", async () => {
    await createPairedUser(kv);
    const res = await postWebhook(app, kv, {
      "x-telegram-bot-api-secret-token": "test-secret",
    });
    expect(res.status).toBe(200);
    expect(sentMessages.some((m) => m.text.includes("NAV Shield"))).toBe(true);
    expect(await getNavShieldThreshold(kv, "0xA0F9C380ad1E1be09046319fd907335B2B452B37")).toBe(90n);
  });

  it("returns 401 and does NOT process updates with a wrong secret token", async () => {
    await createPairedUser(kv);
    const res = await postWebhook(app, kv, {
      "x-telegram-bot-api-secret-token": "forged-secret",
    });
    expect(res.status).toBe(401);
    // The forged update must not produce any bot action or KV side effects.
    expect(sentMessages).toHaveLength(0);
    expect(await getNavShieldThreshold(kv, "0xA0F9C380ad1E1be09046319fd907335B2B452B37")).toBeNull();
  });

  it("returns 401 and does NOT process updates with a missing secret token", async () => {
    await createPairedUser(kv);
    const res = await postWebhook(app, kv, {});
    expect(res.status).toBe(401);
    expect(sentMessages).toHaveLength(0);
    expect(await getNavShieldThreshold(kv, "0xA0F9C380ad1E1be09046319fd907335B2B452B37")).toBeNull();
  });

  it("returns 503 (fail closed) when no webhook secret is configured", async () => {
    await createPairedUser(kv);
    mockGetWebhookSecret.mockResolvedValue(undefined);
    const res = await postWebhook(app, kv, {
      "x-telegram-bot-api-secret-token": "test-secret",
    });
    expect(res.status).toBe(503);
    expect(sentMessages).toHaveLength(0);
    expect(await getNavShieldThreshold(kv, "0xA0F9C380ad1E1be09046319fd907335B2B452B37")).toBeNull();
  });

  it("processes updates unauthenticated only with TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK=1 + APP_ENV=development", async () => {
    await createPairedUser(kv);
    mockGetWebhookSecret.mockResolvedValue(undefined);
    const env = {
      KV: kv,
      TELEGRAM_BOT_TOKEN: "test-token",
      APP_ENV: "development",
      TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK: "1",
    } as Env;
    const { executionCtx, flush } = makeExecutionCtx();
    const res = await withEnv(env, async () =>
      app.request(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(makeUpdate("/navshield 90%")),
        },
        env,
        executionCtx as any,
      ),
    );
    await flush();
    expect(res.status).toBe(200);
    expect(sentMessages.some((m) => m.text.includes("NAV Shield"))).toBe(true);
  });

  it("ignores TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK=1 without APP_ENV=development (fail closed)", async () => {
    await createPairedUser(kv);
    mockGetWebhookSecret.mockResolvedValue(undefined);
    const env = {
      KV: kv,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ALLOW_UNAUTHENTICATED_WEBHOOK: "1",
    } as Env;
    const { executionCtx, flush } = makeExecutionCtx();
    const res = await withEnv(env, async () =>
      app.request(
        "/api/telegram/webhook",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(makeUpdate("/navshield 90%")),
        },
        env,
        executionCtx as any,
      ),
    );
    await flush();
    expect(res.status).toBe(503);
    expect(sentMessages).toHaveLength(0);
  });
});
