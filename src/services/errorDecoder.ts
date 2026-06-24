/**
 * Revert-data decoder for on-chain simulation failures.
 *
 * Tries to decode raw hex revert data against a set of common Solidity errors
 * from the ERC-20 spec, Uniswap/Universal Router, 0x Settler, and generic
 * `Error(string)` / `Panic(uint256)`. Falls back to a human-readable summary
 * when the selector is unknown.
 */

import { decodeErrorResult } from "viem";

const COMMON_ERRORS = [
  // Solidity builtins
  { name: "Error", type: "error", inputs: [{ name: "message", type: "string" }] },
  { name: "Panic", type: "error", inputs: [{ name: "code", type: "uint256" }] },

  // ERC-20 (OpenZeppelin / Solmate-style)
  {
    name: "ERC20InsufficientBalance",
    type: "error",
    inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }],
  },
  {
    name: "ERC20InsufficientAllowance",
    type: "error",
    inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }],
  },
  { name: "ERC20InvalidSender", type: "error", inputs: [{ name: "sender", type: "address" }] },
  { name: "ERC20InvalidReceiver", type: "error", inputs: [{ name: "receiver", type: "address" }] },
  { name: "SafeERC20FailedOperation", type: "error", inputs: [{ name: "token", type: "address" }] },

  // Uniswap V3 / Universal Router / V4
  { name: "TooLittleReceived", type: "error", inputs: [{ name: "amount", type: "uint256" }] },
  { name: "TooMuchRequested", type: "error", inputs: [{ name: "amount", type: "uint256" }] },
  { name: "InsufficientOutputAmount", type: "error", inputs: [{ name: "amount", type: "uint256" }] },
  { name: "ExcessiveInputAmount", type: "error", inputs: [{ name: "amount", type: "uint256" }] },
  { name: "TransactionTooOld", type: "error", inputs: [{ name: "deadline", type: "uint256" }, { name: "blockTimestamp", type: "uint256" }] },
  { name: "InvalidCommandType", type: "error", inputs: [{ name: "command", type: "uint8" }] },
  {
    name: "ExecutionFailed",
    type: "error",
    inputs: [{ name: "commandIndex", type: "uint256" }, { name: "reason", type: "bytes" }],
  },
  { name: "V4TooLittleReceived", type: "error", inputs: [{ name: "amount", type: "uint256" }] },
  { name: "V4TooMuchRequested", type: "error", inputs: [{ name: "amount", type: "uint256" }] },
  { name: "InsufficientToken", type: "error", inputs: [{ name: "token", type: "address" }] },
  { name: "CurrencyNotSettled", type: "error", inputs: [] },
  { name: "PoolNotInitialized", type: "error", inputs: [] },
  { name: "InvalidSqrtPriceLimit", type: "error", inputs: [{ name: "value", type: "uint160" }] },
  { name: "InvalidPoolKey", type: "error", inputs: [] },
  { name: "TickSpacingNotInitialized", type: "error", inputs: [{ name: "tickSpacing", type: "int24" }] },
  { name: "NoSwapData", type: "error", inputs: [] },
  { name: "NoSwapInput", type: "error", inputs: [] },

  // 0x Settler
  { name: "TransferFromRecipientNotSettler", type: "error", inputs: [] },
  { name: "BadPool", type: "error", inputs: [] },
  { name: "Expired", type: "error", inputs: [{ name: "deadline", type: "uint256" }] },

  // Rigoblock / 0x adapter
  { name: "ActionNotAllowed", type: "error", inputs: [{ name: "actionSelector", type: "bytes4" }] },
  { name: "Unauthorized", type: "error", inputs: [] },
  { name: "OnlyOwner", type: "error", inputs: [] },
  { name: "NotDelegated", type: "error", inputs: [{ name: "delegated", type: "address" }, { name: "selector", type: "bytes4" }] },
  { name: "InvalidAmount", type: "error", inputs: [] },
];

const PANIC_CODES: Record<number, string> = {
  0x00: "generic compiler panic",
  0x01: "assertion failed",
  0x11: "arithmetic overflow/underflow",
  0x12: "division by zero",
  0x21: "invalid conversion to enum",
  0x22: "storage encoding error",
  0x31: "empty array pop",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "zero-initialized variable",
};

function formatDecodedError(name: string, args: unknown): string {
  const record = Array.isArray(args)
    ? Object.fromEntries(args.map((v, i) => [i, v]))
    : (args as Record<string, unknown> | undefined) ?? {};

  if (name === "Error") {
    return String(record.message ?? record["0"] ?? "");
  }
  if (name === "Panic") {
    const code = Number(record.code ?? record["0"] ?? 0);
    return `Panic(${code}) — ${PANIC_CODES[code] ?? "unknown panic code"}`;
  }
  if (name === "ExecutionFailed") {
    const inner = decodeRevertData(String(record.reason ?? record["1"] ?? "0x"));
    return `Uniswap command ${record.commandIndex ?? record["0"]} failed${inner && !inner.startsWith("0x") ? `: ${inner}` : ""}`;
  }
  if (name === "ActionNotAllowed") {
    const sel = String(record.actionSelector ?? record["0"] ?? "0x");
    return `0x Settler action ${sel} is not allowed by Rigoblock's A0xRouter on this chain. Try the same swap via Uniswap or on another chain.`;
  }

  const argEntries = Object.entries(record).map(([k, v]) => `${k}=${String(v)}`);
  return `${name}(${argEntries.join(", ")})`;
}

/**
 * Decode raw revert hex data into a human-readable string.
 * Returns `null` if `data` is not valid hex or too short.
 */
export function decodeRevertData(data: string): string | null {
  if (!data || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;

  try {
    const result = decodeErrorResult({
      abi: COMMON_ERRORS,
      data: data.toLowerCase() as `0x${string}`,
    });
    return `Contract reverted: ${formatDecodedError(result.errorName, result.args)}`;
  } catch {
    const selector = data.slice(0, 10).toLowerCase();
    return `Unknown on-chain revert (${selector}). The transaction would fail, usually because of invalid swap parameters, missing liquidity, or an unsupported token pair.`;
  }
}

/**
 * Pull a revert-data hex string out of a potentially verbose error message.
 */
export function extractRevertData(raw: string): string | null {
  const match = raw.match(/(?:revert data:|0x)[\s]*?(0x[0-9a-fA-F]{8,})/i);
  return match ? match[1].toLowerCase() : null;
}
