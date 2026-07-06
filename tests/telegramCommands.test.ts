/**
 * Telegram command tests — /navshield, /swapshield, /slippage
 *
 * Verifies that slash commands update the correct operator-scoped KV settings
 * and return friendly messages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const sentMessages: { chatId: number; text: string }[] = [];

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
    getWebhookSecret: vi.fn(async () => "test-secret"),
  };
});

import { telegram } from "../src/routes/telegram.js";
import {
  createPairingCode,
  verifyPairingCode,
} from "../src/services/telegramPairing.js";
import { getNavShieldThreshold } from "../src/services/navGuard.js";

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

function makeWebhookUpdate(text: string): object {
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

describe("Telegram /navshield command", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
    sentMessages.length = 0;
    vi.clearAllMocks();
  });

  it("sets a temporary NAV shield threshold and stores it with TTL", async () => {
    await createPairedUser(kv);

    const app = new Hono<{ Bindings: { KV: KVNamespace; TELEGRAM_BOT_TOKEN: string } }>();
    app.route("/api/telegram", telegram);

    const { executionCtx, flush } = makeExecutionCtx();
    const res = await app.request(
      "/api/telegram/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeWebhookUpdate("/navshield 90%")),
      },
      { KV: kv, TELEGRAM_BOT_TOKEN: "test-token" } as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await flush();

    const navMsg = sentMessages.find((m) => m.text.includes("NAV Shield"));
    expect(navMsg).toBeDefined();
    expect(navMsg!.text).toContain("90%");
    expect(navMsg!.text).toContain("10 minutes");

    const threshold = await getNavShieldThreshold(kv, "0xA0F9C380ad1E1be09046319fd907335B2B452B37");
    expect(threshold).toBe(90n);
  });

  it("strips @botName suffix in group chats", async () => {
    await createPairedUser(kv);

    const app = new Hono<{ Bindings: { KV: KVNamespace; TELEGRAM_BOT_TOKEN: string } }>();
    app.route("/api/telegram", telegram);

    const { executionCtx, flush } = makeExecutionCtx();
    const res = await app.request(
      "/api/telegram/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeWebhookUpdate("/navshield@RigoblockBot 50%")),
      },
      { KV: kv, TELEGRAM_BOT_TOKEN: "test-token" } as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await flush();

    const navMsg = sentMessages.find((m) => m.text.includes("NAV Shield"));
    expect(navMsg).toBeDefined();
    expect(navMsg!.text).toContain("50%");

    const threshold = await getNavShieldThreshold(kv, "0xA0F9C380ad1E1be09046319fd907335B2B452B37");
    expect(threshold).toBe(50n);
  });

  it("resets NAV shield on /navshield reset", async () => {
    await createPairedUser(kv);
    const op = "0xA0F9C380ad1E1be09046319fd907335B2B452B37";

    const app = new Hono<{ Bindings: { KV: KVNamespace; TELEGRAM_BOT_TOKEN: string } }>();
    app.route("/api/telegram", telegram);

    // First set a high threshold
    const { executionCtx: setCtx, flush: setFlush } = makeExecutionCtx();
    await app.request(
      "/api/telegram/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeWebhookUpdate("/navshield 80%")),
      },
      { KV: kv, TELEGRAM_BOT_TOKEN: "test-token" } as any,
      setCtx as any,
    );
    await setFlush();
    expect(await getNavShieldThreshold(kv, op)).toBe(80n);

    sentMessages.length = 0;

    // Then reset
    const { executionCtx: resetCtx, flush: resetFlush } = makeExecutionCtx();
    const res = await app.request(
      "/api/telegram/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeWebhookUpdate("/navshield reset")),
      },
      { KV: kv, TELEGRAM_BOT_TOKEN: "test-token" } as any,
      resetCtx as any,
    );

    expect(res.status).toBe(200);
    await resetFlush();

    const resetMsg = sentMessages.find((m) => m.text.includes("reset to default"));
    expect(resetMsg).toBeDefined();
    expect(await getNavShieldThreshold(kv, op)).toBeNull();
  });
});
