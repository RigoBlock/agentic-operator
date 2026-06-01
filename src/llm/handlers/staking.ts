/**
 * Staking Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import { STAKING_PROXY } from "../../config.js";
import { type Address } from "viem";
import {
  buildStakeCalldata, buildUndelegateStakeCalldata, buildUnstakeCalldata,
  buildEndEpochCalldata, buildWithdrawDelegatorRewardsCalldata,
} from "../../services/grgStaking.js";
import { estimateGas } from "../client.js";

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

