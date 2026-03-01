/**
 * Rigoblock Vault ABI — IAUniswapRouter interface
 *
 * The Rigoblock vault exposes the Uniswap Universal Router `execute` function
 * and the Position Manager `modifyLiquidities` function through its adapter/extension
 * system. Calls to these functions on the vault are automatically routed to the
 * correct Uniswap contracts by the Rigoblock protocol.
 *
 * Source: https://github.com/RigoBlock/v3-contracts/blob/development/contracts/protocol/extensions/adapters/interfaces/IAUniswapRouter.sol
 */
export const RIGOBLOCK_VAULT_ABI = [
  // ── IAUniswapRouter — Swap execution (Universal Router style) ──

  // execute(bytes commands, bytes[] inputs, uint256 deadline)
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },

  // execute(bytes commands, bytes[] inputs) — no deadline variant
  {
    name: "execute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
    ],
    outputs: [],
  },

  // ── IAUniswapRouter — Liquidity management (Position Manager) ──

  // modifyLiquidities(bytes unlockData, uint256 deadline)
  {
    name: "modifyLiquidities",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },

  // ── Core pool view functions ──

  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Function selectors the agent is allowed to call on the vault.
 * Used for EIP-7702 session key scoping.
 */
export const ALLOWED_VAULT_SELECTORS = {
  // execute(bytes,bytes[],uint256)
  executeWithDeadline: "0x3593564c" as `0x${string}`,
  // execute(bytes,bytes[])
  execute: "0x24856bc3" as `0x${string}`,
  // modifyLiquidities(bytes,uint256)
  modifyLiquidities: "0xee3e8b0e" as `0x${string}`,
};
