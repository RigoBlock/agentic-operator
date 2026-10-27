/**
 * Lighter integration tests — READ_CORE encoding/decoding, portfolio valuation,
 * activation caching, the on-chain tracked-markets view, NAV guard
 * classification on chain 19529, error decoding, tool registration/catalog/
 * menu shape, chain gating, and the deterministic fast paths. The RPC provider
 * is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";

// ── Hoisted RPC mock (must precede the imports that use getRpcProvider) ──
const mockState = vi.hoisted(() => {
  const call = vi.fn();
  const readContract = vi.fn(
    async (_args: { functionName: string }): Promise<bigint | `0x${string}`> => 1n,
  );
  const getRpcProvider = vi.fn(() => ({ call, readContract } as any));
  return { call, readContract, getRpcProvider };
});

vi.mock("../src/services/rpcClient.js", () => ({
  getRpcProvider: mockState.getRpcProvider,
}));

import {
  readLighterAccount,
  readLighterMarketInfo,
  readLighterPosition,
  readLighterTxStatus,
  getLighterAccountIndex,
  getLighterAccountActivation,
  getLighterPortfolio,
  readLighterTrackedMarkets,
  getLighterTrackedMarkets,
  type TrackedMarket,
} from "../src/services/lighter.js";
import { checkNavImpact } from "../src/services/navGuard.js";
import { decodeRevertData } from "../src/services/errorDecoder.js";
import { LIGHTER_VIEW_DATA_OUT } from "../src/abi/lighter.js";
import { resolveLighterMarketId } from "../src/llm/handlers/lighter.js";
import { TOOL_DEFINITIONS } from "../src/llm/tools.js";
import { TOOL_HANDLER_REGISTRY } from "../src/llm/handlers/index.js";
import { handle_get_tool_menu } from "../src/llm/handlers/menu.js";
import { tryFastPathLighter } from "../src/llm/client.js";
import { RIGOBLOCK_VAULT_ABI, ALLOWED_VAULT_SELECTORS } from "../src/abi/rigoblockVault.js";
import type { Env } from "../src/types.js";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const OWNER = "0x2222222222222222222222222222222222222222" as Address;
const CHAIN = 19529;
const OTHER_CHAIN = 8453;

const ACCOUNT_OUT = [
  { type: "uint8" }, { type: "uint48" }, { type: "uint48" },
  { type: "address" }, { type: "address" }, { type: "int128" },
] as const;

const MARKET_OUT = [
  { type: "uint8" }, { type: "uint32" }, { type: "uint32" },
  { type: "uint32" }, { type: "uint32" }, { type: "uint64" },
  { type: "uint64" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" },
] as const;

// Devnet 1.1.0 (post-reset, verified 2026-10-27): 7 words WITHOUT the dropped
// lastFundingRatePrefixSum; allocatedMargin is 6-dec USDC (was 12-dec).
const POSITION_OUT = [
  { type: "int64" }, { type: "uint56" }, { type: "uint16" },
  { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "int128" },
] as const;

/** Devnet 1.1.0 envelope for every READ_CORE query except tx status. */
function wrapFound(data: Hex): Hex {
  return encodeAbiParameters([{ type: "bool" }, { type: "bytes" }], [true, data]);
}

/** found=false envelope — the "entity does not exist" signal (a SUCCESS). */
function wrapNotFound(): Hex {
  return encodeAbiParameters([{ type: "bool" }, { type: "bytes" }], [false, "0x"]);
}

function encodeAccount(collateral6dec: bigint): Hex {
  return wrapFound(encodeAbiParameters([...ACCOUNT_OUT], [0, 7, 7, OWNER, VAULT, collateral6dec]) as Hex);
}

function encodeMarket(markPrice: bigint): Hex {
  return wrapFound(encodeAbiParameters([...MARKET_OUT], [0, 0, 0, 10, 5, 1000n, 5000n, 50, markPrice + 100n, markPrice]) as Hex);
}

function encodePosition(fields: {
  position: bigint;
  entryQuote: bigint;
  marginMode?: number;
  allocatedMargin?: bigint;
  totalOrderCount?: bigint;
  totalPositionTiedOrderCount?: bigint;
}): Hex {
  return wrapFound(encodeAbiParameters([...POSITION_OUT], [
    fields.position, fields.entryQuote, 100,
    fields.totalOrderCount ?? 3n, fields.totalPositionTiedOrderCount ?? 1n,
    fields.marginMode ?? 0, fields.allocatedMargin ?? 0n,
  ]) as Hex);
}

/** Route eth_calls by READ_CORE query prefix. */
function setupReadCore(handlers: {
  account?: () => Hex;
  market?: (marketId: number) => Hex;
  position?: (marketId: number) => Hex;
  txStatus?: () => Hex;
  accountIndex?: () => Hex;
}) {
  mockState.call.mockImplementation(async (args: { data: Hex }) => {
    const data = args.data;
    const query = data.slice(0, 6);
    if (query === "0x0001" && handlers.account) return { data: handlers.account() };
    if (query === "0x0005" && handlers.market) return { data: handlers.market(parseInt(data.slice(6, 10), 16)) };
    if (query === "0x0007" && handlers.position) {
      return { data: handlers.position(parseInt(data.slice(46, 50), 16)) };
    }
    if (query === "0x0000" && handlers.txStatus) return { data: handlers.txStatus() };
    if (query === "0x0009" && handlers.accountIndex) return { data: handlers.accountIndex() };
    throw new Error(`unexpected eth_call data: ${data.slice(0, 10)}`);
  });
}

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.call.mockReset();
});

