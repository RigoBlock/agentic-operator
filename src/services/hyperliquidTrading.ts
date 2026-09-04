/**
 * Hyperliquid calldata builders.
 *
 * All transactions target the VAULT (the AHyperliquid adapter runs in delegatecall
 * context), mirroring how the GMX adapter calls work. Three entry points exist:
 *
 *   - deposit / depositFor  → bridge EVM USDC (6 decimals) into the Core perp account
 *                             (this also ACTIVATES a previously inactive Core account)
 *   - sendRawAction(bytes)  → wraps CoreWriter actions: limit orders, spot sends
 *                             (withdrawals), USD-class transfers, order cancels
 *
 * CoreWriter action payload layout (data[0] = version 1, data[1:4] = uint24 action
 * id, data[4:] = abi-encoded params) is defined in hyper-evm-lib CoreWriterLib and
 * enforced by the AHyperliquid adapter.
 *
 * Unit conversions (USDC-only integration — mind the differing decimals):
 *   - deposit amount          : EVM USDC, 6 decimals (uint256)
 *   - USD_CLASS_TRANSFER ntl  : perp USDC, 6 decimals (uint64)
 *   - SPOT_SEND amount        : Core spot USDC, 8 decimals core wei (uint64)
 *   - limit order limitPx     : 8-decimal fixed point (uint64)
 *   - limit order sz          : base-asset units scaled by market szDecimals (uint64)
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  RIGOBLOCK_HYPERLIQUID_ABI,
  HL_ACTIONS,
  HL_TIF,
  HL_USDC_SYSTEM_ADDRESS,
  HL_USDC_TOKEN_INDEX,
  HL_DEFAULT_PERP_DEX,
  type HlTifName,
} from "../abi/hyperliquid.js";

const U64_MAX = (1n << 64n) - 1n;

// ── Unit conversions ──────────────────────────────────────────────────

/** Human price (e.g. "67234.5") → Core uint64 fixed point with 8 decimals. */
export function toHlPx(price: number | string): bigint {
  const n = typeof price === "string" ? parseFloat(price) : price;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid Hyperliquid price: ${price} (must be a positive number).`);
  }
  const px = BigInt(Math.round(n * 1e8));
  if (px > U64_MAX) throw new Error(`Hyperliquid price too large: ${price}`);
  return px;
}

/** Human base-asset size (e.g. "0.15" BTC) → Core uint64 size.
 *
 * Per the HyperCore docs, sz is sent as 10^8 × the human-readable value —
 * the SAME 1e8 fixed point as prices, for every market. `szDecimals` is only a
 * matching-engine quantization constraint (min size increment), NOT the wire
 * scale: the size is first rounded to `szDecimals` decimals, then scaled by
 * 10^(8 - szDecimals), keeping the math exact in integers. */
export function toHlSz(size: number | string, szDecimals: number): bigint {
  const n = typeof size === "string" ? parseFloat(size) : size;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid Hyperliquid order size: ${size} (must be a positive number).`);
  }
  const quantum = BigInt(Math.round(n * 10 ** szDecimals));
  if (quantum === 0n) throw new Error(`Hyperliquid order size too small: ${size} (rounds to 0 at ${szDecimals} decimals).`);
  const sz = quantum * 10n ** BigInt(8 - szDecimals);
  if (sz > U64_MAX) throw new Error(`Hyperliquid order size too large: ${size}`);
  return sz;
}

/** Human USDC amount → 6-decimal perp USDC units (deposit, USD_CLASS_TRANSFER). */
export function usdToPerpUnits(amount: number | string): bigint {
  const n = typeof amount === "string" ? parseFloat(amount.replace(/[$,]/g, "")) : amount;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid USDC amount: ${amount} (must be a positive number).`);
  }
  const units = BigInt(Math.round(n * 1e6));
  if (units === 0n) throw new Error(`USDC amount too small: ${amount}`);
  return units;
}

/** Human USDC amount → 8-decimal Core spot wei (SPOT_SEND). */
export function usdToCoreWei(amount: number | string): bigint {
  const n = typeof amount === "string" ? parseFloat(amount.replace(/[$,]/g, "")) : amount;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid USDC amount: ${amount} (must be a positive number).`);
  }
  const wei = BigInt(Math.round(n * 1e8));
  if (wei === 0n) throw new Error(`USDC amount too small: ${amount}`);
  if (wei > U64_MAX) throw new Error(`USDC amount too large: ${amount}`);
  return wei;
}

/** Random uint128 client order id (for cancel-by-cloid). */
export function randomCloid(): bigint {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return BigInt(`0x${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`);
}

export function tifToCode(tif: HlTifName | number): number {
  if (typeof tif === "number") return tif;
  const code = HL_TIF[tif];
  if (!code) throw new Error(`Invalid time-in-force: ${tif} (use 'alo', 'gtc', or 'ioc').`);
  return code;
}

// ── sendRawAction payload ─────────────────────────────────────────────

