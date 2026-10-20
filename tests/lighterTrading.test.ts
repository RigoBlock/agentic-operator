/**
 * Lighter calldata builder tests — unit conversions, vault adapter calldata,
 * order building (scaling, market bound, GTT expiry clamp, tracked-market
 * enforcement, overflow checks). The market-order mark price read is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeAbiParameters, decodeFunctionData, toFunctionSelector, type Address } from "viem";
import {
  toLighterAmount,
  toLighterPrice,
  usdToLighterBaseUnits,
  clampLighterExpiry,
  buildLighterDepositCalldata,
  buildLighterWithdrawCalldata,
  buildLighterOrderCalldata,
  buildLighterCancelOrderCalldata,
  buildLighterCancelAllOrdersCalldata,
  buildLighterTrackMarketCalldata,
  buildLighterUntrackMarketCalldata,
  LIGHTER_MIN_EXPIRY_MS,
  LIGHTER_MAX_EXPIRY_MS,
  LIGHTER_DEFAULT_EXPIRY_MS,
} from "../src/services/lighterTrading.js";
import { RIGOBLOCK_LIGHTER_ABI, LIGHTER_USDC_ASSET_INDEX, LIGHTER_TIF, LIGHTER_ORDER_TYPES } from "../src/abi/lighter.js";
import type { TrackedMarket } from "../src/services/lighter.js";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const ETH_PERP: TrackedMarket = { marketId: 0, sizeDecimals: 3, priceDecimals: 2 };

// Mock the mark-price read used by market orders.
const mockMarketInfo = vi.hoisted(() => vi.fn());
vi.mock("../src/services/lighter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/lighter.js")>();
  return { ...actual, readLighterMarketInfo: mockMarketInfo };
});

const LIGHTER_ABI = RIGOBLOCK_LIGHTER_ABI;

function decodeVaultCall(calldata: `0x${string}`) {
  return decodeFunctionData({ abi: LIGHTER_ABI, data: calldata });
}

describe("unit conversions", () => {
  it("converts sizes to the market's sizeDecimals scale (exact integers only)", () => {
    expect(toLighterAmount("2", 3)).toBe(2000n);
    expect(toLighterAmount("0.015", 3)).toBe(15n);
    expect(toLighterAmount("1.234567", 6)).toBe(1234567n);
  });

  it("rejects sub-tick sizes, non-positive and overflowing values", () => {
    expect(() => toLighterAmount("0.0001", 3)).toThrow(/size tick/);
    expect(() => toLighterAmount("0", 3)).toThrow();
    expect(() => toLighterAmount("-1", 3)).toThrow();
    expect(() => toLighterAmount("abc", 3)).toThrow();
    expect(() => toLighterAmount("281474976710656", 0)).toThrow(/too large/); // > uint48
  });

  it("converts prices to the market's priceDecimals scale, truncating toward zero", () => {
    expect(toLighterPrice("2350", 2)).toBe(235000n);
    expect(toLighterPrice("2350.999", 2)).toBe(235099n); // truncated, never rounded up
  });

  it("rejects invalid and overflowing prices", () => {
    expect(() => toLighterPrice("0", 2)).toThrow();
    expect(() => toLighterPrice("abc", 2)).toThrow();
    expect(() => toLighterPrice("4294967296", 0)).toThrow(/too large/); // > uint32
  });

  it("converts human USDC to 6-decimal base units", () => {
    expect(usdToLighterBaseUnits("250")).toBe(250_000_000n);
    expect(usdToLighterBaseUnits("0.000001")).toBe(1n);
    expect(() => usdToLighterBaseUnits("0")).toThrow();
  });
});

describe("clampLighterExpiry", () => {
  const now = 1_800_000_000_000;

  it("clamps below the 5-minute minimum and above the 30-day maximum", () => {
    expect(clampLighterExpiry(now + 60_000, now)).toBe(now + LIGHTER_MIN_EXPIRY_MS);
    expect(clampLighterExpiry(now + 40 * 24 * 60 * 60 * 1000, now)).toBe(now + LIGHTER_MAX_EXPIRY_MS);
  });

  it("passes values inside the window through", () => {
    expect(clampLighterExpiry(now + LIGHTER_DEFAULT_EXPIRY_MS, now)).toBe(now + LIGHTER_DEFAULT_EXPIRY_MS);
  });
});

describe("deposit / withdraw calldata", () => {
  it("sendToCore carries assetIndex 3, the vault recipient and a 6-dec amount", () => {
    const calldata = buildLighterDepositCalldata(VAULT, "500");
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector("sendToCore(uint32,address,bool,uint256,uint8)"));
    const decoded = decodeVaultCall(calldata);
    expect(decoded.functionName).toBe("sendToCore");
    expect(decoded.args).toEqual([LIGHTER_USDC_ASSET_INDEX, VAULT, false, 500_000_000n, 0]);
  });

  it("sendToEvm uses 6-dec baseAmount (tickSize 1) and accountIndex 0", () => {
    const calldata = buildLighterWithdrawCalldata(VAULT, "250.5");
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector("sendToEvm(uint48,uint32,address,uint8,uint64)"));
    const decoded = decodeVaultCall(calldata);
    expect(decoded.functionName).toBe("sendToEvm");
    const [accountIndex, assetIndex, to, routeType, baseAmount] = decoded.args as [number, number, Address, number, bigint];
    expect(accountIndex).toBe(0);
    expect(assetIndex).toBe(LIGHTER_USDC_ASSET_INDEX);
    expect(to).toBe(VAULT);
    expect(routeType).toBe(0);
    expect(baseAmount).toBe(250_500_000n); // 6 decimals, NOT 8
  });

  it("rejects non-positive amounts", () => {
    expect(() => buildLighterDepositCalldata(VAULT, "0")).toThrow();
    expect(() => buildLighterWithdrawCalldata(VAULT, "abc")).toThrow();
  });
});

describe("createOrder calldata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a GTT limit order with a 24h default expiry and a clientOrderIndex", async () => {
    const before = Date.now();
    const built = await buildLighterOrderCalldata({
      chainId: 19529,
      vault: VAULT,
      marketId: 0,
      side: "buy",
      sizeHuman: "2",
      priceHuman: "2350",
      isMarket: false,
      trackedMarkets: [ETH_PERP],
    });
    const after = Date.now();

    expect(built.orderType).toBe(LIGHTER_ORDER_TYPES.limit);
    expect(built.tifCode).toBe(LIGHTER_TIF.gtt);
    expect(built.amount).toBe(2000n);
    expect(built.price).toBe(235000n);
    expect(built.isAsk).toBe(false);
    expect(built.reduceOnly).toBe(false);
    expect(built.expiry >= BigInt(before + LIGHTER_DEFAULT_EXPIRY_MS)).toBe(true);
    expect(built.expiry <= BigInt(after + LIGHTER_DEFAULT_EXPIRY_MS)).toBe(true);
    expect(built.clientOrderIndex).toBeLessThan(1n << 48n);

    const decoded = decodeVaultCall(built.calldata);
    expect(decoded.functionName).toBe("createOrder");
    const [accountIndex, marketIndex, clientOrderIndex, orderType, tif, expiry, amount, price, isAsk, reduceOnly, triggerPrice] =
      decoded.args as unknown as [number, number, number, number, number, bigint, number, number, boolean, boolean, number];
    expect(accountIndex).toBe(0); // ignored by the adapter
    expect(marketIndex).toBe(0);
    expect(BigInt(clientOrderIndex)).toBe(built.clientOrderIndex);
    expect(orderType).toBe(0);
    expect(tif).toBe(1); // GTT
    expect(expiry).toBe(built.expiry);
    expect(amount).toBe(2000);
    expect(price).toBe(235000);
    expect(isAsk).toBe(false);
    expect(reduceOnly).toBe(false);
    expect(triggerPrice).toBe(0);
  });

  it("clamps an explicit GTT expiry into the 5min…30d window", async () => {
    const now = Date.now();
    const built = await buildLighterOrderCalldata({
      chainId: 19529,
      vault: VAULT,
      marketId: 0,
      side: "buy",
      sizeHuman: "2",
      priceHuman: "2350",
      isMarket: false,
      expiryMs: now + 60_000, // 1 minute — below the 5-minute floor
      trackedMarkets: [ETH_PERP],
    });
    expect(built.expiry >= BigInt(now + LIGHTER_MIN_EXPIRY_MS)).toBe(true);
    expect(built.expiry <= BigInt(now + LIGHTER_MIN_EXPIRY_MS + 2000)).toBe(true);
  });

  it("supports postOnly with an expiry and reduceOnly", async () => {
    const built = await buildLighterOrderCalldata({
      chainId: 19529,
      vault: VAULT,
      marketId: 0,
      side: "sell",
      sizeHuman: "1",
      priceHuman: "2400",
      isMarket: false,
      tif: "postOnly",
      reduceOnly: true,
      trackedMarkets: [ETH_PERP],
    });
    expect(built.tifCode).toBe(LIGHTER_TIF.postOnly);
    expect(built.isAsk).toBe(true);
    expect(built.reduceOnly).toBe(true);
    expect(built.expiry > 0n).toBe(true);
  });

  it("market order: IOC forced, no expiry, price = mark ±1% rounded to an integer tick", async () => {
    mockMarketInfo.mockResolvedValue({
      marketType: 0, baseAssetId: 0, quoteAssetId: 0, takerFee: 0, makerFee: 0,
      minBaseAmount: 0n, minQuoteAmount: 0n, liquidationFee: 0, indexPrice: 100000n, markPrice: 100000n,
    });
    const buy = await buildLighterOrderCalldata({
      chainId: 19529, vault: VAULT, marketId: 0, side: "buy", sizeHuman: "2", isMarket: true,
      trackedMarkets: [ETH_PERP],
    });
    expect(buy.orderType).toBe(LIGHTER_ORDER_TYPES.market);
    expect(buy.tifCode).toBe(LIGHTER_TIF.ioc);
    expect(buy.expiry).toBe(0n);
    expect(buy.price).toBe(101000n); // 100000 × 1.01

    // Sell bound rounds UP when the 0.99 product is not an integer (conservative for a seller).
    mockMarketInfo.mockResolvedValue({
      marketType: 0, baseAssetId: 0, quoteAssetId: 0, takerFee: 0, makerFee: 0,
      minBaseAmount: 0n, minQuoteAmount: 0n, liquidationFee: 0, indexPrice: 99999n, markPrice: 99999n,
    });
    const sell = await buildLighterOrderCalldata({
      chainId: 19529, vault: VAULT, marketId: 0, side: "sell", sizeHuman: "2", isMarket: true,
      trackedMarkets: [ETH_PERP],
    });
    // 99999 × 0.99 = 98999.01 → rounds up to 99000, never down to 98999
    expect(sell.price).toBe(99000n);
    expect(sell.isAsk).toBe(true);
  });

  it("rejects a market order when no mark price is available", async () => {
    mockMarketInfo.mockResolvedValue(null);
    await expect(
      buildLighterOrderCalldata({
        chainId: 19529, vault: VAULT, marketId: 0, side: "buy", sizeHuman: "2", isMarket: true,
        trackedMarkets: [ETH_PERP],
      }),
    ).rejects.toThrow(/No live mark price/);
  });

  it("rejects an untracked market with a pointer to lighter_track_market", async () => {
    await expect(
      buildLighterOrderCalldata({
        chainId: 19529, vault: VAULT, marketId: 7, side: "buy", sizeHuman: "2", priceHuman: "2350",
        isMarket: false, trackedMarkets: [ETH_PERP],
      }),
    ).rejects.toThrow(/not tracked by this pool.*lighter_track_market/s);
  });

  it("rejects spot-range market ids and invalid tif", async () => {
    await expect(
      buildLighterOrderCalldata({
        chainId: 19529, vault: VAULT, marketId: 2048, side: "buy", sizeHuman: "2", priceHuman: "1",
        isMarket: false, trackedMarkets: [{ marketId: 2048, sizeDecimals: 3, priceDecimals: 2 }],
      }),
    ).rejects.toThrow(/not a perp market|0 … 2047/);
    await expect(
      buildLighterOrderCalldata({
        chainId: 19529, vault: VAULT, marketId: 0, side: "buy", sizeHuman: "2", priceHuman: "2350",
        isMarket: false, tif: "gtc" as never, trackedMarkets: [ETH_PERP],
      }),
    ).rejects.toThrow(/time-in-force/);
  });
});

describe("cancel / track / untrack calldata", () => {
  it("cancelOrder carries the order index and ignores accountIndex", () => {
    const calldata = buildLighterCancelOrderCalldata("12345");
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector("cancelOrder(uint48,uint64)"));
    expect(decodeVaultCall(calldata).args).toEqual([0, 12345n]);
    const hex = buildLighterCancelOrderCalldata("0x2a");
    expect(decodeVaultCall(hex).args).toEqual([0, 42n]);
  });

  it("cancelAllOrders zeroes accountIndex", () => {
    const calldata = buildLighterCancelAllOrdersCalldata();
    expect(calldata.slice(0, 10)).toBe(toFunctionSelector("cancelAllOrders(uint48)"));
    expect(decodeVaultCall(calldata).args).toEqual([0]);
  });

  it("trackMarket validates decimals bounds and the perp id range", () => {
    const ok = buildLighterTrackMarketCalldata(0, 3, 2);
    expect(ok.slice(0, 10)).toBe(toFunctionSelector("trackMarket(uint16,uint8,uint8)"));
    expect(decodeVaultCall(ok).args).toEqual([0, 3, 2]);
    expect(() => buildLighterTrackMarketCalldata(0, 19, 2)).toThrow(/sizeDecimals/);
    expect(() => buildLighterTrackMarketCalldata(0, 3, 17)).toThrow(/priceDecimals/);
    expect(() => buildLighterTrackMarketCalldata(2048, 3, 2)).toThrow(/0 … 2047/);
    expect(() => buildLighterUntrackMarketCalldata(2048)).toThrow(/0 … 2047/);
  });
});
