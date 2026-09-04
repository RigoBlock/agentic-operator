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

  it("converts sizes using market szDecimals", () => {
    expect(toHlSz("0.15", 5)).toBe(15000n); // BTC, 5 szDecimals
    expect(toHlSz("1.234", 4)).toBe(12340n); // ETH, 4 szDecimals
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
      return new Response("{}", { status: 200 });
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
    // $3000 @ $2525 (mid +1%) = 1.18811881… ETH → rounded to 4 decimals = 1.1881
    expect(result.message).toContain("BUY 1.1881 ETH");
    expect(result.message).toContain("~$3,000");
    expect(result.transaction).toBeDefined();
    vi.unstubAllGlobals();
  }, 30_000);
});