// ── READ_CORE encoding / decoding ─────────────────────────────────────

describe("READ_CORE client", () => {
  it("account info: packed input (uint16 + address + bool = 23 bytes), raw 6-word decode", async () => {
    setupReadCore({ account: () => encodeAccount(1_000_000_000n) });
    const info = await readLighterAccount(CHAIN, VAULT);
    expect(info).not.toBeNull();
    expect(info!.collateralBaseAmount).toBe(1_000_000_000n);
    expect(info!.evmAddress).toBe(VAULT);
    expect(info!.accountIndex).toBe(7n);

    const data = mockState.call.mock.calls[0][0] as { to: string; data: Hex; blockTag?: string };
    expect(data.to.toLowerCase()).toBe("0x6600000000000000000000000000000000000000");
    expect(data.data).toBe(`0x0001${VAULT.slice(2).toLowerCase()}00`);
    expect((data.data.length - 2) / 2).toBe(23);
    expect(data.blockTag).toBe("latest");
  });

  it("account info: found=false (missing account) decodes to null", async () => {
    setupReadCore({ account: () => wrapNotFound() });
    expect(await readLighterAccount(CHAIN, VAULT)).toBeNull();
  });

  it("account info: a READ_CORE failure (legacy missing-account error) decodes to null", async () => {
    mockState.call.mockRejectedValue(new Error("READ_CORE query failed: account not found"));
    expect(await readLighterAccount(CHAIN, VAULT)).toBeNull();
  });

  it("market info: packed input (4 bytes), raw 10-word decode with mark price", async () => {
    setupReadCore({ market: () => encodeMarket(235000n) });
    const info = await readLighterMarketInfo(CHAIN, 3);
    expect(info).not.toBeNull();
    expect(info!.marketType).toBe(0);
    expect(info!.markPrice).toBe(235000n);
    expect(info!.indexPrice).toBe(235100n);
    const data = mockState.call.mock.calls[0][0] as { data: Hex };
    expect(data.data).toBe("0x00050003");
  });

  it("market info: failure decodes to null", async () => {
    mockState.call.mockRejectedValue(new Error("READ_CORE query failed"));
    expect(await readLighterMarketInfo(CHAIN, 0)).toBeNull();
  });

  it("position: packed input (25 bytes), 7-word decode WITHOUT the dropped funding field", async () => {
    setupReadCore({ position: () => encodePosition({ position: -2000n, entryQuote: 4_600_000_000n }) });
    const pos = await readLighterPosition(CHAIN, VAULT, 2);
    expect(pos).not.toBeNull();
    expect(pos!.position).toBe(-2000n);
    expect(pos!.entryQuote).toBe(4_600_000_000n);
    expect(pos!.marginMode).toBe(0);
    // Count fields in docs order: word3 = open, word4 = tied (SL/TP).
    expect(pos!.totalOrderCount).toBe(3n);
    expect(pos!.totalPositionTiedOrderCount).toBe(1n);
    const data = mockState.call.mock.calls[0][0] as { data: Hex };
    expect(data.data).toBe(`0x0007${VAULT.slice(2).toLowerCase()}000002`);
    expect((data.data.length - 2) / 2).toBe(25);
  });

  it("position: found=false (no position) decodes to null", async () => {
    setupReadCore({ position: () => wrapNotFound() });
    expect(await readLighterPosition(CHAIN, VAULT, 0)).toBeNull();
  });

  it("position: a legacy funding word in first slot must not leak into position/entryQuote (1.0.0 regression — the 787299804 funding word read as a LONG 78729.9804 position)", async () => {
    // Devnet 1.1.0 dropped the field entirely: the tuple now starts with the
    // signed size, so a 1.0.0-shaped payload is rejected by the decoder
    // (found-byte misread → decode failure → null) instead of misreading.
    const legacy8Word = encodeAbiParameters(
      [
        { type: "int64" }, { type: "int64" }, { type: "uint56" }, { type: "uint16" },
        { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "int128" },
      ],
      [787_299_804n, -80n, 20_000_000n, 100, 1n, 0n, 0, 0n],
    ) as Hex;
    setupReadCore({ position: () => wrapFound(legacy8Word) });
    const pos = await readLighterPosition(CHAIN, VAULT, 0);
    expect(pos).toBeNull();
  });

  it("tx status: the ONE query with the (uint8, bytes) envelope, failed carries the error code", async () => {
    setupReadCore({
      txStatus: () => encodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes" }],
        [2, encodeAbiParameters([{ type: "uint32" }], [6506])],
      ),
    });
    const failed = await readLighterTxStatus(CHAIN, 42n);
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe(2);
    expect(failed!.errorCode).toBe(6506);
    const data = mockState.call.mock.calls[0][0] as { data: Hex };
    expect(data.data).toBe(`0x0000${(42n).toString(16).padStart(16, "0")}`);

    setupReadCore({
      txStatus: () => encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [0, "0x"]),
    });
    const pending = await readLighterTxStatus(CHAIN, 42n);
    expect(pending!.status).toBe(0);
    expect(pending!.errorCode).toBeUndefined();
  });

  it("evm account index: raw uint48 decode; failure (account absent) is null", async () => {
    setupReadCore({ accountIndex: () => wrapFound(encodeAbiParameters([{ type: "uint48" }], [7]) as Hex) });
    expect(await getLighterAccountIndex(CHAIN, VAULT)).toBe(7n);
    mockState.call.mockRejectedValue(new Error("READ_CORE query failed"));
    expect(await getLighterAccountIndex(CHAIN, VAULT)).toBeNull();
  });

  it("chain gating: reads on any chain other than 19529 return null without an RPC call", async () => {
    expect(await readLighterMarketInfo(OTHER_CHAIN, 0)).toBeNull();
    expect(await readLighterAccount(OTHER_CHAIN, VAULT)).toBeNull();
    expect(await readLighterPosition(OTHER_CHAIN, VAULT, 0)).toBeNull();
    expect(await readLighterTxStatus(OTHER_CHAIN, 1n)).toBeNull();
    expect(await getLighterAccountIndex(OTHER_CHAIN, VAULT)).toBeNull();
    expect(mockState.call).not.toHaveBeenCalled();
  });
});

