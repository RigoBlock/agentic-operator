/**
 * Lighter (Lighter Core perps on Lighter EVM devnet) — adapter ABI, READ_CORE
 * precompile constants, selectors, and custom errors.
 *
 * The Rigoblock smart pool interacts with Lighter Core through the ALighter
 * vault adapter (delegatecall context, so calldata is sent TO THE VAULT):
 *
 *   - sendToCore(uint32,address,bool,uint256,uint8)              → deposit pool USDC into the
 *                                                                  vault's Core perps margin
 *                                                                  (assetIndex forced 3 = USDC,
 *                                                                  to = vault, isL1Account false,
 *                                                                  routeType 0 = Perps, ETH value 0);
 *                                                                  first deposit auto-creates the
 *                                                                  vault's EVM-controlled Core
 *                                                                  master account — NO activation step
 *   - sendToEvm(uint48,uint32,address,uint8,uint64)              → withdraw USDC from Core perps
 *                                                                  back to the pool (baseAmount in
 *                                                                  6-dec USDC since tickSize = 1);
 *                                                                  reverts AccountNotActivated when
 *                                                                  no Core account exists
 *   - createOrder(uint48,uint16,uint48,uint8,uint8,uint64,uint48,uint32,bool,bool,uint32)
 *                                                                → perp order; requires the market
 *                                                                  tracked by the pool, marketIndex < 2048;
 *                                                                  accountIndex arg is ignored (adapter
 *                                                                  substitutes the vault's own)
 *   - cancelOrder(uint48,uint64) / cancelAllOrders(uint48)       → order cancels (accountIndex ignored)
 *   - trackMarket(uint16) / untrackMarket(uint16)                → pool-owner market tracking
 *                                                                  (untrack requires zero position;
 *                                                                  decimals come from the adapter's
 *                                                                  LighterConstants table, ALighter
 *                                                                  v4.6.0; old 3-arg 0x341a942b retired)
 *
 * On-chain NAV valuation lives on the pool implementation's EAppsLighter
 * extension (getLighterBalances(), 0x58a5a2a4 — 0-arg since v4.6.0; the old
 * adapter-side getLighterBalances(address) 0x432de12b was removed). The
 * operator never calls it: the portfolio view reads READ_CORE directly.
 *
 * READ_CORE precompile (0x6600…0000) encodings are live-verified against the
 * current devnet build (2026-10-20); see docs/lighter-integration.md. Current
 * build returns RAW abi.encode payloads WITHOUT the documented (bool, bytes)
 * envelope for every query except tx status (0x0000).
 *
 * Decimal conventions (USDC-only integration):
 *   - EVM USDC (vault side): 6 decimals
 *   - Core collateral (collateralBaseAmount, entryQuote): 6-dec USDC
 *   - allocatedMargin: 12 decimals (divide by 1e6 for USDC)
 *   - order amount: base-asset units scaled by the market's sizeDecimals
 *   - order price: market price units scaled by the market's priceDecimals
 *     (size/price decimals are NOT readable on-chain — Lighter docs; the
 *      operator resolves them deterministically: verified constants → Core
 *      API orderBookDetails → fail closed; NEVER user input)
 */

export const LIGHTER_CHAIN_ID = 19529;

/**
 * ALighter adapter on Lighter EVM devnet (Authority-verified 2026-10-20):
 * authority.getApplicationAdapter(0xee814ef0 /* trackMarket(uint16) *​/) and the
 * other ALighter selectors resolve here on the upgraded protocol. The previous
 * adapter 0x84859b478ca90300ac39bae37bf3038d54ba82ec is retired.
 */
export const LIGHTER_ADAPTER = "0x9f9596248500098c3ec044dd5905584f593185d1" as const;

/** READ_CORE precompile. */
export const LIGHTER_READ_CORE = "0x6600000000000000000000000000000000000000" as const;

/** Lighter EVM interop manager precompile. */
export const LIGHTER_EVM_INTEROP_MANAGER = "0x6600000000000000000000000000000000000001" as const;

