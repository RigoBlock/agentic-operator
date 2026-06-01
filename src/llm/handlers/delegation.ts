/**
 * Delegation Tool Handlers
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

export async function handle_setup_delegation(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  // Handle optional chain switch
  let chainSwitched: number | undefined;
  if (args.chain) {
    const match = resolveChainArg((args.chain as string).trim());
    if (match.id !== ctx.chainId) {
      ctx.chainId = match.id;
      chainSwitched = match.id;
    }
  }

  const chainName = resolveChainName(ctx.chainId);

  // Check if delegation already exists — if so, this is an "update" (add missing selectors)
  const existingConfig = await getDelegationConfig(env.KV, ctx.vaultAddress as string);
  const isUpdate = existingConfig?.enabled && !!existingConfig.chains?.[String(ctx.chainId)];
  const existingSelectors = existingConfig?.chains?.[String(ctx.chainId)]?.delegatedSelectors || [];

  const result = await prepareDelegation(
    env,
    ctx.operatorAddress,
    ctx.vaultAddress as Address,
    ctx.chainId,
  );

  // Compute which selectors are new vs already delegated
  const existingSet = new Set(existingSelectors.map(s => s.toLowerCase()));
  const newSelectors = result.selectors.filter(s => !existingSet.has(s.toLowerCase()));

  const gas = await estimateGas(
    ctx.chainId, ctx.vaultAddress as Address,
    result.transaction.data as Hex, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "delegation",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.transaction.data,
    value: "0x0",
    chainId: ctx.chainId,
    gas,
    description: result.transaction.description,
    operatorOnly: true,
  };

  const message = isUpdate
    ? [
        "🔄 Delegation update ready",
        `Agent wallet: ${result.agentAddress}`,
        `New selectors: ${newSelectors.length} (total: ${result.selectors.length})`,
        `Chain: ${chainName}`,
        "",
        newSelectors.length > 0
          ? "Sign this transaction to add the missing selectors. No need to revoke first — this is additive."
          : "All selectors are already delegated. Sign to confirm the current state on-chain.",
      ].join("\n")
    : [
        "✅ Delegation setup ready",
        `Agent wallet: ${result.agentAddress}`,
        `Selectors: ${result.selectors.length} vault functions`,
        `Chain: ${chainName}`,
        "",
        "Sign this transaction to grant the agent permission to execute trades on your vault.",
        "Note: Delegation is per-chain. You'll need to set it up separately on each chain you want to use.",
      ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_revoke_delegation(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  // Handle optional chain switch
  let chainSwitched: number | undefined;
  if (args.chain) {
    const match = resolveChainArg((args.chain as string).trim());
    if (match.id !== ctx.chainId) {
      ctx.chainId = match.id;
      chainSwitched = match.id;
    }
  }

  const chainName = resolveChainName(ctx.chainId);
  const revocation = await prepareRevocation(
    env,
    ctx.vaultAddress as Address,
    ctx.chainId,
  );

  // Clear KV delegation state so the UI reflects the revocation immediately
  // after the user broadcasts the on-chain tx. It's safe to clear before broadcast:
  // KV saying "not delegated" just means the agent won't attempt auto-execution
  // until delegation is explicitly re-set up.
  await revokeDelegationOnChain(env.KV, ctx.vaultAddress as string, ctx.chainId).catch(() => {});

  const gas = await estimateGas(
    ctx.chainId, ctx.vaultAddress as Address,
    revocation.transaction.data as Hex, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "delegation",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: revocation.transaction.data,
    value: "0x0",
    chainId: ctx.chainId,
    gas,
    description: revocation.transaction.description,
    operatorOnly: true,
  };

  const message = [
    "✅ Revocation ready",
    `Chain: ${chainName}`,
    "",
    "Sign this transaction to revoke the agent's delegation on your vault.",
    "After this, the agent will no longer be able to execute trades automatically.",
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_check_delegation_status(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  // Handle optional chain switch
  let chainSwitched: number | undefined;
  if (args.chain) {
    const match = resolveChainArg((args.chain as string).trim());
    if (match.id !== ctx.chainId) {
      ctx.chainId = match.id;
      chainSwitched = match.id;
    }
  }

  const chainName = resolveChainName(ctx.chainId);

  // Check KV config
  const config = await getDelegationConfig(env.KV, ctx.vaultAddress as string);
  const walletInfo = await getAgentWalletInfo(env.KV, ctx.vaultAddress as string);

  if (!walletInfo?.address) {
    return {
      message: `No agent wallet has been created for this vault yet.\nUse "set up delegation" to get started.`,
      chainSwitch: chainSwitched,
      suggestions: ["Set up delegation"],
    };
  }

  // On-chain verification
  const selectors = buildDefaultSelectors();
  const onChain = await checkDelegationOnChain(
    ctx.chainId,
    ctx.vaultAddress as Address,
    walletInfo.address,
    selectors,
    env.ALCHEMY_API_KEY,
  );

  const kvActive = config?.enabled && !!config.chains?.[String(ctx.chainId)];
  const activeChains = config ? Object.keys(config.chains || {}).map(Number) : [];

  const lines = [
    `🔍 Delegation Status — ${chainName}`,
    "─".repeat(35),
    `Agent wallet: ${walletInfo.address}`,
    `On-chain: ${onChain.allDelegated ? "✅ Fully delegated" : `⚠️ ${onChain.delegatedSelectors.length}/${selectors.length} selectors delegated`}`,
    `KV state: ${kvActive ? "✅ Active" : "❌ Inactive"}`,
    `Active chains: ${activeChains.length > 0 ? activeChains.map(id => resolveChainName(id)).join(", ") : "None"}`,
  ];

  if (onChain.undelegatedSelectors.length > 0 && onChain.delegatedSelectors.length > 0) {
    lines.push("", `Missing selectors: ${onChain.undelegatedSelectors.length} — re-run delegation setup to fix.`);
  }

  const suggestions: string[] = [];
  if (!onChain.allDelegated) {
    suggestions.push("Set up delegation");
  } else {
    suggestions.push("Revoke delegation");
  }

  return { message: lines.join("\n"), chainSwitch: chainSwitched, suggestions };

}

export async function handle_revoke_selectors(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  let chainSwitched: number | undefined;
  if (args.chain) {
    const match = resolveChainArg((args.chain as string).trim());
    if (match.id !== ctx.chainId) {
      ctx.chainId = match.id;
      chainSwitched = match.id;
    }
  }

  const walletInfo = await getAgentWalletInfo(env.KV, ctx.vaultAddress as string);
  if (!walletInfo?.address) {
    throw new Error("No agent wallet found for this vault. Nothing to revoke.");
  }

  const selectorsToRevoke = (args.selectors as string[]).map((s) => s as Hex);
  const chainName = resolveChainName(ctx.chainId);

  const result = await prepareSelectiveRevocation(
    env,
    ctx.vaultAddress as Address,
    walletInfo.address,
    selectorsToRevoke,
    ctx.chainId,
  );

  const gas = await estimateGas(
    ctx.chainId, ctx.vaultAddress as Address,
    result.transaction.data as Hex, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "delegation",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.transaction.data,
    value: "0x0",
    chainId: ctx.chainId,
    gas,
    description: result.transaction.description,
  };

  return {
    message: `✅ Selective Revocation ready\nRevoking ${selectorsToRevoke.length} selector(s) on ${chainName}\nSelectors: ${selectorsToRevoke.join(", ")}\n\n💡 Sign to revoke these specific delegated functions.`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

