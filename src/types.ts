/** Shared type definitions */

import type { Address, Hex } from "viem";

// ── Execution modes ───────────────────────────────────────────────────
/**
 * How transactions are executed:
 * - "manual"    → Agent builds unsigned tx, operator signs in browser wallet (default)
 * - "delegated" → Agent wallet executes via EIP-7702 delegation after user confirms details
 */
export type ExecutionMode = "manual" | "delegated";

// ── Environment bindings ──────────────────────────────────────────────
export interface Env {
  // KV namespace (stores per-user vault lists, delegation config, agent wallets)
  KV: KVNamespace;

  // Vars (wrangler.toml [vars])
  // No more VAULT_ADDRESS / CHAIN_ID here — they come from the frontend per-request.

  // Secrets (wrangler secret put)
  OPENAI_API_KEY: string;
  UNISWAP_API_KEY: string;  // Uniswap Trading API key (developers.uniswap.org)
  ZEROX_API_KEY: string;    // 0x Swap API key (dashboard.0x.org)
  ALCHEMY_API_KEY: string;  // Alchemy RPC key (avoids public RPC rate limits)
  AGENT_WALLET_SECRET: string; // Encryption key for agent wallet private keys
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
  /** Execution mode: "manual" (default) or "delegated" (agent wallet executes) */
  executionMode?: ExecutionMode;
  /** When true in delegated mode, confirms the agent should execute the pending tx */
  confirmExecution?: boolean;
}

export interface ToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  error?: boolean;
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
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
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
  /** In delegated mode: transaction was executed by agent wallet */
  executionResult?: ExecutionResult;
}

// ── Agent Wallet ──────────────────────────────────────────────────────
/** Stored agent wallet info (private key is encrypted in KV) */
export interface AgentWalletInfo {
  /** Agent wallet address (EOA) */
  address: Address;
  /** Vault address this agent wallet is associated with */
  vaultAddress: Address;
  /** Chain IDs where delegation has been set up */
  delegatedChains: number[];
  /** Timestamp of creation */
  createdAt: number;
}

// ── Delegation ────────────────────────────────────────────────────────
/** Delegation configuration for a vault */
export interface DelegationConfig {
  /** Whether delegated execution is enabled */
  enabled: boolean;
  /** The agent wallet address that has delegation */
  agentAddress: Address;
  /** Operator address who granted delegation */
  operatorAddress: Address;
  /** Vault address */
  vaultAddress: Address;
  /** Allowed function selectors on the vault (e.g., execute, modifyLiquidities) */
  allowedSelectors: Hex[];
  /** Chains on which delegation is active */
  activeChains: number[];
  /** Expiry timestamp (0 = no expiry, managed by on-chain delegation) */
  expiresAt: number;
}

/** Result of an agent-executed transaction (delegated mode) */
export interface ExecutionResult {
  /** Transaction hash */
  txHash: Hex;
  /** Chain the tx was executed on */
  chainId: number;
  /** Whether the tx was confirmed */
  confirmed: boolean;
  /** Block number if confirmed */
  blockNumber?: number;
  /** Block explorer URL */
  explorerUrl?: string;
}

// ── Request context (per-request, not env) ────────────────────────────
export interface RequestContext {
  vaultAddress: Address;
  chainId: number;
  operatorAddress?: Address;
  /** Execution mode for this request */
  executionMode?: ExecutionMode;
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
