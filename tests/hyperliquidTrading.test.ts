/**
 * Hyperliquid calldata builder tests — unit conversions, CoreWriter action payload
 * layout, and vault adapter calldata. All pure functions, no network.
 */
import { describe, it, expect, vi } from "vitest";
import { decodeAbiParameters, toFunctionSelector } from "viem";
import {
  toHlPx,
  toHlSz,
  usdToPerpUnits,
  usdToCoreWei,
  encodeHlAction,
  buildHlDepositCalldata,
  buildHlDepositForCalldata,
  buildHlLimitOrderCalldata,
  buildHlSpotSendCalldata,
  buildHlUsdClassTransferCalldata,
  buildHlCancelByOidCalldata,
  buildHlCancelByCloidCalldata,
  formatHlPrice,
} from "../src/services/hyperliquidTrading.js";
import {
  RIGOBLOCK_HYPERLIQUID_ABI,
  HL_ACTIONS,
  HL_USDC_SYSTEM_ADDRESS,
  HL_USDC_TOKEN_INDEX,
  HL_DEFAULT_PERP_DEX,
} from "../src/abi/hyperliquid.js";

const SEND_RAW_ACTION_SELECTOR = toFunctionSelector("sendRawAction(bytes)");

/** Decode a vault calldata tx: function selector + raw CoreWriter payload. */
function decodeSendRawAction(calldata: `0x${string}`): { actionId: number; params: `0x${string}` } {
  expect(calldata.slice(0, 10)).toBe(SEND_RAW_ACTION_SELECTOR);
  const [payload] = decodeAbiParameters([{ type: "bytes" }], `0x${calldata.slice(10)}` as `0x${string}`);
  const bytes = payload as `0x${string}`;
  expect(parseInt(bytes.slice(2, 4), 16)).toBe(1); // version byte
  const actionId = (parseInt(bytes.slice(4, 6), 16) << 16) | (parseInt(bytes.slice(6, 8), 16) << 8) | parseInt(bytes.slice(8, 10), 16);
  return { actionId, params: `0x${bytes.slice(10)}` as `0x${string}` };
}

describe("unit conversions", () => {
  it("converts prices to 8-decimal fixed point", () => {
    expect(toHlPx("67234.5")).toBe(6723450000000n);
    expect(toHlPx(0.05234)).toBe(5234000n);
  });

  it("converts sizes to 1e8 wire fixed point, quantized to market szDecimals", () => {
    // HyperCore wire format: sz = 10^8 × human size, for EVERY market.
    // szDecimals only quantizes the size increment before scaling (truncated,
    // mirroring formatSize() in @nktkas/hyperliquid/utils).
    expect(toHlSz("0.15", 5)).toBe(15_000_000n); // BTC: 0.15 × 1e8
    expect(toHlSz("1.234", 4)).toBe(123_400_000n); // ETH: 1.234 × 1e8
    expect(toHlSz("1.23456", 4)).toBe(123_450_000n); // quantized to 4 decimals (truncated)
  });

  it("converts human USDC to 6-decimal perp units", () => {
    expect(usdToPerpUnits("250")).toBe(250_000_000n);
    expect(usdToPerpUnits("0.5")).toBe(500_000n);
  });

  it("converts human USDC to 8-decimal core wei", () => {
    expect(usdToCoreWei("250")).toBe(25_000_000_000n);
    expect(usdToCoreWei("0.1")).toBe(10_000_000n);
  });

  it("rejects non-positive and invalid values", () => {
    expect(() => toHlPx("0")).toThrow();
    expect(() => toHlPx(-5)).toThrow();
    expect(() => toHlSz("0", 5)).toThrow();
    expect(() => toHlSz("0.0000001", 5)).toThrow(); // rounds to 0
    expect(() => usdToPerpUnits("abc")).toThrow();
    expect(() => usdToCoreWei("")).toThrow();
  });
});

describe("formatHlPrice (official Hyperliquid tick rules)", () => {
  it("matches the reference examples from @nktkas/hyperliquid", () => {
    expect(formatHlPrice("97123.456789", 0)).toBe("97123"); // 5 sig figs, truncated
    expect(formatHlPrice("1.23456789", 5)).toBe("1.2"); // max 1 decimal (6−5)
    expect(formatHlPrice("1234.5", 4)).toBe("1234.5"); // valid as-is
    expect(formatHlPrice("1234.56", 4)).toBe("1234.5"); // 6 sig figs → truncated to 5
  });

  it("allows integer prices regardless of significant figures", () => {
    expect(formatHlPrice("123456", 5)).toBe("123456"); // the docs' own example
    expect(formatHlPrice("79474.0", 5)).toBe("79474"); // live BTC book format
  });

  it("preserves the high precision low-priced markets need", () => {
    expect(formatHlPrice("0.084543", 0)).toBe("0.084543"); // DOGE: 5 sig figs, 6 decimals
    expect(formatHlPrice("0.33026", 0)).toBe("0.33026"); // TRX: 5 decimals
    expect(formatHlPrice("0.001234", 0)).toBe("0.001234"); // docs example: 6 decimals ok
    expect(formatHlPrice("0.0012345", 0)).toBe("0.001234"); // 7 decimals → truncated
    expect(formatHlPrice("0.012345", 1)).toBe("0.01234"); // max 6−1=5 decimals
  });

  it("rejects prices that truncate to zero", () => {
    expect(() => formatHlPrice("0.0000001", 0)).toThrow();
    expect(() => formatHlPrice(0, 4)).toThrow();
    expect(() => formatHlPrice("abc", 4)).toThrow();
  });
});

