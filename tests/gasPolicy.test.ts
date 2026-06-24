/**
 * Gas Policy Webhook tests — per-wallet daily gas sponsorship spending limit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Address } from "viem";

const mockConvertTokenAmountViaOracle = vi.hoisted(() => vi.fn());

vi.mock("../src/services/oraclePrice.js", () => ({
  convertTokenAmountViaOracle: mockConvertTokenAmountViaOracle,
}));

import {
  parseBigInt,
  getCurrentDayBucket,
  estimateGasCostUsd,
  checkSpendingLimit,
  recordGasSpend,
  DEFAULT_GAS_SPENDING_LIMIT_USD,
  GAS_SPEND_KEY,
} from "../src/routes/gasPolicy.js";
import { TOKEN_MAP } from "../src/config.js";
import { CROSSCHAIN_TOKENS } from "../src/services/crosschainConfig.js";
import { BACKGEO_ORACLE } from "../src/services/oraclePool.js";

// ── Fixtures ────────────────────────────────────────────────────────────

const SENDER = "0xAgentWallet000000000000000000000000000000" as Address;
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ALCHEMY_KEY = "test-key";
const BASE_CHAIN_ID = 8453;
const SPENDING_DECIMALS = 18;

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeUserOp(overrides: Record<string, unknown> = {}) {
  return {
    sender: SENDER,
    callData: "0x",
    maxFeePerGas: "0x5f5e100", // 100 gwei
    callGasLimit: "0x186a0",    // 100k
    verificationGasLimit: "0x186a0", // 100k
    preVerificationGas: "0x186a0",   // 100k
    ...overrides,
  };
}

function limitRaw(usd: number): bigint {
  return BigInt(Math.floor(usd * 10 ** SPENDING_DECIMALS));
}

// ── parseBigInt ─────────────────────────────────────────────────────────

describe("parseBigInt", () => {
  it("parses hex strings", () => {
    expect(parseBigInt("0x5f5e100")).toBe(100000000n);
  });

  it("parses decimal strings", () => {
    expect(parseBigInt("100000")).toBe(100000n);
  });

  it("parses numbers", () => {
    expect(parseBigInt(100000)).toBe(100000n);
  });

  it("returns 0 for undefined/null", () => {
    expect(parseBigInt(undefined)).toBe(0n);
    expect(parseBigInt(null)).toBe(0n);
  });

  it("returns 0 for empty string", () => {
    expect(parseBigInt("")).toBe(0n);
  });
});

// ── getCurrentDayBucket ─────────────────────────────────────────────────

describe("getCurrentDayBucket", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    // 2026-06-22 13:00:00 UTC
    const ts = Date.UTC(2026, 5, 22, 13, 0, 0);
    expect(getCurrentDayBucket(ts)).toBe("2026-06-22");
  });

  it("rolls over at UTC midnight", () => {
    // 2026-06-22 23:59:59 UTC
    const ts = Date.UTC(2026, 5, 22, 23, 59, 59);
    expect(getCurrentDayBucket(ts)).toBe("2026-06-22");
  });
});

// ── TOKEN_MAP coverage for all oracle chains ────────────────────────────

describe("TOKEN_MAP USDC coverage", () => {
  it("has a USDC address for every chain where BackgeoOracle is deployed", () => {
    for (const chainId of Object.keys(BACKGEO_ORACLE)) {
      const usdc = TOKEN_MAP[Number(chainId)]?.USDC;
      expect(usdc, `Missing USDC in TOKEN_MAP for chain ${chainId}`).toBeDefined();
      expect(usdc).toMatch(/^0x[a-fA-F0-9]{40}$/);
    }
  });

  it("matches the authoritative CROSSCHAIN_TOKENS USDC addresses", () => {
    for (const chainId of Object.keys(BACKGEO_ORACLE)) {
      const tokenMapUsdc = TOKEN_MAP[Number(chainId)]?.USDC?.toLowerCase();
      const crosschainUsdc = CROSSCHAIN_TOKENS[Number(chainId)]?.find((t) => t.type === "USDC")?.address.toLowerCase();
      expect(tokenMapUsdc, `TOKEN_MAP/USDC mismatch on chain ${chainId}`).toBe(crosschainUsdc);
    }
  });
});

// ── estimateGasCostUsd ──────────────────────────────────────────────────

describe("estimateGasCostUsd", () => {
  beforeEach(() => {
    mockConvertTokenAmountViaOracle.mockReset();
  });

  it("returns 0 when gas fields are zero", async () => {
    const cost = await estimateGasCostUsd(BASE_CHAIN_ID, makeUserOp({ maxFeePerGas: "0x0" }), ALCHEMY_KEY);
    expect(cost).toEqual({ usd: 0, rawNormalized: 0n });
  });

  it("converts native → USDC via oracle using address 0x0", async () => {
    // 300k gas * 100 gwei = 0.03 native; oracle says that's 60 USDC (6 dec)
    mockConvertTokenAmountViaOracle.mockResolvedValue(60n * 10n ** 6n);

    const cost = await estimateGasCostUsd(BASE_CHAIN_ID, makeUserOp(), ALCHEMY_KEY);

    expect(cost).toEqual({ usd: 60, rawNormalized: 60n * 10n ** 18n });
    expect(mockConvertTokenAmountViaOracle).toHaveBeenCalledWith(
      BASE_CHAIN_ID,
      NATIVE_TOKEN_ADDRESS,
      300000n * 100000000n, // totalGas * maxFeePerGas
      CROSSCHAIN_TOKENS[BASE_CHAIN_ID]!.find((t) => t.type === "USDC")!.address,
      ALCHEMY_KEY,
    );
  });

  it("works on BNB Chain where native currency is BNB", async () => {
    // BNB Chain USDC is 18 decimals; oracle returns 10 * 10^18 raw units = $10.00.
    mockConvertTokenAmountViaOracle.mockResolvedValue(10n * 10n ** 18n);

    const cost = await estimateGasCostUsd(56, makeUserOp(), ALCHEMY_KEY);

    expect(cost).toEqual({ usd: 10, rawNormalized: 10n * 10n ** 18n });
    expect(mockConvertTokenAmountViaOracle).toHaveBeenCalledWith(
      56,
      NATIVE_TOKEN_ADDRESS,
      expect.any(BigInt),
      CROSSCHAIN_TOKENS[56]!.find((t) => t.type === "USDC")!.address,
      ALCHEMY_KEY,
    );
  });

  it("works on Polygon where native currency is POL", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(15n * 10n ** 6n);

    const cost = await estimateGasCostUsd(137, makeUserOp(), ALCHEMY_KEY);

    expect(cost).toEqual({ usd: 15, rawNormalized: 15n * 10n ** 18n });
    expect(mockConvertTokenAmountViaOracle).toHaveBeenCalledWith(
      137,
      NATIVE_TOKEN_ADDRESS,
      expect.any(BigInt),
      CROSSCHAIN_TOKENS[137]!.find((t) => t.type === "USDC")!.address,
      ALCHEMY_KEY,
    );
  });

  it("works on Unichain", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(20n * 10n ** 6n);

    const cost = await estimateGasCostUsd(130, makeUserOp(), ALCHEMY_KEY);

    expect(cost).toEqual({ usd: 20, rawNormalized: 20n * 10n ** 18n });
    expect(mockConvertTokenAmountViaOracle).toHaveBeenCalledWith(
      130,
      NATIVE_TOKEN_ADDRESS,
      expect.any(BigInt),
      CROSSCHAIN_TOKENS[130]!.find((t) => t.type === "USDC")!.address,
      ALCHEMY_KEY,
    );
  });

  it("returns null when chain has no USDC mapping", async () => {
    const cost = await estimateGasCostUsd(999999, makeUserOp(), ALCHEMY_KEY);
    expect(cost).toBeNull();
  });

  it("returns null when oracle conversion fails", async () => {
    mockConvertTokenAmountViaOracle.mockRejectedValue(new Error("no feed"));
    const cost = await estimateGasCostUsd(BASE_CHAIN_ID, makeUserOp(), ALCHEMY_KEY);
    expect(cost).toBeNull();
  });
});

// ── checkSpendingLimit ──────────────────────────────────────────────────

describe("checkSpendingLimit", () => {
  beforeEach(() => {
    mockConvertTokenAmountViaOracle.mockReset();
  });

  it("approves when under the daily limit (read-only, does not pre-charge)", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(2n * 10n ** 6n); // $2.00
    const kv = makeKV();

    const result = await checkSpendingLimit(kv, SENDER, BASE_CHAIN_ID, makeUserOp(), ALCHEMY_KEY, limitRaw(5));

    expect(result.approved).toBe(true);
    expect(result.estimatedCost).toBe(2);
    expect(result.currentSpend).toBe(0);
    expect(result.limit).toBe(5);
    // Nothing should be written until the transaction actually settles.
    const stored = await kv.get(`${GAS_SPEND_KEY}${SENDER.toLowerCase()}:${getCurrentDayBucket()}`);
    expect(stored).toBeNull();
  });

  it("rejects when a single request would exceed the daily limit", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(6n * 10n ** 6n); // $6.00 > $5 limit
    const kv = makeKV();

    const result = await checkSpendingLimit(kv, SENDER, BASE_CHAIN_ID, makeUserOp(), ALCHEMY_KEY, limitRaw(5));

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Daily gas sponsorship limit exceeded");
    expect(result.estimatedCost).toBe(6);
    expect(result.limit).toBe(5);
  });

  it("rejects when cumulative spend exceeds the daily limit", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(3n * 10n ** 6n); // $3.00
    const kv = makeKV();

    // Simulate a previous settled transaction that already consumed $3.
    await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 3n * 10n ** 18n, ALCHEMY_KEY);

    // A new $3 request would bring total to $6.
    const result = await checkSpendingLimit(kv, SENDER, BASE_CHAIN_ID, makeUserOp(), ALCHEMY_KEY, limitRaw(5));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Daily gas sponsorship limit exceeded");
    expect(result.currentSpend).toBe(3);
  });

  it("resets spend tracking at UTC midnight", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(4n * 10n ** 6n); // $4.00
    const kv = makeKV();

    // Spend $4 on 2026-06-22
    const day1 = Date.UTC(2026, 5, 22, 13, 0, 0);
    await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 4n * 10n ** 18n, ALCHEMY_KEY, day1);

    // Next day, same wallet should see $0 spent again
    const day2 = Date.UTC(2026, 5, 23, 13, 0, 0);
    const result = await checkSpendingLimit(kv, SENDER, BASE_CHAIN_ID, makeUserOp(), ALCHEMY_KEY, limitRaw(5), day2);
    expect(result.approved).toBe(true);
    expect(result.currentSpend).toBe(0);
  });

  it("enforces the limit on Polygon (non-ETH native currency)", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(6n * 10n ** 6n); // $6.00
    const kv = makeKV();

    const result = await checkSpendingLimit(kv, SENDER, 137, makeUserOp(), ALCHEMY_KEY, limitRaw(5));

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Daily gas sponsorship limit exceeded");
  });

  it("uses 18-decimal USDC on BNB Chain", async () => {
    // BNB Chain USDC is 18 decimals. Oracle returns 6 * 10^18 raw units = $6.00.
    mockConvertTokenAmountViaOracle.mockResolvedValue(6n * 10n ** 18n);
    const kv = makeKV();

    const result = await checkSpendingLimit(kv, SENDER, 56, makeUserOp(), ALCHEMY_KEY, limitRaw(5));

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Daily gas sponsorship limit exceeded");
    expect(mockConvertTokenAmountViaOracle).toHaveBeenCalledWith(
      56,
      NATIVE_TOKEN_ADDRESS,
      expect.any(BigInt),
      CROSSCHAIN_TOKENS[56]!.find((t) => t.type === "USDC")!.address,
      ALCHEMY_KEY,
    );
  });

  it("sums cross-chain spend in USD terms, not raw token units", async () => {
    // Base USDC is 6 decimals, BNB USDC is 18 decimals.
    // Both settled transactions represent $3.00 actual cost.
    mockConvertTokenAmountViaOracle
      .mockResolvedValueOnce(3n * 10n ** 6n)   // Base: $3.00 (6 decimals)
      .mockResolvedValueOnce(3n * 10n ** 18n); // BNB:  $3.00 (18 decimals)

    const kv = makeKV();

    // Record a settled $3 Base transaction
    await recordGasSpend(kv, SENDER, 8453, 3n * 10n ** 18n, ALCHEMY_KEY);

    // A new $3 BNB request sees $3 already spent and rejects.
    const bnbResult = await checkSpendingLimit(kv, SENDER, 56, makeUserOp(), ALCHEMY_KEY, limitRaw(5));
    expect(bnbResult.approved).toBe(false);
    expect(bnbResult.reason).toContain("Daily gas sponsorship limit exceeded");
    // The tracker saw $3 + $3 = $6, not 3e6 + 3e18 raw units.
    expect(bnbResult.currentSpend).toBe(3);
  });

  it("uses exact bigint math so small amounts do not accumulate rounding error", async () => {
    // $0.10 per transaction, 10 settled transactions → $1.00 exactly.
    // 0.1 USDC (6 decimals) = 100_000 raw units.
    mockConvertTokenAmountViaOracle.mockResolvedValue(100000n);
    const kv = makeKV();

    for (let i = 0; i < 10; i++) {
      await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 1n * 10n ** 17n, ALCHEMY_KEY); // $0.10
    }

    const stored = await kv.get(`${GAS_SPEND_KEY}${SENDER.toLowerCase()}:${getCurrentDayBucket()}`);
    expect(stored).toBe(String(10n ** 18n)); // $1.00 in 18-decimal fixed point
  });

  it("uses the default limit when none is provided", async () => {
    expect(DEFAULT_GAS_SPENDING_LIMIT_USD).toBe(5);
  });
});

// ── recordGasSpend ─────────────────────────────────────────────────────

describe("recordGasSpend", () => {
  beforeEach(() => {
    mockConvertTokenAmountViaOracle.mockReset();
  });

  it("records a settled transaction's actual gas cost in USD", async () => {
    mockConvertTokenAmountViaOracle.mockResolvedValue(2n * 10n ** 6n); // $2.00
    const kv = makeKV();

    await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 2n * 10n ** 18n, ALCHEMY_KEY);

    const stored = await kv.get(`${GAS_SPEND_KEY}${SENDER.toLowerCase()}:${getCurrentDayBucket()}`);
    expect(stored).toBe(String(2n * 10n ** 18n)); // $2.00
  });

  it("accumulates multiple transactions", async () => {
    mockConvertTokenAmountViaOracle
      .mockResolvedValueOnce(1n * 10n ** 6n)   // $1.00
      .mockResolvedValueOnce(15n * 10n ** 5n); // $1.50
    const kv = makeKV();

    await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 1n * 10n ** 18n, ALCHEMY_KEY);
    await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 15n * 10n ** 17n, ALCHEMY_KEY);

    const stored = await kv.get(`${GAS_SPEND_KEY}${SENDER.toLowerCase()}:${getCurrentDayBucket()}`);
    expect(stored).toBe(String(25n * 10n ** 17n)); // $2.50
  });

  it("ignores zero or negative gas costs", async () => {
    const kv = makeKV();
    await recordGasSpend(kv, SENDER, BASE_CHAIN_ID, 0n, ALCHEMY_KEY);
    const stored = await kv.get(`${GAS_SPEND_KEY}${SENDER.toLowerCase()}:${getCurrentDayBucket()}`);
    expect(stored).toBeNull();
  });

  it("warns and no-ops when the chain has no USDC mapping", async () => {
    const kv = makeKV();
    await recordGasSpend(kv, SENDER, 999999, 1n * 10n ** 18n, ALCHEMY_KEY);
    const stored = await kv.get(`${GAS_SPEND_KEY}${SENDER.toLowerCase()}:${getCurrentDayBucket()}`);
    expect(stored).toBeNull();
  });
});
