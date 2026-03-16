/**
 * @rigoblock/openclaw-defi — OpenClaw skill for DeFi trading on Rigoblock vaults.
 *
 * Re-exports all public modules for use by the OpenClaw agent runtime.
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
  rigoblockStakeGrg,
  rigoblockVaultInfo,
  rigoblockAggregatedNav,
  rigoblockSimulateStaking,
} from "./tools.js";
export type { ToolResult } from "./tools.js";

// Strategies (orchestration engines)
export {
  enterCarryTrade,
  exitCarryTrade,
  enterLpHedge,
  exitLpHedge,
  enterGrgStaking,
  composeStrategy,
} from "./strategies.js";
export type {
  StrategyStep,
  StrategyResult,
  StakingEntryInput,
  CompositorInput,
  CompositorResult,
} from "./strategies.js";

// Staking simulation
export { simulateStaking } from "./staking.js";

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
  StakeGrgParams,
  VaultInfoParams,
  StakingSimulationInput,
  StakingSimulationPoint,
  StakingRecommendation,
  StakingSimulationResult,
  StrategyName,
  CarryTradeParams,
  LpHedgeParams,
  GrgStakingParams,
  RigoblockClientConfig,
} from "./types.js";
