/**
 * Shared types for the Rigoblock OpenClaw skill.
 */

// ─── API Response Types ─────────────────────────────────────────────────────

export interface QuoteResponse {
  sell: string;
  buy: string;
  price: string;
  routing: string;
  gasFeeUSD: string;
  gasLimit: string;
  chainId: number;
}

export interface ChatResponse {
  reply: string;
  transaction?: TransactionData;
  executionResult?: ExecutionResult;
}

export interface TransactionData {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description: string;
}

export interface ExecutionResult {
  txHash: string;
  confirmed: boolean;
  explorerUrl: string;
}

// ─── Tool Parameter Types ───────────────────────────────────────────────────

export interface QuoteParams {
  sell: string;
  buy: string;
  amount: string;
  chain?: string;
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  chain?: string;
  dex?: "uniswap" | "0x";
}

export interface AddLiquidityParams {
  token0: string;
  token1: string;
  amount0: string;
  amount1: string;
  tickLower?: number;
  tickUpper?: number;
  chain: string;
}

export interface RemoveLiquidityParams {
  positionId: string;
  chain: string;
}

export interface GmxOpenParams {
  market: string;
  direction: "long" | "short";
  collateral: string;
  collateralAmount: string;
  leverage?: number;
}

export interface GmxCloseParams {
  market: string;
  direction: "long" | "short";
}

export interface BridgeParams {
  token: string;
  amount: string;
  fromChain: string;
  toChain: string;
}

export interface VaultInfoParams {
  chain?: string;
}

// ─── Strategy Types ─────────────────────────────────────────────────────────

export type StrategyName = "carry-trade" | "lp-hedge";

export interface CarryTradeParams {
  allocation: number; // % of USDT to deploy (0-1)
  hedgeRatio: number; // target perp/spot ratio (default 1.0)
  rebalanceThreshold: number; // drift % before rebalancing (default 0.02)
  minFundingRate: number; // min hourly funding to stay (default 0.00005)
  exitAfterNegativeHours: number; // hours of negative funding (default 6)
}

export interface LpHedgeParams {
  xautAllocation: number; // % of deployed USDT → XAUT (default 0.4)
  bridgeAllocation: number; // % bridged to Arbitrum (default 0.1)
  lpRange: "wide" | "medium" | "narrow";
  hedgeRatio: number; // target hedge coverage (default 1.0)
  rebalanceThreshold: number; // hedge drift % (default 0.02)
  maxHedgeCost: number; // max negative funding %/h (default -0.0001)
}

// ─── Client Config ──────────────────────────────────────────────────────────

export interface RigoblockClientConfig {
  baseUrl: string;
  vaultAddress: string;
  chainId: number;
  operatorAddress?: string;
  authSignature?: string;
  authTimestamp?: number;
  executionMode: "manual" | "delegated";
}