/** Lighter Core entrypoint precompile. */
export const LIGHTER_CORE_ENTRYPOINT = "0x6600000000000000000000000000000000000009" as const;

/** EVM-side USDC on Lighter devnet (6 decimals, assetIndex 3). */
export const LIGHTER_USDC = "0xf2A5728d366c6d0f764Af612cD47F3608E2B4d5B" as const;

/** USDC asset index on Lighter Core. */
export const LIGHTER_USDC_ASSET_INDEX = 3;

/** First spot market id — perp marketIndex must be < this. */
export const LIGHTER_FIRST_SPOT_MARKET_ID = 2048;

/**
 * getLighterTrackedMarkets() selector — the EApps/EAppsLighter view on the
 * pool, returning LighterViewData{marketIds, sizeDecimals, priceDecimals,
 * inFlightAmount, lastActionTimestamp, lastReqId}. This is the SINGLE source
 * of tracked markets AND their decimals for the operator: the adapter resolves
 * decimals from its own LighterConstants table at track time, and this view
 * exposes exactly those values, so operator and contract cannot disagree.
 */
export const LIGHTER_VIEW_TRACKED_MARKETS = "0x5239dd83";

/** LighterViewData output layout (verified live on the devnet, 2026-10-20). */
export const LIGHTER_VIEW_DATA_OUT = [
  {
    type: "tuple",
    components: [
      { name: "marketIds", type: "uint16[]" },
      { name: "sizeDecimals", type: "uint8[]" },
      { name: "priceDecimals", type: "uint8[]" },
      { name: "inFlightAmount", type: "int128" },
      { name: "lastActionTimestamp", type: "uint64" },
      { name: "lastReqId", type: "uint64" },
    ],
  },
] as const;

/**
 * Devnet perp symbols by market id, per the Lighter devnet docs (markets
 * page, 2026-10-20): 0 ETH, 1 BTC, 2 SOL, 3 DOGE perps, 2048 ETH/USDC spot.
 * Used for display and for resolving user input ("BTC" → 1); there is no
 * on-chain symbol read.
 */
export const LIGHTER_MARKET_SYMBOLS: Record<number, string> = {
  0: "ETH",
  1: "BTC",
  2: "SOL",
  3: "DOGE",
  2048: "ETH/USDC",
};

// ── READ_CORE query ids (uint16 prefix, abi.encodePacked with the args) ──

export const LIGHTER_QUERIES = {
  txStatus: 0x0000,        // + uint64 reqId (10 bytes) — RETURNS the (uint8, bytes) envelope
  accountInfo: 0x0001,     // + address + bool(1 byte) (23 bytes) — raw 6-word tuple; ERRORS when account absent
  assetDecimals: 0x0002,   // + uint32 assetId (6 bytes) — raw uint8 word
  evmToken: 0x0004,        // + uint32 assetId (6 bytes) — raw address word
  marketInfo: 0x0005,      // + uint16 marketId (4 bytes) — raw 10-word tuple
  position: 0x0007,        // + address + bool + uint16 marketId (25 bytes) — raw 7-word tuple
  evmAccountIndex: 0x0009, // + address (22 bytes) — raw uint48 word; ERRORS when account absent
} as const;

/** Tx status codes (0x0000 envelope payload). */
export const LIGHTER_TX_STATUS = {
  pending: 0,
  success: 1,
  failed: 2,
} as const;

/** Order type codes (createOrder orderType). */
export const LIGHTER_ORDER_TYPES = {
  limit: 0,
  market: 1,
} as const;

/** Time-in-force codes (createOrder tif). */
export const LIGHTER_TIF = {
  ioc: 0,
  gtt: 1,
  postOnly: 2,
} as const;

/** Position marginMode: 1 = isolated (allocatedMargin is added back to the position value). */
export const LIGHTER_MARGIN_MODE_ISOLATED = 1;

// ── ALighter adapter ABI (called on the vault, delegatecall context) ──────

