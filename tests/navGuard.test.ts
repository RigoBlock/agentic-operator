/**
 * NAV Shield — KV storage and threshold tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getNavShieldThreshold,
  setNavShieldThreshold,
  clearNavShieldThreshold,
  DEFAULT_MAX_NAV_DROP_PCT,
  MIN_NAV_DROP_PCT,
  MAX_NAV_DROP_PCT,
} from "../src/services/navGuard.js";
import {
  handle_set_nav_shield_threshold,
  handle_enable_nav_shield,
  handle_set_default_slippage,
  handle_set_swap_shield_tolerance,
  handle_enable_swap_shield,
} from "../src/llm/handlers/settings.js";
import type { RequestContext } from "../src/types.js";

// ── Mock KV namespace ──
function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

const OPERATOR = "0xcccc000000000000000000000000000000000003";

describe("NAV Shield — threshold storage", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("starts with no threshold override", async () => {
    const threshold = await getNavShieldThreshold(kv, OPERATOR);
    expect(threshold).toBeNull();
  });

  it("stores and retrieves threshold", async () => {
    await setNavShieldThreshold(kv, OPERATOR, 25n);
    const threshold = await getNavShieldThreshold(kv, OPERATOR);
    expect(threshold).toBe(25n);
  });

  it("clears threshold back to null", async () => {
    await setNavShieldThreshold(kv, OPERATOR, 25n);
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBe(25n);

    await clearNavShieldThreshold(kv, OPERATOR);
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();
  });

  it("uses case-insensitive operator address", async () => {
    await setNavShieldThreshold(kv, OPERATOR.toUpperCase(), 15n);
    const threshold = await getNavShieldThreshold(kv, OPERATOR.toLowerCase());
    expect(threshold).toBe(15n);
  });

  it("rejects threshold below minimum", async () => {
    await expect(setNavShieldThreshold(kv, OPERATOR, 0n)).rejects.toThrow("must be between");
    await expect(setNavShieldThreshold(kv, OPERATOR, MIN_NAV_DROP_PCT - 1n)).rejects.toThrow("must be between");
  });

  it("rejects threshold above maximum", async () => {
    await expect(setNavShieldThreshold(kv, OPERATOR, MAX_NAV_DROP_PCT + 1n)).rejects.toThrow("must be between");
    await expect(setNavShieldThreshold(kv, OPERATOR, 101n)).rejects.toThrow("must be between");
  });

  it("rejects non-numeric stored payloads", async () => {
    await (kv.put as any)(`nav-shield-pct:${OPERATOR.toLowerCase()}`, "abc");
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();

    await (kv.put as any)(`nav-shield-pct:${OPERATOR.toLowerCase()}`, "25.5");
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();
  });

  it("rejects out-of-range stored payloads", async () => {
    await (kv.put as any)(`nav-shield-pct:${OPERATOR.toLowerCase()}`, "0");
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();

    await (kv.put as any)(`nav-shield-pct:${OPERATOR.toLowerCase()}`, "101");
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();
  });

  it("accepts boundary values", async () => {
    await setNavShieldThreshold(kv, OPERATOR, MIN_NAV_DROP_PCT);
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBe(MIN_NAV_DROP_PCT);

    await setNavShieldThreshold(kv, OPERATOR, MAX_NAV_DROP_PCT);
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBe(MAX_NAV_DROP_PCT);
  });

  it("exports correct constants", () => {
    expect(DEFAULT_MAX_NAV_DROP_PCT).toBe(10n);
    expect(MIN_NAV_DROP_PCT).toBe(1n);
    expect(MAX_NAV_DROP_PCT).toBe(100n);
  });
});

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    vaultAddress: "0x0000000000000000000000000000000000000000",
    chainId: 8453,
    isBrowserRequest: true,
    operatorAddress: OPERATOR as `0x${string}`,
    operatorVerified: true,
    ...overrides,
  };
}

function makeEnv(kv: KVNamespace): any {
  return { KV: kv, ALCHEMY_API_KEY: "test-key" };
}

describe("Settings — operator-only restriction", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("allows NAV shield threshold from browser requests", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: true });
    const result = await handle_set_nav_shield_threshold(env, ctx, { threshold: "25" }, "set_nav_shield_threshold");
    expect(result.message).toContain("25%");
  });

  it("returns a friendly NAV shield confirmation message", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: true });
    const result = await handle_set_nav_shield_threshold(env, ctx, { threshold: "15%" }, "set_nav_shield_threshold");
    expect(result.message).toContain("NAV Shield set to 15%");
    expect(result.message).toContain("all your vaults on every chain");
    expect(result.message).not.toContain("per-operator");
    expect(result.message).not.toContain("across all chains");
  });

  it("sets swap shield tolerance from chat-style input", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: true });
    const result = await handle_set_swap_shield_tolerance(env, ctx, { tolerance: "30%" }, "set_swap_shield_tolerance");
    expect(result.message).toContain("30%");
    expect(result.message).toContain("10 minutes");
  });

  it("rejects NAV shield threshold from unverified operators (external agents)", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ operatorVerified: false });
    await expect(
      handle_set_nav_shield_threshold(env, ctx, { threshold: "25" }, "set_nav_shield_threshold"),
    ).rejects.toThrow("can only be used by the vault operator");
  });

  it("allows NAV shield threshold from Telegram (verified operator)", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: false });
    const result = await handle_set_nav_shield_threshold(env, ctx, { threshold: "25" }, "set_nav_shield_threshold");
    expect(result.message).toContain("25%");
  });

  it("allows reset NAV shield from browser requests", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: true });
    await setNavShieldThreshold(kv, OPERATOR, 50n);
    const result = await handle_enable_nav_shield(env, ctx, {}, "enable_nav_shield");
    expect(result.message).toContain("10%");
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();
  });

  it("rejects reset NAV shield from unverified operators", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ operatorVerified: false });
    await expect(handle_enable_nav_shield(env, ctx, {}, "enable_nav_shield")).rejects.toThrow("can only be used by the vault operator");
  });

  it("allows reset NAV shield from Telegram (verified operator)", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: false });
    await setNavShieldThreshold(kv, OPERATOR, 50n);
    const result = await handle_enable_nav_shield(env, ctx, {}, "enable_nav_shield");
    expect(result.message).toContain("10%");
    expect(await getNavShieldThreshold(kv, OPERATOR)).toBeNull();
  });

  it("rejects slippage change from unverified operators", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ operatorVerified: false });
    await expect(
      handle_set_default_slippage(env, ctx, { slippage: "1%" }, "set_default_slippage"),
    ).rejects.toThrow("can only be used by the vault operator");
  });

  it("allows swap shield tolerance from Telegram (verified operator)", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ isBrowserRequest: false });
    const result = await handle_set_swap_shield_tolerance(env, ctx, { tolerance: "30%" }, "set_swap_shield_tolerance");
    expect(result.message).toContain("30%");
  });

  it("rejects enable swap shield from unverified operators", async () => {
    const env = makeEnv(kv);
    const ctx = makeCtx({ operatorVerified: false });
    await expect(
      handle_enable_swap_shield(env, ctx, {}, "enable_swap_shield"),
    ).rejects.toThrow("can only be used by the vault operator");
  });
});
