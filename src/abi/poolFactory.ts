/**
 * RigoblockPoolProxyFactory ABI — create new smart pool proxies.
 *
 * The factory deploys minimal proxies (EIP-1167) pointing to the Rigoblock pool
 * implementation. It is deployed deterministically at the same address across
 * all supported chains.
 *
 * Source: https://github.com/RigoBlock/v3-contracts/blob/development/contracts/protocol/core/RigoblockPoolProxyFactory.sol
 */

/** Deterministic factory address — same on all supported chains */
export const POOL_FACTORY_ADDRESS = "0x8DE8895ddD702d9a216E640966A98e08c9228f24" as const;

/**
 * Minimal ABI for pool creation.
 *
 * createPool(string name, string symbol, address baseToken) → address newPoolAddress
 * Selector: 0x1d7d13cc
 */
export const POOL_FACTORY_ABI = [
  {
    name: "createPool",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "baseToken", type: "address" },
    ],
    outputs: [{ name: "newPoolAddress", type: "address" }],
  },
] as const;
