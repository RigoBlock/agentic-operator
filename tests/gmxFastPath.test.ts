/**
 * GMX fast-path parser tests.
 */
import { describe, it, expect } from "vitest";
import { tryFastPathGmxIncrease } from "../src/llm/client.js";

describe("tryFastPathGmxIncrease", () => {
  it("parses all three 'without adding/increasing/new collateral' variants consistently", () => {
    const variants = [
      "increase my long litusd gmx position by 10,000 usd without increasing collateral",
      "increase my long litusd gmx position by 10,000 usd without adding collateral",
      "increase my long litusd gmx position by 10,000 usd without adding new collateral",
    ];
    for (const msg of variants) {
      expect(tryFastPathGmxIncrease(msg)).toEqual({
        name: "gmx_increase_position",
        args: {
          market: "LITUSD",
          isLong: true,
          sizeDeltaUsd: "10000",
          collateralAmount: "0",
        },
      });
    }
  });

  it("parses 'increase my short BTC position by 5000 usd'", () => {
    const result = tryFastPathGmxIncrease(
      "increase my short btc position by 5,000 usd",
    );
    expect(result).toEqual({
      name: "gmx_increase_position",
      args: {
        market: "BTC",
        isLong: false,
        sizeDeltaUsd: "5000",
      },
    });
  });

  it("keeps backward-compatible pattern 'increase by 1500 usd LIT/USD long 10x position' as notionalUsd", () => {
    const result = tryFastPathGmxIncrease(
      "increase by 1500 usd LIT/USD long 10x position",
    );
    expect(result).toEqual({
      name: "gmx_increase_position",
      args: {
        market: "LIT",
        isLong: true,
        notionalUsd: "1500",
        leverage: "10",
      },
    });
  });

  it("parses pattern B with 'without adding collateral' as sizeDeltaUsd + collateralAmount 0", () => {
    const result = tryFastPathGmxIncrease(
      "increase by 2000 usd LIT long position without adding collateral",
    );
    expect(result).toEqual({
      name: "gmx_increase_position",
      args: {
        market: "LIT",
        isLong: true,
        sizeDeltaUsd: "2000",
        collateralAmount: "0",
      },
    });
  });

  it("extracts collateral from 'using WETH'", () => {
    const result = tryFastPathGmxIncrease(
      "increase my long ETH/USD position by 1000 usd using WETH",
    );
    expect(result).toEqual({
      name: "gmx_increase_position",
      args: {
        market: "ETH",
        isLong: true,
        sizeDeltaUsd: "1000",
        collateral: "WETH",
      },
    });
  });

  it("returns null for an ambiguous message without direction", () => {
    const result = tryFastPathGmxIncrease(
      "increase my LIT position by 1000 usd",
    );
    expect(result).toBeNull();
  });

  it("returns gmx_get_positions for position-listing messages and gmx_decrease_position for close", () => {
    expect(tryFastPathGmxIncrease("show my gmx positions")).toEqual({
      name: "gmx_get_positions",
      args: {},
    });
    expect(tryFastPathGmxIncrease("close my LIT long position")).toEqual({
      name: "gmx_decrease_position",
      args: {
        market: "LIT",
        isLong: true,
        sizeDeltaUsd: "all",
      },
    });
  });
});