// ── Account activation (hard gate for Core writes, prompt-only for reads) ──

describe("Core account activation", () => {
  it("true on a successful read, cached for 5 minutes", async () => {
    const vault = "0x3333333333333333333333333333333333333333" as Address;
    setupReadCore({ account: () => encodeAccount(0n) });
    expect(await getLighterAccountActivation(CHAIN, vault)).toBe(true);
    expect(await getLighterAccountActivation(CHAIN, vault)).toBe(true);
    expect(mockState.call).toHaveBeenCalledTimes(1);
  });

  it("false when READ_CORE returns found=false (Devnet 1.1.0 missing-account signal)", async () => {
    const vault = "0x4444444444444444444444444444444444444444" as Address;
    setupReadCore({ account: () => wrapNotFound() });
    expect(await getLighterAccountActivation(CHAIN, vault)).toBe(false);
  });

  it("false when READ_CORE errors with the legacy missing-account message", async () => {
    const vault = "0x4444444444444444444444444444444444444444" as Address;
    mockState.call.mockRejectedValue(new Error('execution reverted (unknown error: {"code":-32003,"message":"READ_CORE query failed"})'));
    expect(await getLighterAccountActivation(CHAIN, vault)).toBe(false);
  });

  it("null on a transport failure — never prompt, never block", async () => {
    const vault = "0x5555555555555555555555555555555555555555" as Address;
    mockState.call.mockRejectedValue(new Error("fetch failed"));
    expect(await getLighterAccountActivation(CHAIN, vault)).toBeNull();
  });
});

// ── Portfolio valuation (LighterLib._positionValueUsdc math) ──────────

describe("portfolio valuation", () => {
  const tracked: TrackedMarket[] = [{ marketId: 0, sizeDecimals: 3, priceDecimals: 2 }];
  // markPrice 235000 (priceDecimals 2 → $2350); sizeDecimals 3 → amount 2000 = 2.0 base.

  it("long: collateral + (markValue − entryQuote)", async () => {
    setupReadCore({
      account: () => encodeAccount(1_000_000_000n),
      market: () => encodeMarket(235000n),
      position: () => encodePosition({ position: 2000n, entryQuote: 4_600_000_000n }),
    });
    const p = await getLighterPortfolio(CHAIN, VAULT, tracked);
    expect(p.accountExists).toBe(true);
    expect(p.collateralBase).toBe(1_000_000_000n);
    // markValue = 2000 × 235000 × 1e6 / 10^5 = 4_700_000_000; pnl = 4.7e9 − 4.6e9 = +$100
    expect(p.positions[0].value).toBe(100_000_000n);
    expect(p.positions[0].pnl).toBe(100_000_000n);
    expect(p.totalValue).toBe(1_100_000_000n);
  });

  it("short: entryQuote enters NEGATIVE", async () => {
    setupReadCore({
      account: () => encodeAccount(1_000_000_000n),
      market: () => encodeMarket(235000n),
      position: () => encodePosition({ position: -2000n, entryQuote: 4_600_000_000n }),
    });
    const p = await getLighterPortfolio(CHAIN, VAULT, tracked);
    // markValue = −4_700_000_000; entry = −4.6e9; value = −4.7e9 − (−4.6e9) = −$100
    expect(p.positions[0].value).toBe(-100_000_000n);
    expect(p.positions[0].pnl).toBe(-100_000_000n);
    expect(p.totalValue).toBe(900_000_000n);
  });

  it("isolated positions add allocatedMargin (6-dec USDC since Devnet 1.1.0)", async () => {
    setupReadCore({
      account: () => encodeAccount(1_000_000_000n),
      market: () => encodeMarket(235000n),
      position: () => encodePosition({
        position: 2000n, entryQuote: 4_600_000_000n,
        marginMode: 1, allocatedMargin: 500_000_000n, // 500 USDC at 1e6
      }),
    });
    const p = await getLighterPortfolio(CHAIN, VAULT, tracked);
    expect(p.positions[0].pnl).toBe(100_000_000n); // uPnL column shows the raw PnL…
    expect(p.positions[0].value).toBe(100_000_000n + 500_000_000n); // …NAV adds iso margin back
    expect(p.totalValue).toBe(1_600_000_000n);
  });

  it("report shows Entry and Mark price columns derived from Core state", async () => {
    setupReadCore({
      account: () => encodeAccount(1_000_000_000n),
      market: () => encodeMarket(235000n),
      position: () => encodePosition({ position: 2000n, entryQuote: 4_600_000_000n }),
    });
    const p = await getLighterPortfolio(CHAIN, VAULT, tracked);
    // sizeDecimals 3, priceDecimals 2: size 2000 = 2.0, mark 235000 = $2350,
    // entry notional $4600 on 2.0 → entry price $2300.
    expect(p.formattedReport).toContain("| Entry | Mark |");
    // uPnL is the mark-vs-entry PnL; Margin is a dash for cross margin.
    expect(p.formattedReport).toContain("| 2300 | 2350 | +$100.00 | — |");
  });

  it("degrades gracefully: no account → zero collateral, failed reads are skipped", async () => {
    mockState.call.mockRejectedValue(new Error("READ_CORE query failed"));
    const p = await getLighterPortfolio(CHAIN, VAULT, tracked);
    expect(p.accountExists).toBe(false);
    expect(p.positions).toEqual([]);
    expect(p.totalValue).toBe(0n);
  });
});

