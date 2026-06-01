/**
 * Settings Tool Handlers
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

export async function handle_set_default_slippage(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const raw = String(args.slippage ?? "").trim();
  let bps: number;
  const percentMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/i);
  const bpsMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*bps$/i);
  const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
    }
    bps = Math.round(num * 100);
  } else if (bpsMatch) {
    const num = parseFloat(bpsMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
    }
    if (!Number.isInteger(num)) {
      throw new Error(`Non-integer bps value '${raw}' is ambiguous — did you mean ${Math.round(num)}bps or ${num}%? Use the '%' suffix for percentages.`);
    }
    bps = num;
  } else if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid slippage value. Provide a positive number (e.g., '0.5%', '50bps', or '0.5').");
    }
    // Integers within the configured BPS range are treated as bps (e.g. "50" => 50 bps = 0.5%)
    // Small decimals and values outside BPS range are treated as percentages (e.g. "0.5" => 50 bps)
    if (Number.isInteger(num) && num >= MIN_SLIPPAGE_BPS && num <= MAX_SLIPPAGE_BPS) {
      bps = Math.round(num);
    } else {
      bps = Math.round(num * 100);
    }
  } else {
    throw new Error("Invalid slippage value. Use a positive number, optionally suffixed with '%' or 'bps' (e.g., '0.5%', '50bps', or '0.5').");
  }
  if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage must be between ${MIN_SLIPPAGE_BPS / 100}% and ${MAX_SLIPPAGE_BPS / 100}%. ` +
      `Got: ${bps / 100}% (${bps} bps).`,
    );
  }
  await setStoredSlippage(env.KV, ctx.operatorAddress!, bps);
  return {
    message: `✅ Default slippage set to ${bps / 100}% (${bps} bps). This applies to all future swaps until changed.`,
  };

}

export async function handle_set_swap_shield_tolerance(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const raw = String(args.tolerance ?? "").trim();
  let pct: number;
  const percentMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/i);
  const plainMatch = raw.match(/^([0-9]+(?:\.[0-9]+)?)$/);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid tolerance value. Provide a positive number (e.g., '30%' or '30').");
    }
    pct = num;
  } else if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (isNaN(num) || num <= 0) {
      throw new Error("Invalid tolerance value. Provide a positive number (e.g., '30%' or '30').");
    }
    pct = num;
  } else {
    throw new Error("Invalid tolerance format. Use a number like '30%' or '30'.");
  }
  await setSwapShieldTolerance(
    env.KV,
    ctx.operatorAddress!,
    pct,
  );
  return {
    message:
      `⚠️ Swap Shield tolerance temporarily set to ${pct}% for 10 minutes. ` +
      `Swaps will be allowed if the DEX quote diverges up to ${pct}% from the oracle price. ` +
      `The shield will reset to the default 5% automatically.\n\n` +
      `The NAV shield (10% max loss) still protects against catastrophic trades.`,
  };

}

export async function handle_enable_swap_shield(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  await clearSwapShieldTolerance(
    env.KV,
    ctx.operatorAddress!,
  );
  return {
    message: "✅ Swap Shield tolerance reset to default (5%). All swaps will be checked against oracle prices.",
  };

}

