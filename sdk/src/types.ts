/**
 * Shared types for the Rigoblock DeFi SDK.
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
  /** DeepSeek R1 reasoning trace (contents of <think>...</think> block) */
  reasoning?: string;
  /** Ordered list of models that produced this output */
  modelsUsed?: string[];
  /** Model that authored the final natural-language output (or 'tooling') */
  finalModel?: string;
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

// ─── Client Config ──────────────────────────────────────────────────────────

export interface RigoblockClientConfig {
  baseUrl: string;
  vaultAddress: string;
  chainId: number;
  operatorAddress?: string;
  authSignature?: string;
  authTimestamp?: number;
  executionMode: "manual" | "delegated";
  routingMode?: "llama_only";
}

export interface ChatOptions {
  /** Optional per-request context snippets (e.g. markdown excerpts) injected server-side */
  contextDocs?: string[];
}