/** Build the raw CoreWriter payload: version byte + uint24 action id + abi-encoded params. */
export function encodeHlAction(actionId: number, params: Hex): Hex {
  const actionBytes = new Uint8Array(4);
  actionBytes[0] = 1; // version
  actionBytes[1] = (actionId >> 16) & 0xff;
  actionBytes[2] = (actionId >> 8) & 0xff;
  actionBytes[3] = actionId & 0xff;
  return (`0x${Buffer.from(actionBytes).toString("hex")}${params.slice(2)}`) as Hex;
}

function sendRawActionCalldata(actionId: number, types: Parameters<typeof encodeAbiParameters>[0], values: unknown[]): Hex {
  return encodeFunctionData({
    abi: RIGOBLOCK_HYPERLIQUID_ABI,
    functionName: "sendRawAction",
    args: [encodeHlAction(actionId, encodeAbiParameters(types, values))],
  });
}

// ── Public builders (all return vault-targeted calldata) ──────────────

/** deposit(amount, destinationDex=0) — bridge EVM USDC into the Core perp account. */
export function buildHlDepositCalldata(amountHuman: string): Hex {
  const amount = parseUnits(amountHuman.replace(/[$,]/g, ""), 6);
  if (amount <= 0n) throw new Error(`Invalid deposit amount: ${amountHuman}`);
  return encodeFunctionData({
    abi: RIGOBLOCK_HYPERLIQUID_ABI,
    functionName: "deposit",
    args: [amount, HL_DEFAULT_PERP_DEX],
  });
}

/** depositFor(recipient, amount, destinationDex=0) — explicit-recipient variant. */
export function buildHlDepositForCalldata(recipient: Address, amountHuman: string): Hex {
  const amount = parseUnits(amountHuman.replace(/[$,]/g, ""), 6);
  if (amount <= 0n) throw new Error(`Invalid deposit amount: ${amountHuman}`);
  return encodeFunctionData({
    abi: RIGOBLOCK_HYPERLIQUID_ABI,
    functionName: "depositFor",
    args: [recipient, amount, HL_DEFAULT_PERP_DEX],
  });
}

export interface HlLimitOrderParams {
  asset: number;
  isBuy: boolean;
  limitPx: bigint;
  sz: bigint;
  reduceOnly: boolean;
  tif: HlTifName | number;
  cloid: bigint;
}

/** LIMIT_ORDER_ACTION — open, increase, decrease (reduceOnly), or close a perp position. */
export function buildHlLimitOrderCalldata(p: HlLimitOrderParams): Hex {
  if (p.asset < 0 || p.asset >= 10000) {
    throw new Error(`Invalid core perp asset index: ${p.asset}`);
  }
  return sendRawActionCalldata(
    HL_ACTIONS.limitOrder,
    [
      { type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" },
      { type: "bool" }, { type: "uint8" }, { type: "uint128" },
    ],
    [p.asset, p.isBuy, p.limitPx, p.sz, p.reduceOnly, tifToCode(p.tif), p.cloid],
  );
}

/**
 * SPOT_SEND_ACTION — bridge Core spot USDC back to HyperEVM (step 2 of a withdrawal).
 * The adapter only accepts USDC (token index 0) destined for the USDC system address.
 */
export function buildHlSpotSendCalldata(amountHuman: string): Hex {
  return sendRawActionCalldata(
    HL_ACTIONS.spotSend,
    [{ type: "address" }, { type: "uint64" }, { type: "uint64" }],
    [HL_USDC_SYSTEM_ADDRESS, HL_USDC_TOKEN_INDEX, usdToCoreWei(amountHuman)],
  );
}

/**
 * USD_CLASS_TRANSFER_ACTION — move USDC between the Core perp margin account and the
 * Core spot account. The adapter is perps-only and rejects toPerp=true, so this only
 * ever moves perp → spot (step 1 of a withdrawal).
 */
export function buildHlUsdClassTransferCalldata(amountHuman: string): Hex {
  return sendRawActionCalldata(
    HL_ACTIONS.usdClassTransfer,
    [{ type: "uint64" }, { type: "bool" }],
    [usdToPerpUnits(amountHuman), false],
  );
}

/** CANCEL_ORDER_BY_OID_ACTION — cancel an open order by its oid (from the positions report). */
export function buildHlCancelByOidCalldata(asset: number, oid: number): Hex {
  return sendRawActionCalldata(
    HL_ACTIONS.cancelOrderByOid,
    [{ type: "uint32" }, { type: "uint64" }],
    [asset, oid],
  );
}

/** CANCEL_ORDER_BY_CLOID_ACTION — cancel an open order by its client order id. */
export function buildHlCancelByCloidCalldata(asset: number, cloid: bigint): Hex {
  return sendRawActionCalldata(
    HL_ACTIONS.cancelOrderByCloid,
    [{ type: "uint32" }, { type: "uint128" }],
    [asset, cloid],
  );
}
