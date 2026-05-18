/**
 * @rigoblock/defi-sdk — TypeScript SDK for DeFi trading on Rigoblock vaults.
 *
 * Provides a typed HTTP client, x402-ready, for calling the Rigoblock
 * Agentic Operator API. Wallet creation is NOT included — agents bring
 * their own wallets (viem, ethers, CDP, etc.).
 */

// Client
export { RigoblockClient } from "./client.js";

// Tools (individual tool functions for the agent to invoke)
export {
  rigoblockQuote,
  rigoblockSwap,
  rigoblockAddLiquidity,
  rigoblockRemoveLiquidity,
  rigoblockGetLpPositions,
  rigoblockGmxOpen,
  rigoblockGmxClose,
  rigoblockGmxPositions,
  rigoblockBridge,
  rigoblockVaultInfo,
  rigoblockAggregatedNav,
} from "./tools.js";
export type { ToolResult } from "./tools.js";

// Types
export type {
  QuoteResponse,
  ChatResponse,
  TransactionData,
  ExecutionResult,
  QuoteParams,
  SwapParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
  GmxOpenParams,
  GmxCloseParams,
  BridgeParams,
  VaultInfoParams,
  RigoblockClientConfig,
  ChatOptions,
} from "./types.js";
