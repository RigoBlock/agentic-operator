/**
 * Staking Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, TransactionDraft } from "../../types.js";
import type { ToolResult } from "../client.js";
import { STAKING_PROXY } from "../../config.js";
import { type Address } from "viem";
import {
  buildStakeCalldata, buildUndelegateStakeCalldata, buildUnstakeCalldata,
  buildEndEpochCalldata, buildWithdrawDelegatorRewardsCalldata,
} from "../../services/grgStaking.js";
import { txActionLine } from "../client.js";

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

  const transaction: TransactionDraft = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    description: `[GRG Staking] Stake ${amount} GRG`,
  };

  const action = txActionLine(ctx);
  return {
    message: [`✅ GRG Stake ready`, `Amount: ${amount} GRG`, `Chain: Ethereum`, ``, `💡 Staking earns operator rewards (30%+ share) and attracts third-party delegated stake.`, ...(action ? [action] : [])].join("\n"),
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

  const transaction: TransactionDraft = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    description: `[GRG Staking] Unstake ${amount} GRG`,
  };

  const action = txActionLine(ctx);
  return {
    message: [`✅ GRG Unstake ready`, `Amount: ${amount} GRG`, `Chain: Ethereum`, ``, `⚠️ Make sure you called undelegate first and waited for the epoch to end before unstaking.`, ...(action ? [action] : [])].join("\n"),
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

  const transaction: TransactionDraft = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    description: `[GRG Staking] Undelegate ${amount} GRG`,
  };

  const action = txActionLine(ctx);
  return {
    message: [`✅ GRG Undelegate ready`, `Amount: ${amount} GRG`, `Chain: Ethereum`, ``, `💡 After undelegation, wait for the current epoch to end, then call unstake to withdraw.`, ...(action ? [action] : [])].join("\n"),
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

  const transaction: TransactionDraft = {
    to: stakingProxy,
    data: calldata,
    value: "0x0",
    chainId: 1,
    description: `[GRG Staking] Finalize epoch on staking proxy`,
    operatorOnly: true,
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

  const transaction: TransactionDraft = {
    to: ctx.vaultAddress as Address,
    data: calldata,
    value: "0x0",
    chainId: 1,
    description: `[GRG Staking] Claim delegator rewards`,
  };

  const action = txActionLine(ctx);
  return {
    message: [`✅ Claim Rewards ready`, `Chain: Ethereum`, ``, `💡 This claims accumulated delegator staking rewards back to the vault.`, ...(action ? [action] : [])].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}