// ── Tracked-markets on-chain view (getLighterTrackedMarkets, 0x5239dd83) ──

describe("tracked-markets on-chain view", () => {
  function encodeTrackedView(
    marketIds: number[],
    sizeDecimals: number[],
    priceDecimals: number[],
  ): Hex {
    return encodeAbiParameters([...LIGHTER_VIEW_DATA_OUT], [
      {
        marketIds,
        sizeDecimals,
        priceDecimals,
        inFlightAmount: 10_000_000n,
        lastActionTimestamp: 1_792_495_941n,
        lastReqId: 6067n,
      },
    ]);
  }

  it("decodes markets with the adapter's decimals plus the NAV meta fields", async () => {
    mockState.call.mockImplementation(async (args: { to: string; data: Hex }) => {
      expect(args.data).toBe("0x5239dd83");
      return { data: encodeTrackedView([0, 1], [4, 5], [2, 1]) };
    });
    const view = await readLighterTrackedMarkets(CHAIN, VAULT);
    expect(view).not.toBeNull();
    expect(view!.markets).toEqual([
      { marketId: 0, sizeDecimals: 4, priceDecimals: 2 },
      { marketId: 1, sizeDecimals: 5, priceDecimals: 1 },
    ]);
    expect(view!.inFlightAmount).toBe(10_000_000n);
    expect(view!.lastReqId).toBe(6067n);
    const call = mockState.call.mock.calls[0][0] as { to: string; blockTag?: string };
    expect(call.to.toLowerCase()).toBe(VAULT.toLowerCase());
    expect(call.blockTag).toBe("latest");

    expect(await getLighterTrackedMarkets(CHAIN, VAULT)).toEqual(view!.markets);
  });

  it("read failure, empty payload, or malformed shape → null view, [] markets", async () => {
    mockState.call.mockResolvedValue({ data: "0x" });
    expect(await readLighterTrackedMarkets(CHAIN, VAULT)).toBeNull();
    expect(await getLighterTrackedMarkets(CHAIN, VAULT)).toEqual([]);

    mockState.call.mockRejectedValue(new Error("execution reverted"));
    expect(await readLighterTrackedMarkets(CHAIN, VAULT)).toBeNull();
    expect(await getLighterTrackedMarkets(CHAIN, VAULT)).toEqual([]);

    // Dynamic-array lengths disagreeing with the element count must not throw.
    mockState.call.mockResolvedValue({ data: encodeAbiParameters([{ type: "uint256" }], [1n]) });
    expect(await readLighterTrackedMarkets(CHAIN, VAULT)).toBeNull();
  });

  it("chain gating: reads on any chain other than 19529 return null/[] without an RPC call", async () => {
    expect(await readLighterTrackedMarkets(OTHER_CHAIN, VAULT)).toBeNull();
    expect(await getLighterTrackedMarkets(OTHER_CHAIN, VAULT)).toEqual([]);
    expect(mockState.call).not.toHaveBeenCalled();
  });
});

// ── NAV guard classification on chain 19529 ───────────────────────────

