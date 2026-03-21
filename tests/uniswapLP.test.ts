/**
 * Uniswap v4 LP tests — POSM addresses, PositionInfo decoding.
 *
 * PositionInfo layout (from PositionInfoLibrary.sol, LSB first):
 *   bits [7..0]     = hasSubscriber  (uint8)
 *   bits [31..8]    = tickLower      (int24, signed)
 *   bits [55..32]   = tickUpper      (int24, signed)
 *   bits [255..56]  = poolId         (bytes25)
 *
 * Helper: pack tickLower into bits[31..8] and tickUpper into bits[55..32].
 */
import { describe, it, expect } from "vitest";
import { decodePositionInfo, buildBurnPositionTx, buildRemoveLiquidityTx, buildCollectFeesTx } from "../src/services/uniswapLP.js";
import { Pool, Position, V4PositionManager } from "@uniswap/v4-sdk";
import { Token, Percent } from "@uniswap/sdk-core";

/** Encode ticks into a packed uint256 matching the Solidity layout. */
function packPositionInfo(tickLower: number, tickUpper: number, hasSubscriber = 0): bigint {
  const tl = BigInt(tickLower < 0 ? tickLower + 0x1000000 : tickLower) & 0xFFFFFFn;
  const tu = BigInt(tickUpper < 0 ? tickUpper + 0x1000000 : tickUpper) & 0xFFFFFFn;
  return (tu << 32n) | (tl << 8n) | BigInt(hasSubscriber);
}

describe("decodePositionInfo", () => {
  it("decodes positive tick values", () => {
    const packed = packPositionInfo(100, 200);
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(100);
    expect(result.tickUpper).toBe(200);
  });

  it("decodes negative tick values (two's complement int24)", () => {
    const packed = packPositionInfo(-100, -200);
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(-100);
    expect(result.tickUpper).toBe(-200);
  });

  it("decodes mixed positive/negative ticks", () => {
    const packed = packPositionInfo(-887272, 887272);
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(-887272);
    expect(result.tickUpper).toBe(887272);
  });

  it("decodes zero ticks", () => {
    const packed = 0n;
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(0);
    expect(result.tickUpper).toBe(0);
  });

  it("ignores upper poolId bits and lower hasSubscriber bits", () => {
    // Fill poolId (bits 255..56) and hasSubscriber (bits 7..0) with garbage
    const poolIdBits = 0xABCDEFn << 56n;
    const subscriberBit = 1n;
    const packed = poolIdBits | packPositionInfo(500, 1000) | subscriberBit;

    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(500);
    expect(result.tickUpper).toBe(1000);
  });

  it("handles extreme int24 boundary values", () => {
    // int24 range: -8388608 (0x800000) to 8388607 (0x7FFFFF)
    const packed = packPositionInfo(-8388608, 8388607);
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(-8388608);
    expect(result.tickUpper).toBe(8388607);
  });

  it("decodes typical Uniswap tick spacing boundaries", () => {
    // Common tick values for 0.3% fee tier (tickSpacing = 60):
    const packed = packPositionInfo(-887220, 887220);
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(-887220);
    expect(result.tickUpper).toBe(887220);
  });
});

// ── SDK Integration Tests ─────────────────────────────────────────────
// Reproduce the exact XAUT/USDT pool on Arbitrum (pool ID 0xb896...).
// These tests validate that the SDK generates valid calldata for add/remove
// liquidity without needing a live RPC connection.

