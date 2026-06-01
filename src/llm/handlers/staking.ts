/**
 * Staking Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, SwapIntent, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import {
  getUniswapQuote, getUniswapSwapCalldata, formatUniswapQuoteForDisplay, calculateVaultGasLimit,
} from "../../services/uniswapTrading.js";
import { getZeroXQuote, formatZeroXQuoteForDisplay } from "../../services/zeroXTrading.js";
import {
  getVaultInfo, getVaultTokenBalance, encodeVaultExecute, getTokenDecimals, getPoolData, getNavData, encodeMint, getClient,
} from "../../services/vault.js";
import { resolveTokenAddress, resolveChainId, sanitizeError, STAKING_PROXY, getNativeTokenSymbol } from "../../config.js";
import { decodeFunctionData, encodeFunctionData, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { RIGOBLOCK_VAULT_ABI } from "../../abi/rigoblockVault.js";
import { POOL_FACTORY_ADDRESS, POOL_FACTORY_ABI } from "../../abi/poolFactory.js";
import { ERC20_ABI } from "../../abi/erc20.js";
import {
  prepareDelegation, prepareRevocation, prepareSelectiveRevocation,
  checkDelegationOnChain, buildDefaultSelectors, getDelegationConfig, revokeDelegationOnChain,
} from "../../services/delegation.js";
import { getAgentWalletInfo } from "../../services/agentWallet.js";
import {
  findGmxMarket, getGmxMarkets, getGmxTickers, getGmxTokenPrice,
  resolveGmxCollateral, getGmxTokenDecimals,
  buildCreateIncreaseOrderCalldata, buildCreateDecreaseOrderCalldata,
  buildUpdateOrderCalldata, buildCancelOrderCalldata, buildClaimFundingFeesCalldata,
} from "../../services/gmxTrading.js";
import { getGmxPositionsSummary, getGmxPositions } from "../../services/gmxPositions.js";
import { ARBITRUM_CHAIN_ID, GmxOrderType } from "../../abi/gmx.js";
import {
  getCrosschainQuote, buildCrosschainTransfer, buildCrosschainSync,
  getAggregatedNav, buildRebalancePlan, chainName as crosschainChainName,
} from "../../services/crosschain.js";
import {
  buildAddLiquidityTx, buildRemoveLiquidityTx, buildInitializePoolTx,
  getVaultLPPositions, buildCollectFeesTx, buildBurnPositionTx,
  getPoolInfoById, getPositionDirect, POOL_MANAGER,
} from "../../services/uniswapLP.js";
import {
  buildStakeCalldata, buildUndelegateStakeCalldata, buildUnstakeCalldata,
  buildEndEpochCalldata, buildWithdrawDelegatorRewardsCalldata,
} from "../../services/grgStaking.js";
import { checkNavImpact } from "../../services/navGuard.js";
import {
  checkSwapPrice, getSwapShieldTolerance, setSwapShieldTolerance, clearSwapShieldTolerance,
  getStoredSlippage, setStoredSlippage,
  DEFAULT_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, DEFAULT_MAX_DIVERGENCE_PCT,
} from "../../services/swapShield.js";
import { buildOraclePoolSwapTx } from "../../services/oraclePool.js";
import { AuthError } from "../../services/auth.js";
import {
  friendlyError, estimateGas, preCheckNavImpact,
  resolveChainArg, resolveChainName, resolveSlippage, runSwapShield, executeToolCall,
} from "../client.js";

export async function handle_grg_stake(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  // Staking is Ethereum mainnet only
  let chainSwitched: number | undefined;
  if (ctx.chainId !== 1) {
    ctx.chainId = 1;
    chainSwitched = 1;
  }

  const amount = args.amount as string;
  const calldata = buildStakeCalldata(amount);

  const gas = await estimateGas(
    1, ctx.vaultAddress as Address,
    calldata, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    gas,
    description: `[GRG Staking] Stake ${amount} GRG`,
  };

  return {
    message: `✅ GRG Stake ready\nAmount: ${amount} GRG\nChain: Ethereum\n\n💡 Staking earns operator rewards (30%+ share) and attracts third-party delegated stake.`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_grg_unstake(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  let chainSwitched: number | undefined;
  if (ctx.chainId !== 1) {
    ctx.chainId = 1;
    chainSwitched = 1;
  }

  const amount = args.amount as string;
  const calldata = buildUnstakeCalldata(amount);

  const gas = await estimateGas(
    1, ctx.vaultAddress as Address,
    calldata, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    gas,
    description: `[GRG Staking] Unstake ${amount} GRG`,
  };

  return {
    message: `✅ GRG Unstake ready\nAmount: ${amount} GRG\nChain: Ethereum\n\n⚠️ Make sure you called undelegate first and waited for the epoch to end before unstaking.`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_grg_undelegate_stake(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  let chainSwitched: number | undefined;
  if (ctx.chainId !== 1) {
    ctx.chainId = 1;
    chainSwitched = 1;
  }

  const amount = args.amount as string;
  const calldata = buildUndelegateStakeCalldata(amount);

  const gas = await estimateGas(
    1, ctx.vaultAddress as Address,
    calldata, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    gas,
    description: `[GRG Staking] Undelegate ${amount} GRG`,
  };

  return {
    message: `✅ GRG Undelegate ready\nAmount: ${amount} GRG\nChain: Ethereum\n\n💡 After undelegation, wait for the current epoch to end, then call unstake to withdraw.`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_grg_end_epoch(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  let chainSwitched: number | undefined;
  if (ctx.chainId !== 1) {
    ctx.chainId = 1;
    chainSwitched = 1;
  }

  const stakingProxy = STAKING_PROXY[1];
  if (!stakingProxy) {
    throw new Error("Staking proxy address not configured for Ethereum mainnet.");
  }

  const calldata = buildEndEpochCalldata();

  const gas = await estimateGas(
    1, stakingProxy,
    calldata, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
  );

  const transaction: UnsignedTransaction = {
    to: stakingProxy,
    data: calldata,
    value: "0x0",
    chainId: 1,
    gas,
    description: `[GRG Staking] Finalize epoch on staking proxy`,
  };

  return {
    message: `✅ End Epoch ready\nTarget: Staking Proxy (${stakingProxy})\nChain: Ethereum\n\n⚠️ This targets the staking proxy directly — sign from your wallet (cannot use delegation).`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_grg_claim_rewards(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  let chainSwitched: number | undefined;
  if (ctx.chainId !== 1) {
    ctx.chainId = 1;
    chainSwitched = 1;
  }

  const calldata = buildWithdrawDelegatorRewardsCalldata();

  const gas = await estimateGas(
    1, ctx.vaultAddress as Address,
    calldata, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "staking",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    gas,
    description: `[GRG Staking] Claim delegator rewards`,
  };

  return {
    message: `✅ Claim Rewards ready\nChain: Ethereum\n\n💡 This claims accumulated delegator staking rewards back to the vault.`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

