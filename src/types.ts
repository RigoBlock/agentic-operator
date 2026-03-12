/** Shared type definitions */

import type { Address, Hex } from "viem";

// ── Execution modes ───────────────────────────────────────────────────
/**
 * How transactions are executed:
 * - "manual"    → Agent builds unsigned tx, operator signs in browser wallet (default)
 * - "delegated" → Agent wallet executes via EIP-7702 delegation after user confirms details
 */
export type ExecutionMode = "manual" | "delegated";

// ── Hono context variables (set by middleware, read by routes) ─────────
export type AppVariables = {
  /** Set to true by x402 middleware when payment is verified */
  x402Paid: boolean;
};

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
  ALCHEMY_GAS_POLICY_ID?: string; // Alchemy Gas Manager policy ID (optional, enables sponsored gas)
  TELEGRAM_BOT_TOKEN?: string; // Telegram Bot API token (optional, enables Telegram control)
  CDP_API_KEY_ID: string;      // Coinbase Developer Platform API key ID (x402 facilitator auth)
  CDP_API_KEY_SECRET: string;  // Coinbase Developer Platform API key secret (x402 facilitator auth)
}

// ── Telegram types ────────────────────────────────────────────────────

/** A Telegram-linked operator — stored in KV as `tg-user:{telegramUserId}` */
export interface TelegramUser {
  /** Telegram numeric user ID */
  telegramUserId: number;
  /** Telegram @username (for display) */
  username?: string;
  /** Linked Ethereum operator address (from web pairing) */
  operatorAddress: Address;
  /** Vaults the operator has paired */
  vaults: TelegramVaultLink[];
  /** Currently active vault index (into vaults[]) */
  activeVaultIndex: number;
  /** When this link was created (ms epoch) */
  pairedAt: number;
}

export interface TelegramVaultLink {
  address: Address;
  chainId: number;
  name: string;
}

/** A pending pairing code — stored in KV as `tg-pair:{code}` with 5 min TTL */
export interface TelegramPairingCode {
  code: string;
  operatorAddress: Address;
  vaultAddress: Address;
  vaultName: string;
  chainId: number;
  createdAt: number;
}

/** Per-user Telegram conversation state — stored in KV as `tg-conv:{telegramUserId}` */
export interface TelegramConversation {
  messages: ChatMessage[];
  /** Vault address for this conversation */
  vaultAddress: Address;
  /** Chain ID */
  chainId: number;
  /** Last activity timestamp (for TTL cleanup) */
  lastActivity: number;
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
  /** If the agent built a single transaction, the frontend should prompt signing */
  transaction?: UnsignedTransaction;
  /** If the agent built multiple transactions (multi-chain swap), all are included */
  transactions?: UnsignedTransaction[];
  /** If the agent switched chains, the frontend should update the selector */
  chainSwitch?: number;
  /** The DEX / API provider used in this response (e.g. "0x", "Uniswap") */
  dexProvider?: string;
  /** Quick-action suggestions shown as clickable chips */
  suggestions?: string[];
  /** In delegated mode: transaction was executed by agent wallet */
  executionResult?: ExecutionResult;
  /** In delegated mode with multiple txs: results for each */
  executionResults?: ExecutionResult[];
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
/**
 * Per-chain delegation state.
 *
 * The operator delegates specific vault function selectors to the agent wallet
 * by calling vault.updateDelegation(delegations) on-chain.
 * The vault checks its internal delegation mapping to authorize the agent.
 */
export interface ChainDelegation {
  /** Timestamp of when this chain's delegation was confirmed */
  confirmedAt: number;
  /** Function selectors the agent is delegated for on this chain */
  delegatedSelectors: Hex[];
  /** Transaction hash of the updateDelegation() call */
  delegateTxHash?: Hex;
}

/** Delegation configuration for a vault */
export interface DelegationConfig {
  /** Whether delegated execution is enabled globally */
  enabled: boolean;
  /** The agent wallet address that has delegation */
  agentAddress: Address;
  /** Operator address who granted delegation */
  operatorAddress: Address;
  /** Vault address (primary target) */
  vaultAddress: Address;
  /**
   * Whether to use gas-sponsored transactions via ERC-4337 bundler + paymaster.
   * When true (default), the agent wallet gas is paid by the Alchemy Gas Manager,
   * so the operator doesn't need to fund the agent wallet.
   * When false, the agent wallet pays gas directly (must be funded).
   * Requires ALCHEMY_GAS_POLICY_ID to be set in the environment.
   */
  sponsoredGas: boolean;
  /**
   * Per-chain delegation state — keys are stringified chain IDs.
   * Each chain must be set up independently (operator sends delegate() tx per chain).
   */
  chains: Record<string, ChainDelegation>;
}

/** Result of an agent-executed transaction (delegated mode) */
export interface ExecutionResult {
  /** Transaction hash */
  txHash: Hex;
  /** Chain the tx was executed on */
  chainId: number;
  /** Whether the tx was confirmed successfully (receipt.status === "success") */
  confirmed: boolean;
  /** Whether the tx was mined but reverted on-chain */
  reverted?: boolean;
  /** Block number if confirmed or reverted */
  blockNumber?: number;
  /** Block explorer URL */
  explorerUrl?: string;
  // ── Enhanced receipt details ──
  /** Gas units consumed */
  gasUsed?: string;
  /** Effective gas price (wei) */
  effectiveGasPrice?: string;
  /** Total gas cost in ETH (human-readable) */
  gasCostEth?: string;
  /** Whether this tx was gas-sponsored */
  sponsored?: boolean;
  /** UserOperation hash (when submitted via ERC-4337 bundler) */
  userOpHash?: Hex;
  /** Number of fee-bump resubmission attempts (0 = first try succeeded) */
  resubmitAttempts?: number;
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