describe("SDK calldata generation — XAUT/USDT Arbitrum", () => {
  const chainId = 42161;
  const XAUT = new Token(chainId, "0x40461291347e1eCbb09499F3371D3f17f10d7159", 6, "XAUT");
  const USDT = new Token(chainId, "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6, "USDT");
  const VAULT = "0xd14d4321a33F7eD001Ba5B60cE54b0F7Ba621247";
  const HOOKS = "0x0000000000000000000000000000000000000000";

  // Real on-chain state from StateView (March 2026)
  const sqrtPriceX96 = "5328788193066149239560957070774";
  const liquidity = "22042191260";
  const tick = 84175;

  const pool = new Pool(XAUT, USDT, 6000, 120, HOOKS, sqrtPriceX96, liquidity, tick);

  // Narrow range: center = round(84175/120)*120 = 84120, half = ceil(500/120)*120 = 600
  const tickLower = 83520;
  const tickUpper = 84720;

  it("single-sided USDT (amount1 only) — must NOT produce zero liquidity", () => {
    // This is the exact scenario that was failing: user provides 5 USDT, no XAUT
    const position = Position.fromAmount1({
      pool,
      tickLower,
      tickUpper,
      amount1: "5000000", // 5 USDT (6 decimals)
    });

    expect(BigInt(position.liquidity.toString())).toBeGreaterThan(0n);
    // SDK should compute a non-zero amount0 (XAUT)
    expect(BigInt(position.amount0.quotient.toString())).toBeGreaterThan(0n);
    expect(BigInt(position.amount1.quotient.toString())).toBeGreaterThan(0n);
  });

  it("single-sided XAUT (amount0 only) — derives USDT amount", () => {
    const position = Position.fromAmount0({
      pool,
      tickLower,
      tickUpper,
      amount0: "1500", // 0.0015 XAUT (6 decimals)
      useFullPrecision: true,
    });

    expect(BigInt(position.liquidity.toString())).toBeGreaterThan(0n);
    expect(BigInt(position.amount0.quotient.toString())).toBeGreaterThan(0n);
    expect(BigInt(position.amount1.quotient.toString())).toBeGreaterThan(0n);
  });

  it("both amounts provided — uses min liquidity", () => {
    const position = Position.fromAmounts({
      pool,
      tickLower,
      tickUpper,
      amount0: "1500",
      amount1: "5000000",
      useFullPrecision: true,
    });

    expect(BigInt(position.liquidity.toString())).toBeGreaterThan(0n);
  });

  it("generates valid modifyLiquidities calldata (selector 0xdd46508f)", () => {
    const position = Position.fromAmount1({
      pool,
      tickLower,
      tickUpper,
      amount1: "5000000",
    });

    const { calldata } = V4PositionManager.addCallParameters(position, {
      recipient: VAULT,
      slippageTolerance: new Percent(1, 100),
      deadline: Math.floor(Date.now() / 1000) + 1800,
    });

    // Must start with modifyLiquidities selector
    expect(calldata.startsWith("0xdd46508f")).toBe(true);
    // Calldata must be substantial (encoded actions + params)
    expect(calldata.length).toBeGreaterThan(100);
  });

  it("fromAmounts with amount0=0 correctly produces zero liquidity (confirms bug pattern)", () => {
    // This documents WHY we use fromAmount1 for single-sided input:
    // fromAmounts with one side = 0 when tick is in range gives liq = 0
    const position = Position.fromAmounts({
      pool,
      tickLower,
      tickUpper,
      amount0: "0",
      amount1: "5000000",
      useFullPrecision: true,
    });

    // This is the SDK's behavior — min(liq_from_0, liq_from_1) = min(0, X) = 0
    expect(position.liquidity.toString()).toBe("0");
  });

  it("full range position works with single-sided input", () => {
    // Full range: tickSpacing=120, max usable tick = floor(887272/120)*120 = 887160
    const fullLower = -887160;
    const fullUpper = 887160;

    const position = Position.fromAmount1({
      pool,
      tickLower: fullLower,
      tickUpper: fullUpper,
      amount1: "5000000",
    });

    expect(BigInt(position.liquidity.toString())).toBeGreaterThan(0n);
  });
});

// ── buildBurnPositionTx — action encoding ────────────────────────────
// The burn sequence MUST be DECREASE_LIQUIDITY(1) + TAKE_PAIR(0x11) + BURN_POSITION(3).
// Encoding just BURN_POSITION alone causes the POSM multicall to revert.
// Action values: DECREASE_LIQUIDITY=0x01, TAKE_PAIR=0x11, BURN_POSITION=0x03.
// They are packed as raw bytes inside the unlockData ABI parameter.

const VAULT = "0xd14d4321a33F7eD001Ba5B60cE54b0F7Ba621247" as const;
const CURRENCY0 = "0x40461291347e1eCbb09499F3371D3f17f10d7159" as const; // XAUT (Arbitrum)
const CURRENCY1 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as const; // USDT (Arbitrum)

describe("buildBurnPositionTx", () => {
  it("uses the modifyLiquidities selector (0xdd46508f)", () => {
    const { calldata } = buildBurnPositionTx("152699", CURRENCY0, CURRENCY1, VAULT);
    expect(calldata.startsWith("0xdd46508f")).toBe(true);
  });

  it("encodes the 3-action sequence: DECREASE_LIQUIDITY + TAKE_PAIR + BURN_POSITION", () => {
    const { calldata } = buildBurnPositionTx("152699", CURRENCY0, CURRENCY1, VAULT);
    // Actions packed as bytes: 0x01 (DECREASE_LIQUIDITY), 0x11 (TAKE_PAIR), 0x03 (BURN_POSITION)
    // ABI-encoded as `bytes`, the raw content "011103" appears in the calldata
    expect(calldata.toLowerCase()).toContain("011103");
  });

  it("does NOT encode a 2-action sequence (missing burn would be 0x0111)", () => {
    const { calldata } = buildBurnPositionTx("152699", CURRENCY0, CURRENCY1, VAULT);
    // "011100" would indicate only 2 actions (DL + TP) — the old broken encoding
    expect(calldata.toLowerCase()).not.toContain("011100");
  });

  it("includes the tokenId in the description", () => {
    const { description } = buildBurnPositionTx("152699", CURRENCY0, CURRENCY1, VAULT);
    expect(description).toContain("152699");
  });

  it("marks the operation as permanent in the description", () => {
    const { description } = buildBurnPositionTx("99999", CURRENCY0, CURRENCY1, VAULT);
    expect(description.toLowerCase()).toContain("permanent");
  });
});

// ── buildRemoveLiquidityTx — shouldBurn default ───────────────────────
// Default: burn=false (NFT kept as 0-liquidity position, reusable or manually burned).
// Explicit burn=true: appends BURN_POSITION to the action sequence.

describe("buildRemoveLiquidityTx — burn default and shouldBurn flag", () => {
  const params = {
    tokenA: CURRENCY0,
    tokenB: CURRENCY1,
    tokenId: "152699",
    liquidityAmount: "1000000",
  };

  it("without burn param: encodes 2-action sequence (DL + TP, no BURN_POSITION)", async () => {
    const { calldata, description } = await buildRemoveLiquidityTx(
      {} as any, params, 42161, VAULT,
    );
    // 2-action bytes: 0111 followed by zeros (not 011103)
    expect(calldata.toLowerCase()).not.toContain("011103");
    expect(calldata.toLowerCase()).toContain("0111");
    expect(description).not.toContain("burn NFT");
  });

  it("with burn=false: same as default — no BURN_POSITION", async () => {
    const { calldata } = await buildRemoveLiquidityTx(
      {} as any, { ...params, burn: false }, 42161, VAULT,
    );
    expect(calldata.toLowerCase()).not.toContain("011103");
  });

  it("with burn=true: encodes 3-action sequence (DL + TP + BURN_POSITION)", async () => {
    const { calldata, description } = await buildRemoveLiquidityTx(
      {} as any, { ...params, burn: true }, 42161, VAULT,
    );
    expect(calldata.toLowerCase()).toContain("011103");
    expect(description).toContain("burn NFT");
  });

  it("with burn=true: uses modifyLiquidities selector", async () => {
    const { calldata } = await buildRemoveLiquidityTx(
      {} as any, { ...params, burn: true }, 42161, VAULT,
    );
    expect(calldata.startsWith("0xdd46508f")).toBe(true);
  });
});

// ── buildCollectFeesTx — fee collection encoding ──────────────────────
// Collecting fees uses DECREASE_LIQUIDITY(0) + TAKE_PAIR — no BURN_POSITION.
// Action values: DECREASE_LIQUIDITY=0x01, TAKE_PAIR=0x11.

describe("buildCollectFeesTx", () => {
  it("uses the modifyLiquidities selector (0xdd46508f)", () => {
    const { calldata } = buildCollectFeesTx("152709", CURRENCY0, CURRENCY1, VAULT);
    expect(calldata.startsWith("0xdd46508f")).toBe(true);
  });

  it("encodes 2-action sequence: DECREASE_LIQUIDITY + TAKE_PAIR (0111)", () => {
    const { calldata } = buildCollectFeesTx("152709", CURRENCY0, CURRENCY1, VAULT);
    // Actions: 0x01 (DECREASE_LIQUIDITY) + 0x11 (TAKE_PAIR) = "0111"
    expect(calldata.toLowerCase()).toContain("0111");
  });

  it("does NOT include BURN_POSITION (no 011103 in calldata)", () => {
    const { calldata } = buildCollectFeesTx("152709", CURRENCY0, CURRENCY1, VAULT);
    expect(calldata.toLowerCase()).not.toContain("011103");
  });

  it("includes the tokenId in the description", () => {
    const { description } = buildCollectFeesTx("152709", CURRENCY0, CURRENCY1, VAULT);
    expect(description).toContain("152709");
  });
});