describe("encodeHlAction", () => {
  it("builds version byte + uint24 action id + params", () => {
    const encoded = encodeHlAction(11, "0x1234");
    expect(encoded.slice(0, 10)).toBe("0x0100000b"); // version 1, action id 0x00000b
    expect(encoded.slice(10)).toBe("1234");
  });

  it("encodes multi-byte action ids big-endian", () => {
    const encoded = encodeHlAction(0x0b0000 | 7, "0x");
    expect(encoded).toBe("0x010b0007");
  });
});

describe("deposit calldata", () => {
  it("deposit(uint256,uint32) with amount in 6 decimals and perp dex 0", () => {
    const calldata = buildHlDepositCalldata("500");
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector("deposit(uint256,uint32)"));
    const [amount, dex] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint32" }],
      `0x${calldata.slice(10)}` as `0x${string}`,
    );
    expect(amount).toBe(500_000_000n);
    expect(dex).toBe(HL_DEFAULT_PERP_DEX);
  });

  it("depositFor carries the recipient", () => {
    const recipient = "0x00000000000000000000000000000000000000aa" as const;
    const calldata = buildHlDepositForCalldata(recipient, "100");
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector("depositFor(address,uint256,uint32)"));
    const [decodedRecipient, amount] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint32" }],
      `0x${calldata.slice(10)}` as `0x${string}`,
    );
    expect(decodedRecipient.toLowerCase()).toBe(recipient);
    expect(amount).toBe(100_000_000n);
  });
});

