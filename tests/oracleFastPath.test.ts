/**
 * Fast-path parser tests for refresh_oracle_feed.
 */
import { describe, it, expect } from "vitest";
import { tryFastPathOracleRefresh } from "../src/llm/client.js";

describe("tryFastPathOracleRefresh", () => {
  it("detects 'sync grg price feed on polygon by buying 8 pol'", () => {
    // Chain suffix is stripped before the fast path runs; remaining message
    // should still contain the feed token and the buy clause.
    const result = tryFastPathOracleRefresh(
      "sync grg price feed by buying 8 pol",
      137,
    );
    expect(result).toEqual({
      name: "refresh_oracle_feed",
      args: { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amountOut: "8" },
    });
  });

  it("detects 'sync grg price feed by selling 8 pol'", () => {
    const result = tryFastPathOracleRefresh(
      "sync grg price feed by selling 8 pol",
      137,
    );
    expect(result).toEqual({
      name: "refresh_oracle_feed",
      args: { token: "GRG", tokenIn: "POL", tokenOut: "GRG", amount: "8" },
    });
  });

  it("detects 'sync grg price feed by buying 8 grg'", () => {
    const result = tryFastPathOracleRefresh(
      "sync grg price feed by buying 8 grg",
      137,
    );
    expect(result).toEqual({
      name: "refresh_oracle_feed",
      args: { token: "GRG", tokenIn: "POL", tokenOut: "GRG", amountOut: "8" },
    });
  });

  it("detects 'sync grg price feed by selling 8 grg'", () => {
    const result = tryFastPathOracleRefresh(
      "sync grg price feed by selling 8 grg",
      137,
    );
    expect(result).toEqual({
      name: "refresh_oracle_feed",
      args: { token: "GRG", tokenIn: "GRG", tokenOut: "POL", amount: "8" },
    });
  });

  it("detects 'refresh oracle for grg with 0.5 pol'", () => {
    const result = tryFastPathOracleRefresh(
      "refresh oracle for grg with 0.5 pol",
      137,
    );
    expect(result).toEqual({
      name: "refresh_oracle_feed",
      args: { token: "GRG", tokenIn: "POL", tokenOut: "GRG", amount: "0.5" },
    });
  });

  it("falls through when no amount is present", () => {
    const result = tryFastPathOracleRefresh(
      "sync grg price feed on polygon",
      137,
    );
    expect(result).toBeNull();
  });

  it("falls through for unrelated messages", () => {
    const result = tryFastPathOracleRefresh(
      "what is the price of grg",
      137,
    );
    expect(result).toBeNull();
  });
});
