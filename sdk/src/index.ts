/**
 * @rigoblock/defi-sdk — TypeScript SDK for DeFi trading on Rigoblock vaults.
 *
 * Re-exports all public modules for use by external agents and browser integrations.
 */

// Client
export { RigoblockClient } from "./client.js";

// WDK Wallet (Tether WDK integration for wallet creation, signing, x402)
export {
  RigoblockWallet,
  SecureWalletSession,
  createX402Fetch,
  setupRigoblockClient,
  setupSecureClient,
  saveEncryptedStore,
  loadEncryptedStore,
} from "./wallet.js";
export type {
  WdkWalletConfig,
  WdkWalletInfo,
  OperatorAuth,
  EncryptedWalletStore,
  SetupOptions,
  SetupResult,
  SecureSetupOptions,
  SecureSetupResult,
} from "./wallet.js";

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

// Strategies (orchestration engines)
export {
  enterCarryTrade,
  exitCarryTrade,
  enterLpHedge,
  exitLpHedge,
  composeStrategy,
} from "./strategies.js";
export type {
  StrategyStep,
  StrategyResult,
  CompositorInput,
  CompositorResult,
} from "./strategies.js";

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
  StrategyName,
  CarryTradeParams,
  LpHedgeParams,
  RigoblockClientConfig,
} from "./types.js";
