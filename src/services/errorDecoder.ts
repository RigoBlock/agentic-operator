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

  // Rigoblock cross-chain (AIntents / NavImpactLib)
  { name: "NavImpactTooHigh", type: "error", inputs: [] },
  { name: "EffectiveSupplyTooLow", type: "error", inputs: [] },
  { name: "SameChainTransfer", type: "error", inputs: [] },
  { name: "InvalidQuoteTimestamp", type: "error", inputs: [] },
  { name: "OutputAmountTooLow", type: "error", inputs: [] },
  { name: "OutputAmountTooHigh", type: "error", inputs: [] },
];

/** Names for 0x Settler action selectors that A0xRouter may report via ActionNotAllowed. */
const SETTLER_ACTION_NAMES: Record<string, string> = {
  "0xee01edc0": "TRANSFER_FROM",
  "0xbd01c226": "NATIVE_CHECK",
  "0x34ee90ca": "POSITIVE_SLIPPAGE",
  "0x38c9c147": "BASIC",
  "0x8d68a156": "UNISWAPV3",
  "0xd5022441": "UNISWAPV3_VIP",
  "0x103b48be": "UNISWAPV2",
  "0xaf72634f": "UNISWAPV4",
  "0xfd8c38e1": "BALANCERV3",
  "0xd4351666": "BALANCERV3_VIP",
  "0xdf753f1e": "PANCAKE_INFINITY",
  "0x2084a6e9": "PANCAKE_INFINITY_VIP",
  "0x4340af3f": "CURVE_TRICRYPTO_VIP",
  "0xb8df6d4d": "DODOV1",
  "0xca9e5d0f": "DODOV2",
  "0xf5b99189": "VELODROME",
  "0x9b59756f": "MAVERICKV2",
  "0x736180c8": "MAKERPSM",
  "0x6c5f9cf9": "EKUBO",
  "0xf61460f9": "EKUBOV3",
  "0xfc9ba903": "EKUBOV3_VIP",
  "0x6472b276": "EULERSWAP",
  "0xb4d5761a": "BEBOP",
  "0xd47868c9": "HANJI",
  "0xb202e9b4": "RFQ",
  "0x131ad428": "CHECK_SLIPPAGE",
};

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
    const sel = String(record.actionSelector ?? record["0"] ?? "0x").toLowerCase();
    const actionName = SETTLER_ACTION_NAMES[sel] ?? "unknown 0x settler action";
    return `ActionNotAllowed(${sel} = ${actionName}) — Rigoblock A0xRouter rejected this 0x settler action.`;
  }
  if (name === "NavImpactTooHigh") {
    return "NavImpactTooHigh — this operation would move too much value out of the vault in one transaction. " +
      "For NAV sync this happens on the SOURCE chain because tokens leave but virtual supply is not reduced, so the source-chain unit price drops. " +
      "Try a smaller amount, pass a higher navToleranceBps on the sync, or use crosschain_transfer instead of sync.";
  }
  if (name === "EffectiveSupplyTooLow") {
    return "EffectiveSupplyTooLow — the vault's effective supply would fall below the on-chain minimum. Bridge a smaller amount.";
  }
  if (name === "SameChainTransfer") {
    return "SameChainTransfer — source and destination resolved to the same chain. Check the chain arguments.";
  }
  if (name === "InvalidQuoteTimestamp") {
    return "InvalidQuoteTimestamp — the bridge quote expired before submission. Retry to get a fresh quote.";
  }
  if (name === "OutputAmountTooLow") {
    return "OutputAmountTooLow — the bridge output is below the minimum required by the solver. Try a larger amount or a different route.";
  }
  if (name === "OutputAmountTooHigh") {
    return "OutputAmountTooHigh — the bridge output exceeds what the solver can cover.";
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
 *
 * Only matches hex strings that are explicitly labelled as revert data, e.g.
 *   "revert data: 0x08c379a0..."
 *   "revert reason: 0x08c379a0..."
 *   "execution reverted: 0x08c379a0..."
 *
 * This avoids mistaking the original transaction calldata (which viem prints in
 * "Raw Call Arguments: data: 0x...") for a revert reason.
 */
export function extractRevertData(raw: string): string | null {
  const matches = raw.matchAll(
    /(?:revert data:|revert reason:|execution reverted:)\s*(0x[0-9a-fA-F]{8,})/gi,
  );
  for (const match of matches) {
    const hex = match[1];
    // Exclude Ethereum addresses (42 chars) — we want revert payloads, not addresses.
    if (hex.length !== 42) return hex.toLowerCase();
  }
  return null;
}

/**
 * Walk a viem / RPC error object and extract any raw revert-data payload.
 * RPC providers put the revert hex in different places (data, error.data,
 * cause.data, details string, etc.), so we check all of them.
 */
export function getRevertDataFromError(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;

  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;

    const candidates = [
      record.data,
      (record.error as Record<string, unknown> | undefined)?.data,
      (record.cause as Record<string, unknown> | undefined)?.data,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) {
        return candidate.toLowerCase();
      }
    }

    // Some providers embed the revert data inside the message/details string.
    for (const key of ["message", "details", "shortMessage"]) {
      const val = record[key];
      if (typeof val === "string") {
        const extracted = extractRevertData(val);
        if (extracted) return extracted;
      }
    }

    current = record.cause ?? record.error;
  }

  return null;
}
