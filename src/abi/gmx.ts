/**
 * GMX v2 Synthetics ABIs — Rigoblock Adapter Interface (IAGmxV2)
 *
 * The Rigoblock vault exposes these GMX functions through its adapter system.
 * Calls are sent TO the vault address; the protocol routes them to GMX via delegatecall.
 *
 * Important: GMX normally uses multicall to batch sendWnt + createOrder.
 * Rigoblock's adapter handles WETH wrapping/transfers internally, so we never
 * use GMX's multicall. Instead we call createIncreaseOrder / createDecreaseOrder
 * directly on the vault. The adapter computes execution fees on-chain.
 *
 * Implemented selectors (from IAGmxV2):
 *   0x7489ec23  cancelOrder(bytes32)
 *   0xe9249b57  claimCollateral(address[],address[],address[],address)  -- note: Rigoblock uses uint256[] for timeKeys
 *   0xc41b1ab3  claimFundingFees(address[],address[],address)
 *   0xe478512e  createDecreaseOrder(CreateOrderParams)
 *   0x13b4312f  createIncreaseOrder(CreateOrderParams)
 *   0xdd5baad2  updateOrder(bytes32,uint256,uint256,uint256,uint256,uint256,bool)
 *
 * Fields overridden by the adapter (caller values ignored):
 *   - receiver, cancellationReceiver, callbackContract → pool address
 *   - uiFeeReceiver → address(0)
 *   - swapPath → empty
 *   - executionFee → computed on-chain
 *   - callbackGasLimit → 0
 *   - shouldUnwrapNativeToken → false
 *   - referralCode → bytes32(0)
 *   - decreasePositionSwapType → NoSwap (for decrease orders)
 *   - orderType → MarketIncrease (for increase) or must be MarketDecrease/LimitDecrease/StopLossDecrease
 */

// ── CreateOrderParams ABI tuple (IBaseOrderUtils.CreateOrderParams) ──

export const GMX_CREATE_ORDER_PARAMS_TUPLE = {
  type: "tuple",
  components: [
    {
      name: "addresses",
      type: "tuple",
      components: [
        { name: "receiver", type: "address" },
        { name: "cancellationReceiver", type: "address" },
        { name: "callbackContract", type: "address" },
        { name: "uiFeeReceiver", type: "address" },
        { name: "market", type: "address" },
        { name: "initialCollateralToken", type: "address" },
        { name: "swapPath", type: "address[]" },
      ],
    },
    {
      name: "numbers",
      type: "tuple",
      components: [
        { name: "sizeDeltaUsd", type: "uint256" },
        { name: "initialCollateralDeltaAmount", type: "uint256" },
        { name: "triggerPrice", type: "uint256" },
        { name: "acceptablePrice", type: "uint256" },
        { name: "executionFee", type: "uint256" },
        { name: "callbackGasLimit", type: "uint256" },
        { name: "minOutputAmount", type: "uint256" },
        { name: "validFromTime", type: "uint256" },
      ],
    },
    { name: "orderType", type: "uint8" },
    { name: "decreasePositionSwapType", type: "uint8" },
    { name: "isLong", type: "bool" },
    { name: "shouldUnwrapNativeToken", type: "bool" },
    { name: "autoCancel", type: "bool" },
    { name: "referralCode", type: "bytes32" },
    { name: "dataList", type: "bytes32[]" },
  ],
} as const;

// ── Rigoblock Vault GMX Adapter ABI (IAGmxV2) ──

