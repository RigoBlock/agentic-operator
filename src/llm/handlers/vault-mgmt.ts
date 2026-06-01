/**
 * Vault Mgmt Tool Handlers
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

export async function handle_deploy_smart_pool(
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
  const poolName = args.name as string;
  const poolSymbol = args.symbol as string;

  // Resolve base token — default to ETH (address(0))
  let baseTokenAddress: Address = "0x0000000000000000000000000000000000000000";
  const baseTokenArg = (args.baseToken as string) || "ETH";

  if (baseTokenArg.startsWith("0x") && baseTokenArg.length === 42) {
    baseTokenAddress = baseTokenArg as Address;
  } else if (baseTokenArg.toUpperCase() !== "ETH") {
    baseTokenAddress = await resolveTokenAddress(ctx.chainId, baseTokenArg) as Address;
  }

  const data = encodeFunctionData({
    abi: POOL_FACTORY_ABI,
    functionName: "createPool",
    args: [poolName, poolSymbol, baseTokenAddress],
  });

  const gas = await estimateGas(
    ctx.chainId, POOL_FACTORY_ADDRESS as Address,
    data, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "deploy",
  );

  const transaction: UnsignedTransaction = {
    to: POOL_FACTORY_ADDRESS as Address,
    data,
    value: "0x0",
    chainId: ctx.chainId,
    gas,
    description: `Deploy new Rigoblock pool: ${poolName} (${poolSymbol})`,
    operatorOnly: true,
  };

  const baseLabel = baseTokenArg.toUpperCase() === "ETH"
    ? "ETH (native)"
    : baseTokenArg.startsWith("0x")
      ? `${baseTokenArg.slice(0, 6)}…${baseTokenArg.slice(-4)}`
      : baseTokenArg.toUpperCase();

  const message = [
    "✅ Pool deployment ready",
    `Name: ${poolName}`,
    `Symbol: ${poolSymbol}`,
    `Base token: ${baseLabel}`,
    `Chain: ${chainName}`,
    `Factory: ${POOL_FACTORY_ADDRESS}`,
    "",
    "Sign this transaction to deploy your new smart pool.",
    "After deployment, the new pool address will appear in the transaction receipt.",
    "You can then paste it in the vault address field to start trading.",
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_fund_pool(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  if (!ctx.operatorAddress) {
    throw new Error("Wallet not connected. Connect your wallet first.");
  }

  const amountStr = args.amount as string;
  if (!amountStr) {
    throw new Error("Amount is required. Specify how much base token to deposit (e.g., '1.5' ETH).");
  }

  const recipient = (args.recipient as string) || ctx.operatorAddress;
  const chainName = resolveChainName(ctx.chainId);

  // 1. Read pool data (base token) and NAV in parallel
  const [poolData, navData] = await Promise.all([
    getPoolData(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY),
    getNavData(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY),
  ]);

  const baseToken = poolData.baseToken;
  const isNativeBase = baseToken.toLowerCase() === "0x0000000000000000000000000000000000000000";

  // 2. Resolve base token decimals and symbol
  let baseDecimals: number;
  let baseSymbol: string;
  if (isNativeBase) {
    baseDecimals = 18;
    // Determine native symbol based on chain
    const nativeSymbols: Record<number, string> = { 56: "BNB", 137: "POL" };
    baseSymbol = nativeSymbols[ctx.chainId] || "ETH";
  } else {
    baseDecimals = await getTokenDecimals(ctx.chainId, baseToken, env.ALCHEMY_API_KEY);
    const tokenInfo = await getVaultTokenBalance(ctx.chainId, ctx.vaultAddress as Address, baseToken as Address, env.ALCHEMY_API_KEY);
    baseSymbol = tokenInfo.symbol;
  }

  // 3. Parse amount to smallest units
  const amountInWei = parseUnits(amountStr, baseDecimals);

  // 4. Calculate amountOutMin from NAV with 5% slippage
  //    unitaryValue = price of 1 pool token in base token units (18 decimals)
  //    expectedPoolTokens = amountIn * 10^18 / unitaryValue
  //    amountOutMin = expectedPoolTokens * 0.95
  const unitaryValue = navData.unitaryValue;
  let amountOutMin: bigint;
  if (unitaryValue === 0n) {
    // First mint (empty pool) — no NAV yet, accept any amount
    amountOutMin = 0n;
  } else {
    const expectedPoolTokens = (amountInWei * (10n ** 18n)) / unitaryValue;
    amountOutMin = (expectedPoolTokens * 95n) / 100n; // 5% slippage
  }

  // Format for display
  const unitaryValueFormatted = unitaryValue > 0n
    ? formatUnits(unitaryValue, 18)
    : "N/A (first mint)";
  const expectedTokensFormatted = unitaryValue > 0n
    ? formatUnits((amountInWei * (10n ** 18n)) / unitaryValue, 18)
    : amountStr;
  const minTokensFormatted = formatUnits(amountOutMin, 18);

  // 5. Build the mint transaction
  const mintData = encodeMint(
    recipient as Address,
    amountInWei,
    amountOutMin,
  );

  if (isNativeBase) {
    // Native base token — send as msg.value, no approval needed
    const mintGas = await estimateGas(
      ctx.chainId, ctx.vaultAddress as Address,
      mintData as Hex, "0x" + amountInWei.toString(16),
      ctx.operatorAddress, env.ALCHEMY_API_KEY,
    );

    const transaction: UnsignedTransaction = {
      to: ctx.vaultAddress as Address,
      data: mintData,
      value: "0x" + amountInWei.toString(16),
      chainId: ctx.chainId,
      gas: mintGas,
      description: `Fund pool: deposit ${amountStr} ${baseSymbol} into ${poolData.name}`,
      operatorOnly: true,
    };

    const message = [
      `✅ Pool funding ready`,
      `Pool: ${poolData.name} (${poolData.symbol})`,
      `Deposit: ${amountStr} ${baseSymbol}`,
      `NAV per token: ${unitaryValueFormatted} ${baseSymbol}`,
      `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
      `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
      `Chain: ${chainName}`,
      `Recipient: ${recipient}`,
      "",
      "Sign this transaction to deposit capital and receive pool tokens.",
    ].join("\n");

    return { message, transaction };
  }

  // ERC-20 base token — need approve first, then mint
  // Build approve(vaultAddress, amountIn) on the base token
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ctx.vaultAddress as Address, amountInWei],
  });

  // Return the approve transaction first — the mint follows after approval
  const approveGas = await estimateGas(
    ctx.chainId, baseToken as Address,
    approveData, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "approve",
  );

  const transaction: UnsignedTransaction = {
    to: baseToken as Address,
    data: approveData,
    value: "0x0",
    chainId: ctx.chainId,
    gas: approveGas,
    description: `Approve ${amountStr} ${baseSymbol} for pool ${poolData.name}`,
    operatorOnly: true,
  };

  const message = [
    `✅ Pool funding ready (2 transactions)`,
    `Pool: ${poolData.name} (${poolData.symbol})`,
    `Deposit: ${amountStr} ${baseSymbol}`,
    `NAV per token: ${unitaryValueFormatted} ${baseSymbol}`,
    `Expected pool tokens: ~${parseFloat(expectedTokensFormatted).toFixed(6)} ${poolData.symbol}`,
    `Min pool tokens (5% slippage): ${parseFloat(minTokensFormatted).toFixed(6)} ${poolData.symbol}`,
    `Chain: ${chainName}`,
    `Recipient: ${recipient}`,
    "",
    `**Step 1/2:** Sign the approval transaction to allow the pool to transfer your ${baseSymbol}.`,
    "**Step 2/2:** After approval, you'll be prompted to sign the mint transaction.",
  ].join("\n");

  return { message, transaction };

}

