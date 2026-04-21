/**
 * Swap Shield — oracle price protection tests.
 *
 * Tests:
 * 1. Divergence calculation (DEX gives less than oracle → blocked)
 * 2. Direct expected-output divergence (no slippage reversal)
 * 3. Graceful degradation (no price feed, oracle error)
 * 4. Edge cases (zero amounts, same token, wrap/unwrap)
 * 5. Opt-out / opt-in flow
 * 6. Slippage storage and resolution
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock vault.ts getClient before importing swapShield ──
const mockReadContract = vi.fn();
vi.mock("../src/services/vault.js", () => ({
  getClient: () => ({
    readContract: mockReadContract,
  }),
}));

import {
  checkSwapPrice,
  isSwapShieldDisabled,
  disableSwapShield,
  enableSwapShield,
  getStoredSlippage,
  setStoredSlippage,
  DEFAULT_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
} from "../src/services/swapShield.js";
import type { Address } from "viem";

// ── Mock KV namespace ──
function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiry?: number }>();
  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      const expiry = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
      store.set(key, { value, expiry });
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

const VAULT = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const TOKEN_IN = "0xaaaa000000000000000000000000000000000001" as Address;
const TOKEN_OUT = "0xbbbb000000000000000000000000000000000002" as Address;
const OPERATOR = "0xcccc000000000000000000000000000000000003";
const CHAIN_ID = 8453;
const ALCHEMY_KEY = "test-key";

describe("Swap Shield — checkSwapPrice", () => {
  beforeEach(() => {
    mockReadContract.mockReset();
  });

  it("allows swaps within 5% divergence", async () => {
    // Oracle says 1000 tokenOut, DEX gives 960
    // Divergence = (1000 - 960) / 1000 = 4%
    mockReadContract.mockResolvedValue(1000n * 10n ** 18n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,       // 1 tokenIn
      960n * 10n ** 18n,
      100,                    // 1% slippage
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(parseFloat(result.divergencePct)).toBeLessThan(5);
  });

  it("blocks swaps exceeding 5% divergence", async () => {
    // Oracle says 1000, DEX gives 800
    // Divergence = (1000 - 800) / 1000 = 20%
    mockReadContract.mockResolvedValue(1000n * 10n ** 18n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      800n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.code).toBe("BLOCKED");
    expect(parseFloat(result.divergencePct)).toBeGreaterThan(5);
    expect(result.reason).toContain("Swap Shield blocked");
    expect(result.reason).toContain("TWAP");
  });

  it("allows swaps where DEX gives moderately MORE than oracle (favorable)", async () => {
    // Oracle says 1000, DEX gives 1050 (5% favorable — within 10% limit)
    mockReadContract.mockResolvedValue(1000n * 10n ** 18n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1050n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.divergencePct).toBe("-5.00");
  });

  it("blocks swaps where DEX gives suspiciously MORE than oracle (>10% favorable)", async () => {
    // Oracle says 1000, DEX gives 1200 (20% favorable — stale oracle / manipulated route)
    mockReadContract.mockResolvedValue(1000n * 10n ** 18n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1200n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.code).toBe("BLOCKED");
  });

  it("uses expected DEX output directly for divergence", async () => {
    // Oracle = 1000, DEX quote = 970 → divergence = 3%
    mockReadContract.mockResolvedValue(1000n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n,
      970n,
      300, // 3% slippage
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.divergencePct).toBe("3.00");
  });

  it("gracefully handles missing price feed (hasPriceFeed returns false)", async () => {
    // convertTokenAmount reverts, then hasPriceFeed reports feed absent
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))   // convertTokenAmount
      .mockResolvedValueOnce(false)                              // hasPriceFeed(tokenIn)
      .mockResolvedValueOnce(true);                             // hasPriceFeed(tokenOut)

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1000n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("NO_PRICE_FEED");
  });

  it("classifies ORACLE_ERROR when hasPriceFeed returns true but convertTokenAmount still reverts", async () => {
    // convertTokenAmount reverts, but hasPriceFeed says feeds are available → unexpected condition
    mockReadContract
      .mockRejectedValueOnce(new Error("execution reverted"))   // convertTokenAmount
      .mockResolvedValueOnce(true)                               // hasPriceFeed(tokenIn)
      .mockResolvedValueOnce(true);                             // hasPriceFeed(tokenOut)

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1000n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("ORACLE_ERROR");
  });

  it("classifies ORACLE_ERROR when vault has no EOracle extension (hasPriceFeed also reverts)", async () => {
    // All readContract calls throw — vault likely doesn't implement EOracle
    mockReadContract.mockRejectedValue(new Error("execution reverted"));

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1000n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("ORACLE_ERROR");
  });

  it("blocks invalid quote when expected output is zero for non-zero input", async () => {
    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      0n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("INVALID_QUOTE");
    expect(result.reason).toContain("expected output is zero");
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("rejects negative DEX expected output as INVALID_QUOTE without hitting the oracle", async () => {
    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      -1n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("INVALID_QUOTE");
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("rejects negative input amount as INVALID_QUOTE without hitting the oracle", async () => {
    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      -1n,
      100n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("INVALID_QUOTE");
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("treats negative oracle return as ORACLE_ERROR (fail closed, no sign flip)", async () => {
    // If convertTokenAmount somehow returns a negative int256 for a positive
    // input, we must NOT silently flip the sign — doing so could bypass the
    // divergence threshold. Degrade gracefully to ORACLE_ERROR instead.
    mockReadContract.mockResolvedValueOnce(-1000n * 10n ** 18n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      500n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("ORACLE_ERROR");
  });

  it("emits consistent negative divergencePct for favorable block (no double sign)", async () => {
    // Oracle 1000, DEX 1200 → 20% favorable, blocked.
    // divergencePct must be "-20.00" — never "--20.00".
    mockReadContract.mockResolvedValue(1000n * 10n ** 18n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1200n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
    // Must carry exactly one leading minus — never "--20.00".
    expect(result.divergencePct).toBe("-20.00");
  });

  it("skips check for zero amounts", async () => {
    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      0n, 0n, 100, ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("skips check when oracle returns zero", async () => {
    mockReadContract.mockResolvedValue(0n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n * 10n ** 18n,
      1000n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("ORACLE_ERROR");
  });

  it("normalizes WETH to address(0) for Base chain", async () => {
    const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;
    mockReadContract.mockResolvedValue(1000n);

    await checkSwapPrice(
      VAULT, 8453, WETH_BASE, TOKEN_OUT,
      1n, 950n, 100, ALCHEMY_KEY,
    );

    // The first arg to readContract should have address(0) as tokenIn
    const callArgs = mockReadContract.mock.calls[0][0];
    expect(callArgs.args[0]).toBe("0x0000000000000000000000000000000000000000");
  });

  it("skips check for same token (wrap/unwrap) after normalization", async () => {
    const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;

    const result = await checkSwapPrice(
      VAULT, 8453, WETH_BASE, ZERO,
      1n * 10n ** 18n,
      1n * 10n ** 18n,
      100,
      ALCHEMY_KEY,
    );

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("respects custom maxDivergencePct", async () => {
    // Divergence = 4%, custom threshold 2%
    mockReadContract.mockResolvedValue(1000n);

    const result = await checkSwapPrice(
      VAULT, CHAIN_ID, TOKEN_IN, TOKEN_OUT,
      1n,
      960n,
      100,
      ALCHEMY_KEY,
      2, // 2% max divergence
    );

    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
  });
});

describe("Swap Shield — opt-out flow", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("starts with shield enabled (not disabled)", async () => {
    const disabled = await isSwapShieldDisabled(kv, OPERATOR, VAULT);
    expect(disabled).toBe(false);
  });

  it("disableSwapShield sets opt-out with TTL", async () => {
    await disableSwapShield(kv, OPERATOR, VAULT);

    const disabled = await isSwapShieldDisabled(kv, OPERATOR, VAULT);
    expect(disabled).toBe(true);

    // Verify KV put was called with TTL
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringContaining("swap-shield-disabled:"),
      expect.any(String),
      { expirationTtl: 600 },
    );
  });

  it("enableSwapShield removes opt-out", async () => {
    await disableSwapShield(kv, OPERATOR, VAULT);
    expect(await isSwapShieldDisabled(kv, OPERATOR, VAULT)).toBe(true);

    await enableSwapShield(kv, OPERATOR, VAULT);
    expect(await isSwapShieldDisabled(kv, OPERATOR, VAULT)).toBe(false);
  });

  it("uses case-insensitive addresses", async () => {
    await disableSwapShield(kv, OPERATOR.toUpperCase(), VAULT.toUpperCase());
    const disabled = await isSwapShieldDisabled(kv, OPERATOR.toLowerCase(), VAULT.toLowerCase());
    expect(disabled).toBe(true);
  });
});

describe("Swap Shield — slippage storage", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("returns null when no slippage stored", async () => {
    const result = await getStoredSlippage(kv, OPERATOR);
    expect(result).toBeNull();
  });

  it("stores and retrieves slippage", async () => {
    await setStoredSlippage(kv, OPERATOR, 50);
    const result = await getStoredSlippage(kv, OPERATOR);
    expect(result).toBe(50);
  });

  it("rejects non-integer stored slippage payloads", async () => {
    await (kv.put as any)(`slippage:${OPERATOR.toLowerCase()}`, "50.5");
    expect(await getStoredSlippage(kv, OPERATOR)).toBeNull();

    await (kv.put as any)(`slippage:${OPERATOR.toLowerCase()}`, "50xyz");
    expect(await getStoredSlippage(kv, OPERATOR)).toBeNull();
  });

  it("rejects slippage below minimum", async () => {
    await expect(setStoredSlippage(kv, OPERATOR, 5)).rejects.toThrow("Slippage must be between");
  });

  it("rejects non-integer slippage", async () => {
    await expect(setStoredSlippage(kv, OPERATOR, 50.5)).rejects.toThrow("integer");
  });

  it("rejects slippage above maximum", async () => {
    await expect(setStoredSlippage(kv, OPERATOR, 600)).rejects.toThrow("Slippage must be between");
  });

  it("exports correct constants", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(100);
    expect(MIN_SLIPPAGE_BPS).toBe(10);
    expect(MAX_SLIPPAGE_BPS).toBe(500);
  });
});