export const RIGOBLOCK_GMX_ABI = [
  // createIncreaseOrder(CreateOrderParams) → bytes32
  {
    name: "createIncreaseOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "params", ...GMX_CREATE_ORDER_PARAMS_TUPLE }],
    outputs: [{ name: "orderKey", type: "bytes32" }],
  },

  // createDecreaseOrder(CreateOrderParams) → bytes32
  {
    name: "createDecreaseOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "params", ...GMX_CREATE_ORDER_PARAMS_TUPLE }],
    outputs: [{ name: "orderKey", type: "bytes32" }],
  },

  // updateOrder(bytes32,uint256,uint256,uint256,uint256,uint256,bool)
  {
    name: "updateOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "sizeDeltaUsd", type: "uint256" },
      { name: "acceptablePrice", type: "uint256" },
      { name: "triggerPrice", type: "uint256" },
      { name: "minOutputAmount", type: "uint256" },
      { name: "validFromTime", type: "uint256" },
      { name: "autoCancel", type: "bool" },
    ],
    outputs: [],
  },

  // cancelOrder(bytes32)
  {
    name: "cancelOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [],
  },

  // claimFundingFees(address[],address[],address)
  {
    name: "claimFundingFees",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "markets", type: "address[]" },
      { name: "tokens", type: "address[]" },
      { name: "receiver", type: "address" },
    ],
    outputs: [],
  },

  // claimCollateral(address[],address[],uint256[],address)
  {
    name: "claimCollateral",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "markets", type: "address[]" },
      { name: "tokens", type: "address[]" },
      { name: "timeKeys", type: "uint256[]" },
      { name: "receiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

// ── GMX Reader ABI (direct contract reads on Arbitrum) ──

export const GMX_READER_ABI = [
  // getAccountPositions(address dataStore, address account, uint256 start, uint256 end)
  {
    name: "getAccountPositions",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "account", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          {
            name: "addresses",
            type: "tuple",
            components: [
              { name: "account", type: "address" },
              { name: "market", type: "address" },
              { name: "collateralToken", type: "address" },
            ],
          },
          {
            name: "numbers",
            type: "tuple",
            components: [
              { name: "sizeInUsd", type: "uint256" },
              { name: "sizeInTokens", type: "uint256" },
              { name: "collateralAmount", type: "uint256" },
              { name: "borrowingFactor", type: "uint256" },
              { name: "fundingFeeAmountPerSize", type: "uint256" },
              { name: "longTokenClaimableFundingAmountPerSize", type: "uint256" },
              { name: "shortTokenClaimableFundingAmountPerSize", type: "uint256" },
              { name: "increasedAtTime", type: "uint256" },
              { name: "decreasedAtTime", type: "uint256" },
              { name: "increasedAtBlock", type: "uint256" },
              { name: "decreasedAtBlock", type: "uint256" },
            ],
          },
          {
            name: "flags",
            type: "tuple",
            components: [{ name: "isLong", type: "bool" }],
          },
        ],
      },
    ],
  },

  // getAccountOrders(address dataStore, address account, uint256 start, uint256 end)
  {
    name: "getAccountOrders",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "account", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "orderKey", type: "bytes32" },
          {
            name: "order",
            type: "tuple",
            components: [
              {
                name: "addresses",
                type: "tuple",
                components: [
                  { name: "account", type: "address" },
                  { name: "receiver", type: "address" },
                  { name: "cancellationReceiver", type: "address" },
                  { name: "callbackContract", type: "address" },
                  { name: "uiFeeReceiver", type: "address" },
                  { name: "market", type: "address" },
                  { name: "initialCollateralToken", type: "address" },
                  { name: "swapPath", type: "address[]" },
                ],
              },
              {
                name: "numbers",
                type: "tuple",
                components: [
                  { name: "orderType", type: "uint8" },
                  { name: "decreasePositionSwapType", type: "uint8" },
                  { name: "sizeDeltaUsd", type: "uint256" },
                  { name: "initialCollateralDeltaAmount", type: "uint256" },
                  { name: "triggerPrice", type: "uint256" },
                  { name: "acceptablePrice", type: "uint256" },
                  { name: "executionFee", type: "uint256" },
                  { name: "callbackGasLimit", type: "uint256" },
                  { name: "minOutputAmount", type: "uint256" },
                  { name: "updatedAtBlock", type: "uint256" },
                  { name: "updatedAtTime", type: "uint256" },
                ],
              },
              {
                name: "flags",
                type: "tuple",
                components: [
                  { name: "isLong", type: "bool" },
                  { name: "shouldUnwrapNativeToken", type: "bool" },
                  { name: "isFrozen", type: "bool" },
                  { name: "autoCancel", type: "bool" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  // getMarket(address dataStore, address market)
  {
    name: "getMarket",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "market", type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "marketToken", type: "address" },
          { name: "indexToken", type: "address" },
          { name: "longToken", type: "address" },
          { name: "shortToken", type: "address" },
        ],
      },
    ],
  },

  // getMarkets(address dataStore, uint256 start, uint256 end)
  {
    name: "getMarkets",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "marketToken", type: "address" },
          { name: "indexToken", type: "address" },
          { name: "longToken", type: "address" },
          { name: "shortToken", type: "address" },
        ],
      },
    ],
  },
] as const;

// ── GMX Chainlink Price Feed Provider ABI ──

export const GMX_CHAINLINK_PRICE_FEED_ABI = [
  {
    name: "getOraclePrice",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "min", type: "uint256" },
          { name: "max", type: "uint256" },
          { name: "timestamp", type: "uint256" },
          { name: "blockNumber", type: "uint256" },
        ],
      },
    ],
  },
] as const;

// ── GMX Contract Addresses (Arbitrum One) ──

export const GMX_ADDRESSES = {
  EXCHANGE_ROUTER: "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41" as `0x${string}`,
  DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8" as `0x${string}`,
  READER: "0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789" as `0x${string}`,
  CHAINLINK_PRICE_FEED: "0x38B8dB61b724b51e42A88Cb8eC564CD685a0f53B" as `0x${string}`,
  REFERRAL_STORAGE: "0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d" as `0x${string}`,
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as `0x${string}`,
} as const;

// ── GMX Order Types ──

export enum GmxOrderType {
  MarketSwap = 0,
  LimitSwap = 1,
  MarketIncrease = 2,
  LimitIncrease = 3,
  MarketDecrease = 4,
  LimitDecrease = 5,
  StopLossDecrease = 6,
  Liquidation = 7,
}

export enum GmxDecreasePositionSwapType {
  NoSwap = 0,
  SwapPnlTokenToCollateralToken = 1,
  SwapCollateralTokenToPnlToken = 2,
}

// ── GMX REST API URL ──

export const GMX_API_URL = "https://arbitrum-api.gmxinfra.io";

// ── Arbitrum chain ID ──

export const ARBITRUM_CHAIN_ID = 42161;
