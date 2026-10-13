/**
 * Hyperliquid trade wizard helpers — the synthesized fast-path command and the
 * confirm-step summary must stay in sync with tryFastPathHyperliquid's grammar.
 */
import { describe, it, expect } from "vitest";
import { buildHlTradeCommand, hlTradeWizardSummary } from "../src/routes/telegram.js";
import { tryFastPathHyperliquid } from "../src/llm/client.js";

describe("buildHlTradeCommand", () => {
  it("builds a market order with coin size", () => {
    expect(buildHlTradeCommand({ step: "confirm", coin: "BTC", side: "buy", size: "0.5", orderType: "market" }))
      .toBe("buy 0.5 BTC on hyperliquid");
  });

  it("builds a market order with notional USD", () => {
    expect(buildHlTradeCommand({ step: "confirm", coin: "ETH", side: "sell", notionalUsd: "3000", orderType: "market" }))
      .toBe("sell $3000 of ETH on hyperliquid");
  });

  it("builds a limit order with price", () => {
    expect(buildHlTradeCommand({ step: "confirm", coin: "BTC", side: "buy", size: "0.5", orderType: "limit", price: "67200" }))
      .toBe("buy 0.5 BTC on hyperliquid @ 67200");
  });

  it("builds a limit order with notional and price", () => {
    expect(buildHlTradeCommand({ step: "confirm", coin: "SOL", side: "sell", notionalUsd: "2500", orderType: "limit", price: "210.5" }))
      .toBe("sell $2500 of SOL on hyperliquid @ 210.5");
  });

  it("every synthesized command parses through the fast path with the same intent", () => {
    const states = [
      { step: "confirm", coin: "BTC", side: "buy", size: "0.5", orderType: "market" },
      { step: "confirm", coin: "ETH", side: "sell", notionalUsd: "3000", orderType: "market" },
      { step: "confirm", coin: "BTC", side: "buy", size: "0.5", orderType: "limit", price: "67200" },
      { step: "confirm", coin: "SOL", side: "sell", notionalUsd: "2500", orderType: "limit", price: "210.5" },
    ] as const;
    for (const s of states) {
      const parsed = tryFastPathHyperliquid(buildHlTradeCommand({ ...s, step: s.step }));
      expect(parsed?.name).toBe("hyperliquid_limit_order");
      expect(parsed?.args.coin).toBe(s.coin);
      expect(parsed?.args.side).toBe(s.side);
    }
  });
});

describe("hlTradeWizardSummary", () => {
  it("summarizes market orders", () => {
    expect(hlTradeWizardSummary({ step: "confirm", coin: "BTC", side: "buy", size: "0.5", orderType: "market" }))
      .toBe("Buy 0.5 BTC · market (IOC)");
    expect(hlTradeWizardSummary({ step: "confirm", coin: "ETH", side: "sell", notionalUsd: "3000", orderType: "market" }))
      .toBe("Sell $3,000 of ETH · market (IOC)");
  });

  it("summarizes limit orders", () => {
    expect(hlTradeWizardSummary({ step: "confirm", coin: "BTC", side: "buy", size: "0.5", orderType: "limit", price: "67200" }))
      .toBe("Buy 0.5 BTC · limit @ $67,200");
  });
});
