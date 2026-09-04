/**
 * Hyperliquid (HyperEVM) — adapter ABI, CoreWriter action constants, and read-precompile ABIs.
 *
 * The Rigoblock smart pool interacts with Hyperliquid Core through the AHyperliquid
 * vault adapter (delegatecall context, so calldata is sent TO THE VAULT):
 *
 *   - deposit(uint256 amount, uint32 destinationDex)           → bridge EVM USDC into the Core perp account
 *   - depositFor(address recipient, uint256 amount, uint32 destinationDex)
 *                                                               → same, explicit recipient (must be the vault itself)
 *   - sendRawAction(bytes data)                                 → generic CoreWriter action wrapper
 *
 * sendRawAction payload layout (see hyper-evm-lib CoreWriterLib):
 *   data[0]     = uint8 version (must be 1)
 *   data[1:4]   = uint24 action id
 *   data[4:]    = abi-encoded action parameters
 *
 * Supported actions (AHyperliquid.sendRawAction whitelist):
 *   1  LIMIT_ORDER_ACTION          (asset, isBuy, limitPx, sz, reduceOnly, tif, cloid)
 *   6  SPOT_SEND_ACTION            (destination, token, amountWei) — USDC-only, destination must be the token's system address
 *   7  USD_CLASS_TRANSFER_ACTION   (ntl, toPerp) — adapter rejects toPerp=true (perps-only)
 *   10 CANCEL_ORDER_BY_OID_ACTION  (asset, orderId)
 *   11 CANCEL_ORDER_BY_CLOID_ACTION(asset, cloid)
 *
 * Decimal conventions (USDC-only integration):
 *   - EVM USDC (vault side): 6 decimals
 *   - Core perp account USDC: 6 decimals (accountMarginSummary.accountValue)
 *   - Core spot USDC: 8 decimals ("core wei") — spotBalance returns 8-decimal amounts
 *   - Prices (limitPx): 8-decimal fixed point
 *   - Sizes (sz): base-asset units scaled by the market's szDecimals
 */

export const HYPEREVM_CHAIN_ID = 999;

/** EVM-side USDC on HyperEVM (6 decimals). */
export const HYPEREVM_USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as const;

/**
 * CoreDepositWallet (Circle) — the ONLY supported HyperEVM → HyperCore deposit path
 * since Hyperliquid's native-USDC migration. Native USDC is a plain ERC20; calling
 * `deposit(...)` on it reverts with no reason. The AHyperliquid adapter must approve
 * USDC to this contract and call its `deposit(uint256 amount, uint32 destinationDex)`
 * (selector identical to the adapter's own deposit). Verify via spotMeta
 * `evmContract.address` for USDC. destinationDex: 0 = perps, type(uint32).max = spot.
 */
export const HL_CORE_DEPOSIT_WALLET = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24" as const;

/** USDC token index on HyperCore. */
export const HL_USDC_TOKEN_INDEX = 0n;

/** Destination dex for deposits: 0 = default perp dex (adapter rejects anything else). */
export const HL_DEFAULT_PERP_DEX = 0;

// ── CoreWriter action ids (HLConstants) ───────────────────────────────

export const HL_ACTIONS = {
  limitOrder: 1,
  spotSend: 6,
  usdClassTransfer: 7,
  cancelOrderByOid: 10,
  cancelOrderByCloid: 11,
} as const;

/** Time-in-force encodings (HLConstants LIMIT_ORDER_TIF_*). */
export const HL_TIF = {
  alo: 1,
  gtc: 2,
  ioc: 3,
} as const;

export type HlTifName = keyof typeof HL_TIF;

/** Core perp assets have assetId < 10_000 (adapter rejects spot/outcome assets). */
export const HL_CORE_SPOT_ASSET_BASE = 10000;

/**
 * System address for a Core token: base system address + token index
 * (CoreWriterLib.getSystemAddress; HYPE has a fixed special address but the
 * adapter only supports USDC, token index 0).
 */
export const HL_SYSTEM_ADDRESS_BASE = 0x2000000000000000000000000000000000000000n;
export function getHlSystemAddress(tokenIndex: bigint): `0x${string}` {
  return `0x${(HL_SYSTEM_ADDRESS_BASE + tokenIndex).toString(16).padStart(40, "0")}` as `0x${string}`;
}
/** USDC system address — the only valid SPOT_SEND destination for this adapter. */
export const HL_USDC_SYSTEM_ADDRESS = getHlSystemAddress(HL_USDC_TOKEN_INDEX);

// ── AHyperliquid adapter ABI (called on the vault, like RIGOBLOCK_GMX_ABI) ──

export const RIGOBLOCK_HYPERLIQUID_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDex", type: "uint32" },
    ],
    outputs: [],
  },
  {
    name: "depositFor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "destinationDex", type: "uint32" },
    ],
    outputs: [],
  },
  {
    name: "sendRawAction",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [],
  },
] as const;

// ── HyperEVM read precompiles (PrecompileLib / HLConstants) ───────────

export const HL_PRECOMPILES = {
  spotBalance: "0x0000000000000000000000000000000000000801",
  position2: "0x0000000000000000000000000000000000000813",
  accountMarginSummary: "0x000000000000000000000000000000000000080f",
  coreUserExists: "0x0000000000000000000000000000000000000810",
} as const;

/**
 * NOTE: HyperEVM read precompiles take raw abi.encode(args) input WITHOUT a
 * 4-byte function selector (selector-based calls revert with PrecompileError).
 * Call them via raw eth_call — see callReadPrecompile in services/hyperliquid.ts.
 */
export const HL_POSITION_ABI = [
  {
    name: "position",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "perp", type: "uint32" },
    ],
    outputs: [
      { name: "szi", type: "int64" },
      { name: "entryNtl", type: "uint64" },
      { name: "isolatedRawUsd", type: "int64" },
      { name: "leverage", type: "uint32" },
      { name: "isIsolated", type: "bool" },
    ],
  },
] as const;

// ── Hyperliquid Core info API ─────────────────────────────────────────

export const HL_INFO_API_URL = "https://api.hyperliquid.xyz/info";