describe("NAV guard — Lighter Devnet interactions", () => {
  const UPDATE_SELECTOR = encodeFunctionData({
    abi: RIGOBLOCK_VAULT_ABI,
    functionName: "updateUnitaryValue",
  }).slice(0, 10);
  const MULTICALL_SELECTOR = "0xac9650d8" as Hex;

  function encodeNavReturn(unitaryValue: bigint): Hex {
    return encodeFunctionResult({
      abi: RIGOBLOCK_VAULT_ABI,
      functionName: "updateUnitaryValue",
      result: [unitaryValue, unitaryValue * 1000n, 0n] as any,
    });
  }

  function setupNavClient(preUnitaryValue: bigint, postUnitaryValue: bigint) {
    mockState.readContract.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "owner" ? OWNER : 1n,
    );
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(preUnitaryValue) };
      if (selector === MULTICALL_SELECTOR) {
        return {
          data: encodeFunctionResult({
            abi: RIGOBLOCK_VAULT_ABI,
            functionName: "multicall",
            result: ["0x", encodeNavReturn(postUnitaryValue)] as any,
          }),
        };
      }
      throw new Error(`unexpected eth_call data: ${selector}`);
    });
  }

  const SEND_TO_CORE_DATA = (ALLOWED_VAULT_SELECTORS.lighterSendToCore + "00".repeat(36)) as Hex;
  const SEND_TO_EVM_DATA = (ALLOWED_VAULT_SELECTORS.lighterSendToEvm + "00".repeat(36)) as Hex;
  const CREATE_ORDER_DATA = (ALLOWED_VAULT_SELECTORS.lighterCreateOrder + "00".repeat(100)) as Hex;

  it("sendToCore (deposit) on 19529 is NAV-neutral: raw-tx simulation, no multicall", async () => {
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(10000n) };
      if (selector === ALLOWED_VAULT_SELECTORS.lighterSendToCore.toLowerCase()) return { data: "0x" };
      throw new Error(`unexpected eth_call data: ${selector}`);
    });

    const result = await checkNavImpact(VAULT, SEND_TO_CORE_DATA, 0n, CHAIN, OWNER, createMockKV());

    expect(result.allowed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.code).toBe("NAV_NEUTRAL");
    const calledSelectors = mockState.call.mock.calls.map(
      (c) => (c[0] as { data: Hex }).data.slice(0, 10),
    );
    expect(calledSelectors).not.toContain(MULTICALL_SELECTOR);
    expect(calledSelectors).toContain(ALLOWED_VAULT_SELECTORS.lighterSendToCore.toLowerCase());
  });

  it("sendToEvm (withdrawal) on 19529 takes the same raw-tx path", async () => {
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      const selector = args.data.slice(0, 10);
      if (selector === UPDATE_SELECTOR) return { data: encodeNavReturn(10000n) };
      if (selector === ALLOWED_VAULT_SELECTORS.lighterSendToEvm.toLowerCase()) return { data: "0x" };
      throw new Error(`unexpected eth_call data: ${selector}`);
    });

    const result = await checkNavImpact(VAULT, SEND_TO_EVM_DATA, 0n, CHAIN, OWNER, createMockKV());

    expect(result.allowed).toBe(true);
    expect(result.code).toBe("NAV_NEUTRAL");
  });

  it("createOrder on 19529 keeps the FULL multicall shield — trading is never exempt", async () => {
    // 11% NAV drop → BLOCKED via the multicall kill-switch even though the
    // order settles async on Core and is invisible to the simulation.
    setupNavClient(10000n, 8900n);

    const result = await checkNavImpact(VAULT, CREATE_ORDER_DATA, 0n, CHAIN, OWNER, createMockKV());

    expect(result.allowed).toBe(false);
    expect(result.code).toBe("BLOCKED");
    expect(result.verified).toBe(true);
    const calledSelectors = mockState.call.mock.calls.map(
      (c) => (c[0] as { data: Hex }).data.slice(0, 10),
    );
    expect(calledSelectors).toContain(MULTICALL_SELECTOR);
  });

  it("a Lighter selector on another chain uses the normal multicall path", async () => {
    setupNavClient(10000n, 9900n);
    const result = await checkNavImpact(VAULT, SEND_TO_CORE_DATA, 0n, OTHER_CHAIN, OWNER, createMockKV());
    expect(result.verified).toBe(true);
    expect(result.code).toBeUndefined();
  });
});

// ── Error decoding ────────────────────────────────────────────────────

describe("errorDecoder — ALighter errors", () => {
  it("maps every LIGHTER_ERROR_SELECTORS entry to a user-facing label", () => {
    const expectations: Record<string, RegExp> = {
      "0x207719d0": /settlement window/,
      "0x0db95510": /size\/price decimals/i,
      "0x6a409768": /already tracked/i,
      "0xfacd8cec": /not tracked/i,
      "0xb741d9ce": /32/i,
      "0x9db8d5b1": /perp/i,
      "0x73861efb": /state read failed/i,
      "0x8b22d48e": /position/i,
      "0x125d8e21": /lighter_deposit/,
    };
    for (const [selector, pattern] of Object.entries(expectations)) {
      const decoded = decodeRevertData(selector);
      expect(decoded, selector).not.toBeNull();
      expect(decoded!, selector).toMatch(pattern);
    }
  });
});

// ── Tool registration / catalog / menu / chain gating ─────────────────

