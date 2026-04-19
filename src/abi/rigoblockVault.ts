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

  // ── NAV view (ENavView extension) ──

  // getNavDataView() → (uint256 totalValue, uint256 unitaryValue, uint256 timestamp)
  {
    name: "getNavDataView",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "navData",
        type: "tuple",
        components: [
          { name: "totalValue", type: "uint256" },
          { name: "unitaryValue", type: "uint256" },
          { name: "timestamp", type: "uint256" },
        ],
      },
    ],
  },

  // ── Multicall (AMulticall adapter) ──

  // multicall(bytes[] data) → bytes[]
  {
    name: "multicall",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },

  // ── Pool data views (ISmartPoolState — V4) ──

  // getPool() → ReturnedPool { name, symbol, decimals, owner, baseToken }
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "pool",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "decimals", type: "uint8" },
          { name: "owner", type: "address" },
          { name: "baseToken", type: "address" },
        ],
      },
    ],
  },

  // getPoolTokens() → PoolTokens { unitaryValue, totalSupply }
  {
    name: "getPoolTokens",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "poolTokens",
        type: "tuple",
        components: [
          { name: "unitaryValue", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
        ],
      },
    ],
  },

  // updateUnitaryValue() → NetAssetsValue { unitaryValue, netTotalValue, netTotalLiabilities }
  // Non-view function — called via eth_call (simulateContract) to get live NAV
  // that accounts for virtual supply from crosschain transfers.
  // The function is permissionless ("allows anyone to store an up-to-date pool price").
  {
    name: "updateUnitaryValue",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [
      {
        name: "navParams",
        type: "tuple",
        components: [
          { name: "unitaryValue", type: "uint256" },
          { name: "netTotalValue", type: "uint256" },
          { name: "netTotalLiabilities", type: "uint256" },
        ],
      },
    ],
  },

  // ── Capital provision (minting pool tokens) ──

  // mint(address recipient, uint256 amountIn, uint256 amountOutMin) payable
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ name: "recipientAmount", type: "uint256" }],
  },

  // burn(uint256 amountIn, uint256 amountOutMin)
  {
    name: "burn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ name: "netRevenue", type: "uint256" }],
  },

  // ── AIntents adapter — cross-chain transfers via Across Protocol ──

  // depositV3(AcrossParams params)
  {
    name: "depositV3",
    type: "function",
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

  // ── EApps extension — Uniswap v4 position tracking ──

  // getUniV4TokenIds() → uint256[]
  {
    name: "getUniV4TokenIds",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "tokenIds", type: "uint256[]" }],
  },

  // ── AStaking adapter — GRG staking (Ethereum mainnet) ──

  // stake(uint256 amount)
  {
    name: "stake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },

  // undelegateStake(uint256 amount) — must be called before unstake
  {
    name: "undelegateStake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },

  // unstake(uint256 amount)
  {
    name: "unstake",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },

  // withdrawDelegatorRewards()
  {
    name: "withdrawDelegatorRewards",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

/**
 * Vault delegation ABI — updateDelegation(), revokeAllDelegations(),
 * revokeAllDelegationsForSelector(), getDelegatedSelectors(), getDelegatedAddresses().
 *
 * New in v4.2.0: granular per-selector delegation where the operator batches
 * grant/revoke of (selector, address) pairs via updateDelegation().
 *
 * Source: https://github.com/RigoBlock/v3-contracts/pull/870
 */
export const VAULT_DELEGATION_ABI = [
  // ── Write methods (onlyOwner) ──

  // updateDelegation(Delegation[] calldata delegations)
  // Delegation = (address delegated, bytes4 selector, bool isDelegated)
  {
    name: "updateDelegation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "delegations",
        type: "tuple[]",
        components: [
          { name: "delegated", type: "address" },
          { name: "selector", type: "bytes4" },
          { name: "isDelegated", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },

  // revokeAllDelegations(address delegated)
  // Atomically revokes every selector previously delegated to `delegated`.
  {
    name: "revokeAllDelegations",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "delegated", type: "address" }],
    outputs: [],
  },

  // revokeAllDelegationsForSelector(bytes4 selector)
  // Atomically revokes all addresses delegated for `selector`.
  {
    name: "revokeAllDelegationsForSelector",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "selector", type: "bytes4" }],
    outputs: [],
  },

  // ── View methods ──

  // getDelegatedSelectors(address delegated) → bytes4[]
  {
    name: "getDelegatedSelectors",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "delegated", type: "address" }],
    outputs: [{ name: "selectors", type: "bytes4[]" }],
  },

  // getDelegatedAddresses(bytes4 selector) → address[]
  {
    name: "getDelegatedAddresses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "selector", type: "bytes4" }],
    outputs: [{ name: "addresses", type: "address[]" }],
  },
] as const;

/**
 * Function selectors the agent is allowed to call on the vault.
 * Used for vault-based delegation scoping.
 */
export const ALLOWED_VAULT_SELECTORS = {
  // execute(bytes,bytes[],uint256)
  executeWithDeadline: "0x3593564c" as `0x${string}`,
  // execute(bytes,bytes[])
  execute: "0x24856bc3" as `0x${string}`,
  // modifyLiquidities(bytes,uint256)
  modifyLiquidities: "0xdd46508f" as `0x${string}`,
  // ── Multicall variants (vault adapter wraps individual calls, each checked against its own selector) ──
  // multicall(bytes[])
  multicall: "0xac9650d8" as `0x${string}`,
  // multicall(uint256,bytes[])
  multicallDeadline: "0x5ae401dc" as `0x${string}`,
  // multicall(bytes32,bytes[])
  multicallHash: "0x1f0464d1" as `0x${string}`,
  // ── 0x Aggregator (IA0x / AllowanceHolder) ──
  // execute(address,address,uint256,address,bytes) — AllowanceHolder entry point
  zeroXExecute: "0x2213bc0b" as `0x${string}`,
  // ── GMX v2 Adapter (IAGmxV2) ──
  cancelOrder: "0x7489ec23" as `0x${string}`,
  claimCollateral: "0xe9249b57" as `0x${string}`,
  claimFundingFees: "0xc41b1ab3" as `0x${string}`,
  createDecreaseOrder: "0xe478512e" as `0x${string}`,
  createIncreaseOrder: "0x13b4312f" as `0x${string}`,
  updateOrder: "0xdd5baad2" as `0x${string}`,
  // ── AIntents Adapter (cross-chain) ──
  depositV3: "0x770d096f" as `0x${string}`,
  // ── AStaking Adapter (GRG staking) ──
  stake: "0xa694fc3a" as `0x${string}`,
  undelegateStake: "0x4aace835" as `0x${string}`,
  unstake: "0x2e17de78" as `0x${string}`,
  withdrawDelegatorRewards: "0xb880660b" as `0x${string}`,
};