describe("sendRawAction calldata", () => {
  it("limit order wraps action 1 with all params", () => {
    const calldata = buildHlLimitOrderCalldata({
      asset: 4,
      isBuy: true,
      limitPx: 6723450000000n,
      sz: 15000n,
      reduceOnly: false,
      tif: "gtc",
      cloid: 42n,
    });
    const { actionId, params } = decodeSendRawAction(calldata);
    expect(actionId).toBe(HL_ACTIONS.limitOrder);
    const [asset, isBuy, limitPx, sz, reduceOnly, tif, cloid] = decodeAbiParameters(
      [
        { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" },
        { type: "bool" }, { type: "uint8" }, { type: "uint128" },
      ],
      params,
    );
    expect(asset).toBe(4);
    expect(isBuy).toBe(true);
    expect(limitPx).toBe(6723450000000n);
    expect(sz).toBe(15000n);
    expect(reduceOnly).toBe(false);
    expect(tif).toBe(2); // GTC
    expect(cloid).toBe(42n);
  });

  it("spot send targets the USDC system address with 8-decimal amount", () => {
    const calldata = buildHlSpotSendCalldata("250");
    const { actionId, params } = decodeSendRawAction(calldata);
    expect(actionId).toBe(HL_ACTIONS.spotSend);
    const [destination, token, amount] = decodeAbiParameters(
      [{ type: "address" }, { type: "uint64" }, { type: "uint64" }],
      params,
    );
    expect(destination.toLowerCase()).toBe(HL_USDC_SYSTEM_ADDRESS.toLowerCase());
    expect(token).toBe(HL_USDC_TOKEN_INDEX);
    expect(amount).toBe(25_000_000_000n); // 250 USDC in core wei (8 decimals)
  });

  it("usd class transfer is perp→spot only (toPerp=false)", () => {
    const calldata = buildHlUsdClassTransferCalldata("100");
    const { actionId, params } = decodeSendRawAction(calldata);
    expect(actionId).toBe(HL_ACTIONS.usdClassTransfer);
    const [ntl, toPerp] = decodeAbiParameters([{ type: "uint64" }, { type: "bool" }], params);
    expect(ntl).toBe(100_000_000n); // 6 decimals
    expect(toPerp).toBe(false);
  });

  it("cancel by oid and by cloid", () => {
    const byOid = decodeSendRawAction(buildHlCancelByOidCalldata(4, 12345678));
    expect(byOid.actionId).toBe(HL_ACTIONS.cancelOrderByOid);
    const [asset, oid] = decodeAbiParameters([{ type: "uint32" }, { type: "uint64" }], byOid.params);
    expect(asset).toBe(4);
    expect(oid).toBe(12345678n);

    const byCloid = decodeSendRawAction(buildHlCancelByCloidCalldata(4, 99n));
    expect(byCloid.actionId).toBe(HL_ACTIONS.cancelOrderByCloid);
    const [clAsset, cloid] = decodeAbiParameters([{ type: "uint32" }, { type: "uint128" }], byCloid.params);
    expect(clAsset).toBe(4);
    expect(cloid).toBe(99n);
  });

  it("adapter ABI exposes deposit, depositFor and sendRawAction", () => {
    const names = RIGOBLOCK_HYPERLIQUID_ABI.map((f) => f.name);
    expect(names).toEqual(["deposit", "depositFor", "sendRawAction"]);
  });
});


describe("handle_hyperliquid_limit_order minimum notional", () => {
  const VAULT = "0xefa4bdf566ae50537a507863612638680420645c" as const;
  const OPERATOR = "0xcA9F5049c1Ea8FC78574f94B7Cf5bE5fEE354C31" as const;

  function stubHlApi() {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { type?: string };
      if (body.type === "meta") {
        return new Response(JSON.stringify({
          universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25, onlyIsolated: false }],
        }), { status: 200 });
      }
      if (body.type === "allMids") {
        return new Response(JSON.stringify({ ETH: "2500" }), { status: 200 });
      }
      if (body.type === "l2Book") {
        return new Response(JSON.stringify({ levels: [[{ px: "2500", sz: "10" }], [{ px: "2500", sz: "10" }]] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
  }

  function stubHlApiBrokenBook() {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { type?: string };
      if (body.type === "meta") {
        return new Response(JSON.stringify({
          universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25, onlyIsolated: false }],
        }), { status: 200 });
      }
      if (body.type === "allMids") {
        return new Response(JSON.stringify({ ETH: "2500" }), { status: 200 });
      }
      return new Response("{}", { status: 200 }); // l2Book unavailable
    }));
  }

  function makeCtx() {
    return {
      vaultAddress: VAULT,
      chainId: 999,
      operatorAddress: OPERATOR,
      operatorVerified: true,
      executionMode: "manual",
    } as never;
  }

  it("rejects orders below Hyperliquid's $10 minimum with a clear error", async () => {
    stubHlApi();
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    await expect(
      handle_hyperliquid_limit_order({} as never, makeCtx(), {
        coin: "ETH", side: "buy", notionalUsd: "3",
      }, "hyperliquid_limit_order"),
    ).rejects.toThrow(/\$10 minimum order value/);
    vi.unstubAllGlobals();
  }, 30_000);

  it("accepts orders at or above $10 and reports the size rounded to szDecimals", async () => {
    stubHlApi();
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    const result = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "buy", notionalUsd: "3000",
    }, "hyperliquid_limit_order");
    // $3000 @ $2525 (mid +1%) = 1.18811881… ETH → quantized to 4 decimals = 1.1881
    expect(result.message).toContain("BUY 1.1881 ETH");
    expect(result.message).toContain("~$2,999.95");
    expect(result.transaction).toBeDefined();

    // Wire-format regression: HyperCore expects sz as 1e8 × human size —
    // NOT scaled by szDecimals (that bug produced ~0-size orders on-chain).
    const { actionId, params } = decodeSendRawAction(result.transaction!.data);
    expect(actionId).toBe(1);
    const [, , limitPx, sz] = decodeAbiParameters(
      [
        { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" },
        { type: "bool" }, { type: "uint8" }, { type: "uint128" },
      ],
      params,
    );
    expect(limitPx).toBe(252_500_000_000n); // 2525 × 1e8
    expect(sz).toBe(118_810_000n); // 1.1881 × 1e8
    vi.unstubAllGlobals();
  }, 30_000);

  it("anchors market orders to the best ask, not the mid", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { type?: string };
      if (body.type === "meta") {
        return new Response(JSON.stringify({
          universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25, onlyIsolated: false }],
        }), { status: 200 });
      }
      if (body.type === "allMids") {
        return new Response(JSON.stringify({ ETH: "2500" }), { status: 200 });
      }
      if (body.type === "l2Book") {
        // Best ask 2510 → market buy should be priced at 2510 × 1.01 = 2535.1, not mid × 1.01 = 2525
        return new Response(JSON.stringify({ levels: [[{ px: "2490", sz: "10" }], [{ px: "2510", sz: "10" }]] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    const result = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "buy", notionalUsd: "3000",
    }, "hyperliquid_limit_order");
    expect(result.message).toContain("market order ready");
    expect(result.message).toContain("Market price: $2535.1");
    const { actionId, params } = decodeSendRawAction(result.transaction!.data);
    expect(actionId).toBe(1);
    const [, , limitPx] = decodeAbiParameters(
      [
        { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" },
        { type: "bool" }, { type: "uint8" }, { type: "uint128" },
      ],
      params,
    );
    expect(limitPx).toBe(253_510_000_000n); // 2535.1 × 1e8
    vi.unstubAllGlobals();
  }, 30_000);

  it("falls back to mid ±1% when the order book is unavailable", async () => {
    stubHlApiBrokenBook();
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    const result = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "buy", notionalUsd: "3000",
    }, "hyperliquid_limit_order");
    expect(result.message).toContain("Market price: $2525");
    vi.unstubAllGlobals();
  }, 30_000);

  it("labels explicit-price orders as GTC limits with no expiry", async () => {
    stubHlApi();
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    const result = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "buy", size: "1.2", price: "2400",
    }, "hyperliquid_limit_order");
    expect(result.message).toContain("limit order ready");
    expect(result.message).toContain("Limit price: $2400");
    expect(result.message).toContain("TIF: GTC (no expiry)");
    vi.unstubAllGlobals();
  }, 30_000);

  it("rejects a market order that carries a price, and a limit order without one", async () => {
    stubHlApi();
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    await expect(
      handle_hyperliquid_limit_order({} as never, makeCtx(), {
        coin: "ETH", side: "buy", notionalUsd: "3000", orderType: "market", price: "2500",
      }, "hyperliquid_limit_order"),
    ).rejects.toThrow(/market order must not include a price/i);
    await expect(
      handle_hyperliquid_limit_order({} as never, makeCtx(), {
        coin: "ETH", side: "buy", notionalUsd: "3000", orderType: "limit",
      }, "hyperliquid_limit_order"),
    ).rejects.toThrow(/limit order requires an explicit price/i);
    vi.unstubAllGlobals();
  }, 30_000);

  it("states whether a limit rests or executes immediately, per direction", async () => {
    stubHlApi(); // book: bid 2500 / ask 2500
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    // Sell limit above the ask → rests until price rises (a short entry waiting for a rally)
    const resting = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "sell", size: "0.005", price: "2600",
    }, "hyperliquid_limit_order");
    expect(resting.message).toContain("Rests as a maker order until ETH rises to $2600");
    // Sell limit at/below the bid → executes immediately
    const immediate = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "sell", size: "0.005", price: "2400",
    }, "hyperliquid_limit_order");
    expect(immediate.message).toContain("Executes immediately");
    vi.unstubAllGlobals();
  }, 30_000);

  it("formats a 6-significant-figure limit price to a valid tick before submitting", async () => {
    stubHlApi();
    const { handle_hyperliquid_limit_order } = await import("../src/llm/handlers/hyperliquid.js");
    const result = await handle_hyperliquid_limit_order({} as never, makeCtx(), {
      coin: "ETH", side: "sell", size: "0.005", price: "2429.46",
    }, "hyperliquid_limit_order");
    // 2429.46 → 6 sig figs → truncated to 2429.4 (the valid 5-sig-fig tick)
    expect(result.message).toContain("Limit price: $2429.4");
    expect(result.message).toContain("truncated to the valid tick");
    const { actionId, params } = decodeSendRawAction(result.transaction!.data);
    expect(actionId).toBe(1);
    const [, , limitPx] = decodeAbiParameters(
      [
        { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" },
        { type: "bool" }, { type: "uint8" }, { type: "uint128" },
      ],
      params,
    );
    expect(limitPx).toBe(242_940_000_000n); // 2429.4 × 1e8
    vi.unstubAllGlobals();
  }, 30_000);

  it("lists recent fills and open orders for the vault", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { type?: string };
      if (body.type === "userFills") {
        return new Response(JSON.stringify([
          {
            coin: "ETH", side: "B", px: "2501.5", sz: "1.1881", time: 1788530000000,
            dir: "Open Long", closedPnl: "0", oid: 123, crossed: true, fee: "0.595",
          },
        ]), { status: 200 });
      }
      if (body.type === "openOrders") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));
    const { handle_hyperliquid_get_fills } = await import("../src/llm/handlers/hyperliquid.js");
    const result = await handle_hyperliquid_get_fills({} as never, makeCtx(), {}, "hyperliquid_get_fills");
    expect(result.message).toContain("BUY 1.1881 ETH @ $2,501.5");
    expect(result.message).toContain("Open Long");
    expect(result.message).toContain("Open orders: none");
    vi.unstubAllGlobals();
  }, 30_000);
});
