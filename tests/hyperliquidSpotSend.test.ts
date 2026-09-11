/**
 * Core spot-send gas preflight tests — assertCoreSpotSendGas (pure rule) and the
 * handle_hyperliquid_spot_send preflight wiring (BRIDGE_RESERVE silent capping
 * removed; HyperCore charges each send's gas from the remaining Core spot USDC,
 * so the send must leave ≥ 0.1 USDC as a gas buffer; a pool's first successful
 * send also costs a one-time 1 USDC activation, noted but not enforced).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertCoreSpotSendGas,
  SPOT_SEND_GAS_USDC,
} from "../src/services/hyperliquidTrading.js";
import { handle_hyperliquid_spot_send } from "../src/llm/handlers/hyperliquid.js";
import type { RequestContext } from "../src/types.js";

// ── Mocked service reads (must be in vi.hoisted so vi.mock factories can reference them) ──

const { mockGetPrecompileBalances } = vi.hoisted(() => ({
  mockGetPrecompileBalances: vi.fn(),
}));

vi.mock("../src/services/hyperliquid.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/hyperliquid.js")>();
  return {
    ...actual,
    getHyperliquidPrecompileBalances: mockGetPrecompileBalances,
  };
});

const VAULT = "0x1111111111111111111111111111111111111111" as const;
const OPERATOR = "0xcccc000000000000000000000000000000000003" as const;

function makeCtx(): RequestContext {
  return {
    vaultAddress: VAULT,
    chainId: 999,
    isBrowserRequest: true,
    operatorAddress: OPERATOR,
    executionMode: "delegated",
  } as RequestContext;
}

function makeEnv(): any {
  return {};
}

/** Precompile balances with the given Core spot USDC (human), everything else zero. */
function precompileWithSpotUsdc(spotUsdcHuman: number) {
  return {
    perpAccountValue: 0n,
    perpNtlPos: 0n,
    perpMarginUsed: 0n,
    perpRawUsd: 0n,
    spotUsdcWei: BigInt(Math.round(spotUsdcHuman * 1e8)),
    spotUsdcHoldWei: 0n,
    activated: true,
  };
}

describe("assertCoreSpotSendGas", () => {
  it("passes when the residual is above the gas buffer", () => {
    expect(() =>
      assertCoreSpotSendGas({ spotUsdc: 2, amount: 2 - SPOT_SEND_GAS_USDC - 0.5 }),
    ).not.toThrow();
  });

  it("passes at the exact residual boundary (residual = 0.1)", () => {
    expect(() =>
      assertCoreSpotSendGas({ spotUsdc: 2, amount: 2 - SPOT_SEND_GAS_USDC }),
    ).not.toThrow();
  });

  it("replay attempt 4 (3 spot, send 1): residual 2.0 passes", () => {
    expect(() =>
      assertCoreSpotSendGas({ spotUsdc: 3, amount: 1 }),
    ).not.toThrow();
  });

  it("replay attempt 3 (3 spot, send 2): residual 1.0 passes the final model", () => {
    // Attempt 3's historical failure was the not-yet-paid one-time 1 USDC
    // activation plus an insufficient residual under the old 1.1 rule — not
    // reproducible under the final model, where the preflight is USDC-only and
    // the activation is advisory. Kept as a pass case.
    expect(() =>
      assertCoreSpotSendGas({ spotUsdc: 3, amount: 2 }),
    ).not.toThrow();
  });

  it("throws when the send would leave less than the gas buffer", () => {
    expect(() =>
      assertCoreSpotSendGas({ spotUsdc: 2, amount: 2 - SPOT_SEND_GAS_USDC + 0.001 }),
    ).toThrow(/blocked/);
  });

  it("throws when draining the entire spot balance", () => {
    expect(() =>
      assertCoreSpotSendGas({ spotUsdc: 2, amount: 2 }),
    ).toThrow(/HyperCore charges/);
  });

  it("error message explains the gas charge, shows the residual, and notes the first-send activation", () => {
    let message = "";
    try {
      assertCoreSpotSendGas({ spotUsdc: 2, amount: 1.95 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("gas (~0.002 USDC at the Core gas schedule");
    expect(message).toContain("Core spot USDC");
    expect(message).toContain("0.0500"); // residual the send would leave
    expect(message).toContain(`${SPOT_SEND_GAS_USDC} USDC`); // required residual
    expect(message).toContain("one-time 1 USDC activation fee");
    expect(message).toContain("~1.1 USDC");
    expect(message).toContain("retry with a smaller amount");
  });
});

describe("handle_hyperliquid_spot_send", () => {
  beforeEach(() => {
    mockGetPrecompileBalances.mockReset();
  });

  it("throws the gas-buffer error when the send would leave less than 0.1 USDC", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(2));

    await expect(
      handle_hyperliquid_spot_send(makeEnv(), makeCtx(), { amount: "2" }, "hyperliquid_spot_send"),
    ).rejects.toThrow(/HyperCore charges each Core→HyperEVM send's gas/);
    expect(mockGetPrecompileBalances).toHaveBeenCalledWith(VAULT);
  });

  it("succeeds when the send leaves at least the 0.1 USDC gas buffer", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(2));

    const result = await handle_hyperliquid_spot_send(
      makeEnv(), makeCtx(), { amount: "1.5" }, "hyperliquid_spot_send",
    );
    expect(result.transaction?.data).toBeTruthy();
    expect(result.message).toContain("1.5 USDC");
  });

  it("succeeds draining the spot balance down to exactly the gas buffer", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(2));

    const result = await handle_hyperliquid_spot_send(
      makeEnv(), makeCtx(), { amount: "1.9" }, "hyperliquid_spot_send",
    );
    expect(result.transaction?.data).toBeTruthy();
  });

  it("replay attempt 3 now passes the preflight (3 spot, send 2 → residual 1.0)", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(3));

    const result = await handle_hyperliquid_spot_send(
      makeEnv(), makeCtx(), { amount: "2" }, "hyperliquid_spot_send",
    );
    expect(result.transaction?.data).toBeTruthy();
  });

  it("does not silently cap the amount — the full requested amount is bridged", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(2));

    const result = await handle_hyperliquid_spot_send(
      makeEnv(), makeCtx(), { amount: "1.8" }, "hyperliquid_spot_send",
    );
    expect(result.message).toContain("1.8 USDC");
    expect(result.message).not.toContain("capped");
  });

  it("throws when the requested amount exceeds the Core spot USDC balance", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(2));

    await expect(
      handle_hyperliquid_spot_send(makeEnv(), makeCtx(), { amount: "5" }, "hyperliquid_spot_send"),
    ).rejects.toThrow(/Insufficient Core spot USDC/);
  });

  it("throws on a non-numeric amount", async () => {
    mockGetPrecompileBalances.mockResolvedValue(precompileWithSpotUsdc(2));
    await expect(
      handle_hyperliquid_spot_send(makeEnv(), makeCtx(), { amount: "abc" }, "hyperliquid_spot_send"),
    ).rejects.toThrow(/Invalid amount/);
  });
});
