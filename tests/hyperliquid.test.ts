/**
 * Hyperliquid normalizer + fast-path parser tests.
 *
 * normalizeHlPosition / normalizeHlOpenOrder map Hyperliquid Core info API
 * payloads to the report shape. tryFastPathHyperliquid mirrors the deterministic
 * GMX fast paths: unambiguous "hyperliquid"-keyword commands bypass the LLM.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeHlPosition,
  normalizeHlOpenOrder,
  type HlApiPosition,
  type HlOpenOrder,
} from "../src/services/hyperliquid.js";
import { tryFastPathHyperliquid } from "../src/llm/client.js";

describe("normalizeHlPosition", () => {
  const base: HlApiPosition = {
    coin: "BTC",
    szi: "0.15",
    entryPx: "66000",
    positionValue: "10085.175",
    unrealizedPnl: "185.175",
    leverage: { type: "cross", value: 3 },
    liquidationPx: "45012.5",
    marginUsed: "3361.72",
    maxLeverage: 40,
    cumFunding: { allTime: "12.5", sinceOpen: "-2.25", sinceChange: "0" },
  };

  it("maps a long position with mark price derived from positionValue / |szi|", () => {
    const p = normalizeHlPosition(base, 0, 5);
    expect(p.coin).toBe("BTC");
    expect(p.isLong).toBe(true);
    expect(p.assetIndex).toBe(0);
    expect(p.sizeToken).toBe("0.15");
    expect(p.absSizeToken).toBe(0.15);
    expect(p.positionValue).toBeCloseTo(10085.175);
    expect(p.markPx).toBe("$67,234.5");
    expect(p.entryPx).toBe("$66,000");
    expect(p.liquidationPx).toBe("$45,012.5");
    expect(p.leverage).toBe("3x");
    expect(p.leverageType).toBe("cross");
    expect(p.unrealizedPnl).toContain("+");
    expect(p.unrealizedPnlPercent).toContain("%");
    expect(p.maxLeverage).toBe(40);
  });

  it("maps a short position (negative szi)", () => {
    const p = normalizeHlPosition({ ...base, szi: "-0.15" }, 0, 5);
    expect(p.isLong).toBe(false);
    expect(p.sizeToken).toBe("-0.15");
  });

  it("handles missing liquidation price and funding", () => {
    const p = normalizeHlPosition(
      { ...base, liquidationPx: null, cumFunding: undefined },
      0,
      5,
    );
    expect(p.liquidationPx).toBeNull();
    expect(p.fundingSinceOpen).toBe("—");
  });
});

describe("normalizeHlOpenOrder", () => {
  const base: HlOpenOrder = {
    coin: "ETH",
    side: "A",
    sz: "1.234",
    origSz: "1.234",
    limitPx: "3000.5",
    oid: 12345678,
    cloid: null,
    tif: "GTC",
    reduceOnly: false,
    orderType: "limit",
    timestamp: 1750000000,
  };

  it("maps an ask (sell) order", () => {
    const o = normalizeHlOpenOrder(base, 1, 4);
    expect(o.coin).toBe("ETH");
    expect(o.side).toBe("short");
    expect(o.oid).toBe(12345678);
    expect(o.cloid).toBeNull();
    expect(o.price).toBe("$3,000.5");
  });

  it("reduce-only bid closes a short (side reads as short)", () => {
    const o = normalizeHlOpenOrder({ ...base, side: "B", reduceOnly: true }, 1, 4);
    expect(o.reduceOnly).toBe(true);
    expect(o.side).toBe("short");
  });
});

describe("tryFastPathHyperliquid", () => {
  it("routes positions/account queries without the LLM", () => {
    expect(tryFastPathHyperliquid("show my hyperliquid positions"))
      .toEqual({ name: "hyperliquid_get_positions", args: {} });
    expect(tryFastPathHyperliquid("hyperliquid account"))
      .toEqual({ name: "hyperliquid_get_positions", args: {} });
  });

  it("routes market listing", () => {
    expect(tryFastPathHyperliquid("hyperliquid markets"))
      .toEqual({ name: "hyperliquid_get_markets", args: {} });
  });

  it("routes deposits", () => {
    expect(tryFastPathHyperliquid("deposit 500 usdc to hyperliquid"))
      .toEqual({ name: "hyperliquid_deposit", args: { amount: "500" } });
    expect(tryFastPathHyperliquid("hyperliquid deposit 1,250"))
      .toEqual({ name: "hyperliquid_deposit", args: { amount: "1250" } });
  });

  it("routes full closes with the coin only (backend resolves size/direction)", () => {
    expect(tryFastPathHyperliquid("close my BTC long on hyperliquid"))
      .toEqual({ name: "hyperliquid_limit_order", args: { coin: "BTC", close: true } });
  });

  it("routes open/increase with explicit size", () => {
    expect(tryFastPathHyperliquid("long 0.5 BTC on hyperliquid"))
      .toEqual({ name: "hyperliquid_limit_order", args: { coin: "BTC", side: "buy", size: "0.5" } });
    expect(tryFastPathHyperliquid("short 10 SOL on hyperliquid"))
      .toEqual({ name: "hyperliquid_limit_order", args: { coin: "SOL", side: "sell", size: "10" } });
  });

  it("ignores messages without the hyperliquid keyword (GMX keeps those)", () => {
    expect(tryFastPathHyperliquid("close my BTC long")).toBeNull();
    expect(tryFastPathHyperliquid("show my positions")).toBeNull();
    expect(tryFastPathHyperliquid("deposit 500 usdc to gmx")).toBeNull();
  });
});
