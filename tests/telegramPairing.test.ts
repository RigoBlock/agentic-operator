/**
 * Telegram Pairing Tests
 *
 * Covers the KV-backed pairing flow: code generation, verification,
 * reverse lookup, and delegation status integration.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  generatePairCode,
  createPairingCode,
  verifyPairingCode,
  getTelegramUser,
  getTelegramUserIdByAddress,
  unlinkVault,
  switchActiveVault,
} from "../src/services/telegramPairing.js";

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    get: async (key: string, type?: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
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

const OP = "0xA0F9C380ad1E1be09046319fd907335B2B452B37" as const;
const VAULT = "0x1234567890123456789012345678901234567890" as const;
const CHAIN_ID = 8453;

describe("Telegram pairing flow", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("generatePairCode produces 6 uppercase alphanumeric chars", () => {
    const code = generatePairCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-Z0-9]+$/);
    expect(code).not.toMatch(/[IO01]/);
  });

  it("createPairingCode stores data in KV and returns a code", async () => {
    const code = await createPairingCode(kv, OP, VAULT, "MyPool", CHAIN_ID);
    expect(code).toHaveLength(6);

    const raw = await kv.get(`tg-pair:${code}`);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.operatorAddress).toBe(OP);
    expect(data.vaultAddress).toBe(VAULT);
    expect(data.vaultName).toBe("MyPool");
    expect(data.chainId).toBe(CHAIN_ID);
    expect(data.code).toBe(code);
  });

  it("verifyPairingCode fails for invalid code", async () => {
    const result = await verifyPairingCode(kv, "INVALID", 123456);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Invalid or expired/);
  });

  it("verifyPairingCode creates TelegramUser and reverse lookup", async () => {
    const code = await createPairingCode(kv, OP, VAULT, "MyPool", CHAIN_ID);
    const result = await verifyPairingCode(kv, code, 123456, "testuser");

    expect(result.success).toBe(true);
    expect(result.user).toBeDefined();
    expect(result.user!.telegramUserId).toBe(123456);
    expect(result.user!.username).toBe("testuser");
    expect(result.user!.operatorAddress).toBe(OP);
    expect(result.user!.vaults).toHaveLength(1);
    expect(result.user!.vaults[0].address).toBe(VAULT);

    // Reverse lookup
    const tgId = await getTelegramUserIdByAddress(kv, OP);
    expect(tgId).toBe(123456);

    // Code is deleted after use
    const raw = await kv.get(`tg-pair:${code}`);
    expect(raw).toBeNull();
  });

  it("verifyPairingCode updates existing user with new vault", async () => {
    const code1 = await createPairingCode(kv, OP, VAULT, "PoolA", CHAIN_ID);
    await verifyPairingCode(kv, code1, 123456);

    const vault2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
    const code2 = await createPairingCode(kv, OP, vault2, "PoolB", 1);
    const result = await verifyPairingCode(kv, code2, 123456);

    expect(result.user!.vaults).toHaveLength(2);
    expect(result.user!.activeVaultIndex).toBe(1);
  });

  it("unlinkVault removes vault and adjusts active index", async () => {
    const code = await createPairingCode(kv, OP, VAULT, "PoolA", CHAIN_ID);
    await verifyPairingCode(kv, code, 123456);

    const removed = await unlinkVault(kv, 123456, VAULT);
    expect(removed).toBe(true);

    const user = await getTelegramUser(kv, 123456);
    expect(user!.vaults).toHaveLength(0);
  });

  it("switchActiveVault changes active vault by name or address", async () => {
    const code = await createPairingCode(kv, OP, VAULT, "AlphaPool", CHAIN_ID);
    await verifyPairingCode(kv, code, 123456);

    const switched = await switchActiveVault(kv, 123456, "Alpha");
    expect(switched).not.toBeNull();
    expect(switched!.name).toBe("AlphaPool");

    const user = await getTelegramUser(kv, 123456);
    expect(user!.activeVaultIndex).toBe(0);
  });

  it("switchActiveVault returns null for unknown vault", async () => {
    const code = await createPairingCode(kv, OP, VAULT, "AlphaPool", CHAIN_ID);
    await verifyPairingCode(kv, code, 123456);

    const switched = await switchActiveVault(kv, 123456, "Beta");
    expect(switched).toBeNull();
  });
});

describe("Delegation status telegramPaired field", () => {
  it("delegation status endpoint includes telegramPared when verify=true", async () => {
    const { app, env } = await import("../src/index.js").then((m) => ({
      app: m.app,
      env: {
        KV: createMockKV(),
        ALCHEMY_API_KEY: "test",
      } as any,
    }));

    // Before pairing: telegramPaired should be false
    const resBefore = await app.request(
      `/api/delegation/status?vaultAddress=${VAULT}&chainId=1&verify=true`,
      {},
      env,
    );
    expect(resBefore.status).toBe(200);
    const dataBefore = (await resBefore.json()) as { telegramPaired: boolean };
    expect(dataBefore.telegramPaired).toBe(false);
  });
});
