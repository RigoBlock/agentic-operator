import { describe, it, expect } from "vitest";
import { parseTelegramDirectChip } from "../src/routes/telegram.js";

describe("parseTelegramDirectChip", () => {
  it("maps Refresh positions to gmx_get_positions", () => {
    const result = parseTelegramDirectChip("Refresh positions");
    expect(result).toEqual({ type: "tool", toolName: "gmx_get_positions", args: {} });
  });

  it("maps Show GMX markets to gmx_get_markets", () => {
    const result = parseTelegramDirectChip("Show GMX markets");
    expect(result).toEqual({ type: "tool", toolName: "gmx_get_markets", args: {} });
  });

  it("maps Refresh Hyperliquid positions to hyperliquid_get_positions", () => {
    const result = parseTelegramDirectChip("Refresh Hyperliquid positions");
    expect(result).toEqual({ type: "tool", toolName: "hyperliquid_get_positions", args: {} });
  });

  it("maps Show Hyperliquid markets to hyperliquid_get_markets", () => {
    const result = parseTelegramDirectChip("Show Hyperliquid markets");
    expect(result).toEqual({ type: "tool", toolName: "hyperliquid_get_markets", args: {} });
  });

  it("returns a direct reply for Deposit USDC to Hyperliquid", () => {
    const result = parseTelegramDirectChip("Deposit USDC to Hyperliquid");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("deposit 500 usdc to hyperliquid");
  });

  it("returns a direct reply for Cancel Hyperliquid order", () => {
    const result = parseTelegramDirectChip("Cancel Hyperliquid order");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("oid");
  });

  it("returns a direct reply for Open new position", () => {
    const result = parseTelegramDirectChip("Open new position");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("long 1000 ETHUSDC 5x");
  });

  it("returns a direct reply for Open a long", () => {
    const result = parseTelegramDirectChip("Open a long");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("long &lt;size&gt;");
  });

  it("returns a direct reply for Cancel order", () => {
    const result = parseTelegramDirectChip("Cancel order");
    expect(result?.type).toBe("reply");
    expect((result as { text: string }).text).toContain("cancel order 0xOrderKey");
  });

  it("maps menu card titles of no-arg tools to direct invocation", () => {
    expect(parseTelegramDirectChip("View Hyperliquid account"))
      .toEqual({ type: "tool", toolName: "hyperliquid_get_positions", args: {} });
    expect(parseTelegramDirectChip("Recent fills & open orders"))
      .toEqual({ type: "tool", toolName: "hyperliquid_get_fills", args: {} });
    expect(parseTelegramDirectChip("View GMX positions"))
      .toEqual({ type: "tool", toolName: "gmx_get_positions", args: {} });
    expect(parseTelegramDirectChip("View LP positions"))
      .toEqual({ type: "tool", toolName: "get_lp_positions", args: {} });
    expect(parseTelegramDirectChip("Aggregated multi-chain NAV"))
      .toEqual({ type: "tool", toolName: "get_aggregated_nav", args: {} });
    expect(parseTelegramDirectChip("Rebalance plan (analysis only, no transactions)"))
      .toEqual({ type: "tool", toolName: "get_rebalance_plan", args: {} });
  });

  it("returns usage templates for menu card titles that need parameters", () => {
    const swap = parseTelegramDirectChip("Swap via Uniswap");
    expect(swap?.type).toBe("reply");
    expect((swap as { text: string }).text).toContain("swap 1 ETH to USDC via uniswap");

    const sync = parseTelegramDirectChip("Sync NAV between two chains (amount computed automatically)");
    expect(sync?.type).toBe("reply");
    expect((sync as { text: string }).text).toContain("sync NAV between Base and Arbitrum");

    const bridge = parseTelegramDirectChip("Cross-chain transfer (you set amount)");
    expect(bridge?.type).toBe("reply");
    expect((bridge as { text: string }).text).toContain("bridge 5 USDC from Base to Arbitrum");
  });

  it("starts the trade wizard for the Trade menu card", () => {
    expect(parseTelegramDirectChip("Trade (open / close position)"))
      .toEqual({ type: "wizard", wizard: "hl_trade" });
  });

  it("returns null for unknown chips", () => {
    expect(parseTelegramDirectChip("Random chip")).toBeNull();
  });
});
