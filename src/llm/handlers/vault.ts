/**
 * Vault Tool Handlers
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";
import { type Address } from "viem";
import { getVaultInfo, getVaultTokenBalance, getNavData } from "../../services/vault.js";
import { resolveTokenAddress } from "../../config.js";
import { resolveChainArg, resolveChainName } from "../client.js";

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
      `Supply: ${supplyFormatted} | Price: ${unitaryFormatted} | Total value: ${totalValueFormatted}`,
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
