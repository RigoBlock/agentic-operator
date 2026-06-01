/**
 * Strategy Tool Handlers
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

export async function handle_list_strategies(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const { getTwapOrders } = await import("../../skills/twap.js");
  const twapOrders = (await getTwapOrders(env.KV, ctx.vaultAddress)).filter((o) => o.active);

  if (twapOrders.length === 0) {
    return {
      message: "No active TWAP strategies configured for this vault.",
      suggestions: ["Create a TWAP order"],
    };
  }

  const twapLines = twapOrders.map((o) => {
    const side = o.side || "sell";
    const direction = side === "buy"
      ? `Buy ${o.totalAmount} ${o.buyToken} with ${o.sellToken}`
      : `Sell ${o.totalAmount} ${o.sellToken} for ${o.buyToken}`;
    return (
      `  **TWAP #${o.id}** [🔄 Active] every ${o.intervalMinutes}m\n` +
      `    "${direction}"\n` +
      `    Progress: ${o.slicesExecuted}/${o.sliceCount} slices | DEX: ${o.dex}`
    );
  });

  return {
    message:
      `📋 **Active Strategies (TWAP only)** (${twapOrders.length} total):\n\n` +
      twapLines.join("\n\n"),
    suggestions: [
      "Create a TWAP order",
      twapOrders.length > 0 ? `Cancel TWAP order ${twapOrders[0].id}` : "",
    ].filter(Boolean),
  };

}

export async function handle_cancel_nav_sync(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const { handleSkillToolCall } = await import("../../skills/index.js");
  const result = await handleSkillToolCall(toolName, args, env, ctx);
  if (!result) throw new Error(`Skill handler not found for ${toolName}`);
  return result;

}