const LIGHTER_TOOLS = [
  "lighter_get_markets",
  "lighter_get_positions",
  "lighter_get_orders",
  "lighter_deposit",
  "lighter_withdraw",
  "lighter_limit_order",
  "lighter_market_order",
  "lighter_cancel_order",
  "lighter_cancel_all_orders",
  "lighter_get_request_status",
];

describe("tool registration and catalog", () => {
  it("defines and dispatches every lighter_* tool", () => {
    const defined = TOOL_DEFINITIONS.map((t) => t.function.name);
    for (const name of LIGHTER_TOOLS) {
      expect(defined, name).toContain(name);
      expect(TOOL_HANDLER_REGISTRY[name], name).toBeTypeOf("function");
    }
  });

  it("the lighter menu lists every tool with a note about async Core writes", async () => {
    const result = await handle_get_tool_menu(
      { KV: createMockKV() } as unknown as Env,
      { chainId: CHAIN } as never,
      { category: "lighter" },
      "get_tool_menu",
    );
    const cards = (result.metadata as { toolCards: { toolName: string }[] }).toolCards;
    expect(cards.map((c) => c.toolName).sort()).toEqual([...LIGHTER_TOOLS].sort());
    expect(result.message).toMatch(/19529/);
    expect(result.message).toMatch(/asynchronous/i);
    expect(result.message).toMatch(/tracked automatically/i);
  });

  it("fast paths route unambiguous lighter phrases without the LLM", () => {
    expect(tryFastPathLighter("what are my lighter positions")).toEqual({
      name: "lighter_get_positions", args: {},
    });
    expect(tryFastPathLighter("show my lighter open orders")).toEqual({
      name: "lighter_get_orders", args: {},
    });
    expect(tryFastPathLighter("lighter orders")).toEqual({ name: "lighter_get_orders", args: {} });
    expect(tryFastPathLighter("lighter markets")).toEqual({ name: "lighter_get_markets", args: {} });
    expect(tryFastPathLighter("deposit 500 usdc to lighter")).toEqual({
      name: "lighter_deposit", args: { amount: "500" },
    });
    expect(tryFastPathLighter("lighter withdraw 250")).toEqual({
      name: "lighter_withdraw", args: { amount: "250" },
    });
    expect(tryFastPathLighter("lighter status of 123")).toEqual({
      name: "lighter_get_request_status", args: { reqId: "123" },
    });
    // Generic perp phrases and other protocols stay off the Lighter path.
    expect(tryFastPathLighter("close my BTC long")).toBeNull();
    expect(tryFastPathLighter("what are my hyperliquid tools?")).toBeNull();
  });

  it("fast paths route unambiguous fund_pool (mint) phrases without the LLM", async () => {
    const { tryFastPathFundPool } = await import("../src/llm/client.js");
    expect(tryFastPathFundPool("mint 35 USDC worth of earnest smart pool")).toEqual({
      name: "fund_pool", args: { amount: "35" },
    });
    expect(tryFastPathFundPool("mint 0.1 ETH")).toEqual({ name: "fund_pool", args: { amount: "0.1" } });
    expect(tryFastPathFundPool("fund the pool with 500 USDC")).toEqual({
      name: "fund_pool", args: { amount: "500" },
    });
    expect(tryFastPathFundPool("fund 500 usdc into the pool")).toEqual({
      name: "fund_pool", args: { amount: "500" },
    });
    // Amount-less fund intents surface the clickable pool tool cards instead
    // of routing through the model.
    expect(tryFastPathFundPool("fund my pool")).toEqual({
      name: "get_tool_menu", args: { category: "pool" },
    });
    expect(tryFastPathFundPool("mint pool tokens")).toEqual({
      name: "get_tool_menu", args: { category: "pool" },
    });
    expect(tryFastPathFundPool("how do I fund the pool?")).toEqual({
      name: "get_tool_menu", args: { category: "pool" },
    });
    // Ambiguous or multi-step phrasing keeps flowing to the LLM.
    expect(tryFastPathFundPool("mint 35 USDC and then deposit to lighter")).toBeNull();
    expect(tryFastPathFundPool("can you mint some pool tokens?")).toBeNull();
    expect(tryFastPathFundPool("what is my balance?")).toBeNull();
  });

  it("routes pool tool-menu phrases to the pool category", async () => {
    const { tryFastPathToolMenu } = await import("../src/llm/client.js");
    expect(tryFastPathToolMenu("what are my pool tools?")).toEqual({
      name: "get_tool_menu", args: { category: "pool" },
    });
  });
});

