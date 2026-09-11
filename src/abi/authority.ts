/**
 * Rigoblock Authority ABI — governance contract that maps adapter selectors
 * to adapter contracts. Same address on every chain.
 *
 * Used to resolve which vault function selectors are actually callable on a
 * chain: a selector with no mapping has no adapter there and must never be
 * delegated to the agent.
 */

export const AUTHORITY_ADDRESS =
  "0xe35129A1E0BdB913CF6Fd8332E9d3533b5F41472" as `0x${string}`;

export const AUTHORITY_ABI = [
  {
    type: "function",
    name: "getApplicationAdapter",
    inputs: [{ name: "selector", type: "bytes4" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;
