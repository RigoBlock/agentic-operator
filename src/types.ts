/** Shared type definitions */

import type { Address, Hex } from "viem";

// ── Environment bindings ──────────────────────────────────────────────
export interface Env {
  // KV namespace (stores per-user vault lists, future delegation config)
  KV: KVNamespace;

  // Vars (wrangler.toml [vars])
  // No more VAULT_ADDRESS / CHAIN_ID here — they come from the frontend per-request.

  // Secrets (wrangler secret put)
  OPENAI_API_KEY: string;
  UNISWAP_API_KEY: string; // Uniswap Trading API key (developers.uniswap.org)
  ZEROX_API_KEY: string;   // 0x Swap API key (dashboard.0x.org)
  ALCHEMY_API_KEY: string; // Alchemy RPC key (avoids public RPC rate limits)
}

// ── Chat types ────────────────────────────────────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** The vault address the operator is managing (from frontend) */
  vaultAddress: string;
  /** Chain ID the vault lives on (from frontend) */
  chainId: number;
  /** Operator's connected wallet address (from frontend) */
  operatorAddress?: string;
  /** EIP-191 signature proving wallet ownership */
  authSignature?: string;
  /** Timestamp used in the signed auth message (ms epoch) */
  authTimestamp?: number;
}

export interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

/** An unsigned transaction returned to the frontend for operator signing */
export interface UnsignedTransaction {
  to: Address;
  data: Hex;
  value: string;       // hex-encoded wei
  chainId: number;
  gas: string;          // hex-encoded gas limit
  description: string;  // human-readable summary for the confirm modal
  /** Structured swap metadata for the frontend to display on confirmation */
  swapMeta?: {
    sellAmount: string;   // human-readable
    sellToken: string;    // symbol
    buyAmount: string;    // human-readable
    buyToken: string;     // symbol
    price: string;        // "1 ETH = 3000.12 USDC"
    dex: string;          // "0x Aggregator" | "Uniswap"
  };
}

export interface ChatResponse {
  reply: string;
  toolCalls?: ToolCallResult[];
  /** If the agent built a transaction, the frontend should prompt signing */
  transaction?: UnsignedTransaction;
  /** If the agent switched chains, the frontend should update the selector */
  chainSwitch?: number;
  /** The DEX / API provider used in this response (e.g. "0x", "Uniswap") */
  dexProvider?: string;
}

// ── Swap intent ───────────────────────────────────────────────────────
export interface SwapIntent {
  tokenIn: string; // symbol or address
  tokenOut: string; // symbol or address
  amountIn?: string; // human-readable amount to sell (EXACT_INPUT)
  amountOut?: string; // human-readable amount to buy (EXACT_OUTPUT)
  slippageBps?: number; // basis points, default 100 (1%)
}

// ── Vault info ────────────────────────────────────────────────────────
export interface VaultInfo {
  address: Address;
  name: string;
  symbol: string;
  owner: Address;
  totalSupply: string;
}

// ── Request context (per-request, not env) ────────────────────────────
export interface RequestContext {
  vaultAddress: Address;
  chainId: number;
  operatorAddress?: Address;
}
