/**
 * Vault Tool Handlers
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
  resolveChainArg, resolveChainName, resolveSlippage, formatRawAmount, runSwapShield, executeToolCall,
} from "../client.js";

export async function handle_get_vault_info(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const info = await getVaultInfo(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);

  // Fetch NAV data for richer display
  const navInfo = await getNavData(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY)
    .catch(() => null);

  const decimals = info.decimals ?? 18;
  const supplyFormatted = parseFloat(info.totalSupply).toFixed(4);
  const unitaryFormatted = navInfo
    ? (Number(navInfo.unitaryValue) / (10 ** decimals)).toFixed(6)
    : "N/A";
  const totalValueFormatted = navInfo
    ? (Number(navInfo.totalValue) / (10 ** decimals)).toFixed(6)
    : "N/A";

  const chainLabel = resolveChainName(ctx.chainId);

  return {
    message: [
      `**${info.name}** (${info.symbol}) on ${chainLabel}`,
      `Supply: ${supplyFormatted} | Unitary value: ${unitaryFormatted} | Total value: ${totalValueFormatted}`,
    ].join("\n"),
    selfContained: true,
  };

}

export async function handle_get_token_balance(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const tokenAddress = await resolveTokenAddress(
    ctx.chainId,
    args.token as string,
  );
  const { balance, decimals, symbol } = await getVaultTokenBalance(
    ctx.chainId,
    ctx.vaultAddress as Address,
    tokenAddress as Address,
    env.ALCHEMY_API_KEY,
  );
  const formatted = Number(balance) / 10 ** decimals;
  return { message: `Vault holds ${formatted.toFixed(6)} ${symbol}`, selfContained: true };

}

export async function handle_verify_bridge_arrival(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const tokenArg = args.token as string;
  const chainArg = args.chain as string;
  const minAmountStr = args.minAmount as string;

  const targetChainId = resolveChainArg(chainArg.trim()).id;
  const targetChainName = resolveChainName(targetChainId);
  const tokenAddress = await resolveTokenAddress(targetChainId, tokenArg);
  const minAmount = parseFloat(minAmountStr);

  // Snapshot balance BEFORE polling — so we detect actual increase,
  // not a pre-existing balance that already exceeds minAmount.
  const { balance: initialBal, decimals, symbol } = await getVaultTokenBalance(
    targetChainId,
    ctx.vaultAddress as Address,
    tokenAddress as Address,
    env.ALCHEMY_API_KEY,
  );
  const initialAmount = Number(initialBal) / 10 ** decimals;

  const MAX_POLLS = 10;    // 10 × 3s = 30s max
  const POLL_INTERVAL = 3000;

  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    if (attempt > 1) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
    const { balance } = await getVaultTokenBalance(
      targetChainId,
      ctx.vaultAddress as Address,
      tokenAddress as Address,
      env.ALCHEMY_API_KEY,
    );
    const current = Number(balance) / 10 ** decimals;
    const increase = current - initialAmount;
    if (increase >= minAmount * 0.90) {
      // Accept if increase is ≥ 90% of expected (bridge fees reduce the output)
      return {
        message: `✅ Bridge complete! ${increase.toFixed(6)} ${symbol} arrived on ${targetChainName} (vault now holds ${current.toFixed(6)} ${symbol}). Ready to proceed.`,
      };
    }
  }

  // Timed out — funds may still be in transit
  const { balance: finalBal } = await getVaultTokenBalance(
    targetChainId,
    ctx.vaultAddress as Address,
    tokenAddress as Address,
    env.ALCHEMY_API_KEY,
  );
  const finalAmount = Number(finalBal) / 10 ** decimals;
  const totalIncrease = finalAmount - initialAmount;
  return {
    message: `⏳ Bridge still in progress after 30s. Balance increased by ${totalIncrease.toFixed(6)} ${symbol} on ${targetChainName} (current: ${finalAmount.toFixed(6)}, expected increase ≥${minAmountStr}). The bridge may take longer — Across fills can take minutes. Check the balance again after waiting.`,
  };

}

export async function handle_switch_chain(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const match = resolveChainArg((args.chain as string).trim());
  return {
    message: `Switched to ${match.name} (chain ${match.id}). All subsequent operations will use this chain.`,
    chainSwitch: match.id,
  };

}

