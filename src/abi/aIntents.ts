/**
 * AIntents adapter ABI — cross-chain transfers via Across Protocol.
 *
 * The vault delegates to the AIntents adapter which calls Across's SpokePool.depositV3().
 * Supports two operation types:
 *   - Transfer: moves tokens between chains, burns/mints virtual supply
 *   - Sync: synchronises NAV across chains without moving tokens
 *
 * @see https://github.com/RigoBlock/v3-contracts/blob/master/contracts/protocol/extensions/adapters/AIntents.sol
 */

export const AINTENTS_ABI = [
  // ── depositV3 — main entry point ────────────────────────────────────
  {
    type: "function",
    name: "depositV3",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "depositor", type: "address" },
          { name: "recipient", type: "address" },
          { name: "inputToken", type: "address" },
          { name: "outputToken", type: "address" },
          { name: "inputAmount", type: "uint256" },
          { name: "outputAmount", type: "uint256" },
          { name: "destinationChainId", type: "uint256" },
          { name: "exclusiveRelayer", type: "address" },
          { name: "quoteTimestamp", type: "uint32" },
          { name: "fillDeadline", type: "uint32" },
          { name: "exclusivityDeadline", type: "uint32" },
          { name: "message", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },

  // ── Events ──────────────────────────────────────────────────────────
  {
    type: "event",
    name: "CrossChainTransferInitiated",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "destinationChainId", type: "uint256", indexed: true },
      { name: "inputToken", type: "address", indexed: true },
      { name: "inputAmount", type: "uint256", indexed: false },
      { name: "opType", type: "uint8", indexed: false },
      { name: "escrow", type: "address", indexed: false },
    ],
  },
] as const;

/**
 * Across SpokePool ABI — only the methods we read (getCurrentTime for quoteTimestamp).
 */
export const ACROSS_SPOKE_POOL_ABI = [
  {
    type: "function",
    name: "getCurrentTime",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "fillDeadlineBuffer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
] as const;