describe("chain gating", () => {
  function makeCtx(chainId: number) {
    return {
      vaultAddress: VAULT,
      chainId,
      operatorAddress: OWNER,
      operatorVerified: true,
      executionMode: "manual",
    } as never;
  }

  it("rejects a lighter tool on any chain other than 19529 with a clear message", async () => {
    const { handle_lighter_get_positions } = await import("../src/llm/handlers/lighter.js");
    await expect(
      handle_lighter_get_positions({ KV: createMockKV() } as unknown as Env, makeCtx(OTHER_CHAIN), {}, "lighter_get_positions"),
    ).rejects.toThrow(/Lighter Devnet \(chain 19529\)/);
  });

  it("answers on 19529 with the portfolio report and a deposit suggestion when no account exists", async () => {
    mockState.call.mockRejectedValue(
      new Error('execution reverted (unknown error: {"code":-32003,"message":"READ_CORE query failed"})'),
    );
    const { handle_lighter_get_positions } = await import("../src/llm/handlers/lighter.js");
    const result = await handle_lighter_get_positions(
      { KV: createMockKV() } as unknown as Env, makeCtx(CHAIN), {}, "lighter_get_positions",
    );
    expect(result.message).toMatch(/Lighter Core Account/);
    expect(result.message).toMatch(/lighter_deposit/);
    expect(result.suggestions).toContain("Deposit USDC to Lighter");
  });

  it("lighter_get_orders reports on-chain order counts per tracked market", async () => {
    const trackedView = encodeAbiParameters([...LIGHTER_VIEW_DATA_OUT], [
      {
        marketIds: [0], sizeDecimals: [4], priceDecimals: [2],
        inFlightAmount: 0n, lastActionTimestamp: 0n, lastReqId: 0n,
      },
    ]);
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      if (args.data.slice(0, 10) === "0x5239dd83") return { data: trackedView };
      if (args.data.slice(0, 6) === "0x0007") {
        return { data: encodePosition({ position: 0n, entryQuote: 0n, totalOrderCount: 2n, totalPositionTiedOrderCount: 1n }) };
      }
      throw new Error(`unexpected eth_call data: ${args.data.slice(0, 10)}`);
    });
    const { handle_lighter_get_orders } = await import("../src/llm/handlers/lighter.js");
    const result = await handle_lighter_get_orders(
      { KV: createMockKV() } as unknown as Env, makeCtx(CHAIN), {}, "lighter_get_orders",
    );
    expect(result.message).toMatch(/ETH \(market 0\): 2 open order\(s\)/);
    expect(result.message).toMatch(/1 SL\/TP order\(s\) tied to a position/);
    expect(result.message).toMatch(/COUNTS only/);
    expect(result.message).toMatch(/IOC/);
    expect(result.suggestions).toContain("Cancel a Lighter order");
  });

  it("lighter_get_orders with zero counts says there are no open orders", async () => {
    const trackedView = encodeAbiParameters([...LIGHTER_VIEW_DATA_OUT], [
      {
        marketIds: [1], sizeDecimals: [5], priceDecimals: [1],
        inFlightAmount: 0n, lastActionTimestamp: 0n, lastReqId: 0n,
      },
    ]);
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      if (args.data.slice(0, 10) === "0x5239dd83") return { data: trackedView };
      if (args.data.slice(0, 6) === "0x0007") {
        return { data: encodePosition({ position: 0n, entryQuote: 0n, totalOrderCount: 0n, totalPositionTiedOrderCount: 0n }) };
      }
      throw new Error(`unexpected eth_call data: ${args.data.slice(0, 10)}`);
    });
    const { handle_lighter_get_orders } = await import("../src/llm/handlers/lighter.js");
    const result = await handle_lighter_get_orders(
      { KV: createMockKV() } as unknown as Env, makeCtx(CHAIN), {}, "lighter_get_orders",
    );
    expect(result.message).toMatch(/No open orders on the tracked markets/);
  });

  it("limit order drafts show notional vs Core collateral (margin context)", async () => {
    // Fresh vault: the no-account positions test above caches activation=false
    // for VAULT, and a definite false now hard-fails order drafts.
    const orderVault = "0x7777777777777777777777777777777777777777" as Address;
    const trackedView = encodeAbiParameters([...LIGHTER_VIEW_DATA_OUT], [
      {
        marketIds: [0], sizeDecimals: [4], priceDecimals: [2],
        inFlightAmount: 0n, lastActionTimestamp: 0n, lastReqId: 0n,
      },
    ]);
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      if (args.data.slice(0, 10) === "0x5239dd83") return { data: trackedView };
      if (args.data.slice(0, 6) === "0x0001") return { data: encodeAccount(15_000_000n) };
      if (args.data.slice(0, 6) === "0x0005") return { data: encodeMarket(246000n) };
      throw new Error(`unexpected eth_call data: ${args.data.slice(0, 10)}`);
    });
    const { handle_lighter_limit_order } = await import("../src/llm/handlers/lighter.js");
    const result = await handle_lighter_limit_order(
      { KV: createMockKV() } as unknown as Env,
      {
        vaultAddress: orderVault, chainId: CHAIN, operatorAddress: OWNER,
        operatorVerified: true, executionMode: "manual",
      } as never,
      { market: "ETH", side: "buy", size: "10", price: "2460" },
      "lighter_limit_order",
    );
    expect(result.transaction).toBeDefined();
    expect(result.message).toMatch(/Notional ≈ \$24,600\.00/);
    expect(result.message).toMatch(/Core collateral: \$15\.00/);
    expect(result.message).toMatch(/Estimated initial margin \(≈20% of notional ≈ \$4,920\.00\)/);
    expect(result.message).toMatch(/cancel it at matching without a fill/);
  });

  it("limit order with a definitely-missing Core account fails fast, pointing at lighter_deposit", async () => {
    const freshVault = "0x8888888888888888888888888888888888888888" as Address;
    setupReadCore({
      account: () => wrapNotFound(),
      market: () => encodeMarket(246000n),
    });
    const { handle_lighter_limit_order } = await import("../src/llm/handlers/lighter.js");
    await expect(
      handle_lighter_limit_order(
        { KV: createMockKV() } as unknown as Env,
        {
          vaultAddress: freshVault, chainId: CHAIN, operatorAddress: OWNER,
          operatorVerified: true, executionMode: "manual",
        } as never,
        { market: "ETH", side: "buy", size: "10", price: "2460" },
        "lighter_limit_order",
      ),
    ).rejects.toThrow(/no Lighter Core account[\s\S]*lighter_deposit/);
  });

  it("limit order still drafts when the activation read itself fails (null never blocks)", async () => {
    const freshVault = "0x9999999999999999999999999999999999999999" as Address;
    mockState.call.mockImplementation(async (args: { data: Hex }) => {
      if (args.data.slice(0, 6) === "0x0001") throw new Error("fetch failed");
      if (args.data.slice(0, 6) === "0x0005") return { data: encodeMarket(246000n) };
      throw new Error(`unexpected eth_call data: ${args.data.slice(0, 10)}`);
    });
    const { handle_lighter_limit_order } = await import("../src/llm/handlers/lighter.js");
    const result = await handle_lighter_limit_order(
      { KV: createMockKV() } as unknown as Env,
      {
        vaultAddress: freshVault, chainId: CHAIN, operatorAddress: OWNER,
        operatorVerified: true, executionMode: "manual",
      } as never,
      { market: "ETH", side: "buy", size: "10", price: "2460" },
      "lighter_limit_order",
    );
    expect(result.transaction).toBeDefined();
  });

  it("withdraw with a definitely-missing Core account fails fast, pointing at lighter_deposit", async () => {
    const freshVault = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
    setupReadCore({ account: () => wrapNotFound() });
    const { handle_lighter_withdraw } = await import("../src/llm/handlers/lighter.js");
    await expect(
      handle_lighter_withdraw(
        { KV: createMockKV() } as unknown as Env,
        {
          vaultAddress: freshVault, chainId: CHAIN, operatorAddress: OWNER,
          operatorVerified: true, executionMode: "manual",
        } as never,
        { amount: "25" },
        "lighter_withdraw",
      ),
    ).rejects.toThrow(/no Lighter Core account[\s\S]*lighter_deposit/);
  });

  it("deposit drafts are capped to the vault USDC balance and carry the async note", async () => {
    const { handle_lighter_deposit } = await import("../src/llm/handlers/lighter.js");
    // getVaultTokenBalance uses client.multicall — serve it via a dedicated mock.
    mockState.readContract.mockReset();
    const vault2 = "0x6666666666666666666666666666666666666666" as Address;
    const clientWithMulticall = {
      call: mockState.call,
      readContract: mockState.readContract,
      multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
        contracts.map((c) => ({
          status: "success" as const,
          result: c.functionName === "balanceOf" ? 100_000_000n : c.functionName === "decimals" ? 6 : "USDC",
        })),
      ),
      getBalance: vi.fn(async () => 0n),
    };
    mockState.getRpcProvider.mockReturnValue(clientWithMulticall as never);
    const result = await handle_lighter_deposit(
      { KV: createMockKV() } as unknown as Env,
      {
        vaultAddress: vault2, chainId: CHAIN, operatorAddress: OWNER,
        operatorVerified: true, executionMode: "manual",
      } as never,
      { amount: "500" },
      "lighter_deposit",
    );
    expect(result.transaction).toBeDefined();
    expect(result.transaction!.data.slice(0, 10)).toBe(ALLOWED_VAULT_SELECTORS.lighterSendToCore);
    expect(result.message).toMatch(/capped to the vault's available balance: 100\.000000 USDC/);
    expect(result.message).toMatch(/lighter_get_request_status/);
  });
});

describe("resolveLighterMarketId (symbol or numeric id)", () => {
  it("resolves devnet symbols case-insensitively", () => {
    expect(resolveLighterMarketId("ETH")).toBe(0);
    expect(resolveLighterMarketId("btc")).toBe(1);
    expect(resolveLighterMarketId(" Sol ")).toBe(2);
    expect(resolveLighterMarketId("DOGE")).toBe(3);
  });

  it("passes through numeric ids given as numbers or strings", () => {
    expect(resolveLighterMarketId(0)).toBe(0);
    expect(resolveLighterMarketId("0")).toBe(0);
    expect(resolveLighterMarketId(2047)).toBe(2047);
  });

  it("rejects unknown symbols and non-integers with the known-symbol list", () => {
    for (const bad of ["XAU", "-1", "1.5", "", "0x12"]) {
      expect(() => resolveLighterMarketId(bad), bad).toThrow(/Invalid Lighter market/);
    }
    expect(() => resolveLighterMarketId("XAU")).toThrow(/ETH, BTC, SOL, DOGE/);
  });
});
