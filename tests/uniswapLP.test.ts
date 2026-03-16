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
import { decodePositionInfo } from "../src/services/uniswapLP.js";

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