export const RIGOBLOCK_LIGHTER_ABI = [
  {
    name: "sendToCore",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assetIndex", type: "uint32" },
      { name: "to", type: "address" },
      { name: "isPerp", type: "bool" },
      { name: "amount", type: "uint256" },
      { name: "routeType", type: "uint8" },
    ],
    outputs: [],
  },
  {
    name: "sendToEvm",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accountIndex", type: "uint48" },
      { name: "assetIndex", type: "uint32" },
      { name: "to", type: "address" },
      { name: "routeType", type: "uint8" },
      { name: "baseAmount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    name: "createOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accountIndex", type: "uint48" },
      { name: "marketIndex", type: "uint16" },
      { name: "clientOrderIndex", type: "uint48" },
      { name: "orderType", type: "uint8" },
      { name: "timeInForce", type: "uint8" },
      { name: "orderExpiry", type: "uint64" },
      { name: "amount", type: "uint48" },
      { name: "price", type: "uint32" },
      { name: "isAsk", type: "bool" },
      { name: "reduceOnly", type: "bool" },
      { name: "triggerPrice", type: "uint32" },
    ],
    outputs: [],
  },
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accountIndex", type: "uint48" },
      { name: "orderIndex", type: "uint64" },
    ],
    outputs: [],
  },
  {
    name: "cancelAllOrders",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "accountIndex", type: "uint48" }],
    outputs: [],
  },
  {
    name: "trackMarket",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketIndex", type: "uint16" }],
    outputs: [],
  },
  {
    name: "untrackMarket",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketIndex", type: "uint16" }],
    outputs: [],
  },
  // NOTE: getLighterBalances moved off the adapter in ALighter v4.6.0 — it now
  // lives on the pool implementation's EAppsLighter extension as the 0-arg view
  // getLighterBalances() (0x58a5a2a4), which owns on-chain NAV valuation. The
  // operator never calls it: the portfolio view reads READ_CORE directly.

  // ── Events (IALighter) ──
  // OrderSent carries the Core request id — the handle for lighter_get_request_status.
  {
    name: "Deposited",
    type: "event",
    inputs: [{ name: "amount", type: "uint256", indexed: false }],
  },
  {
    name: "Withdrawn",
    type: "event",
    inputs: [{ name: "amount", type: "uint256", indexed: false }],
  },
  {
    name: "OrderSent",
    type: "event",
    inputs: [{ name: "reqId", type: "uint64", indexed: true }],
  },
  {
    name: "MarketTracked",
    type: "event",
    inputs: [{ name: "marketId", type: "uint16", indexed: true }],
  },
  {
    name: "MarketUntracked",
    type: "event",
    inputs: [{ name: "marketId", type: "uint16", indexed: true }],
  },
] as const;

// ── Vault-facing selectors (must match ALLOWED_VAULT_SELECTORS) ────────

export const LIGHTER_SELECTORS = {
  sendToCore: "0xeed67f2c" as `0x${string}`,
  sendToEvm: "0x60f502da" as `0x${string}`,
  createOrder: "0x8a7da422" as `0x${string}`,
  cancelOrder: "0x736fd6b3" as `0x${string}`,
  cancelAllOrders: "0xa4b6f756" as `0x${string}`,
  trackMarket: "0xee814ef0" as `0x${string}`,
  untrackMarket: "0xe0ad5442" as `0x${string}`,
} as const;

/** ALighter custom errors, selector → error name (live-verified 2026-10-20). */
export const LIGHTER_ERROR_SELECTORS = {
  "0x207719d0": "NavLocked",
  "0x0db95510": "InvalidMarketDecimals",
  "0x6a409768": "MarketAlreadyTracked",
  "0xfacd8cec": "MarketNotTracked",
  "0xb741d9ce": "MaxTrackedMarketsReached",
  "0x9db8d5b1": "InvalidMarket",
  "0xa1f354f7": "UnknownMarket",
  "0x73861efb": "LighterReadFailed",
  "0x8b22d48e": "PositionNotClosed",
  "0x125d8e21": "AccountNotActivated",
} as const;
