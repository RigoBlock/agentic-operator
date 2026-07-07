/**
 * Delegation Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import { type Address, type Hex } from "viem";
import {
  prepareDelegation, prepareRevocation, prepareSelectiveRevocation,
  checkDelegationOnChain, buildDefaultSelectors, getDelegationConfig, revokeDelegationOnChain,
} from "../../services/delegation.js";
import { getAgentWalletInfo } from "../../services/agentWallet.js";
import { checkPendingTxForVault } from "../../services/execution.js";
import { resolveChainArg, resolveChainName } from "../client.js";

export async function handle_check_pending_tx(
  env: Env,
  ctx: RequestContext,
  _args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  const status = await checkPendingTxForVault(env, ctx.vaultAddress as string, ctx.chainId);

  if (!status) {
    return {
      message: `No pending transaction is recorded for this vault on chain ${ctx.chainId}. ` +
        `If you recently submitted a trade, it may have already confirmed or the record expired.`,
      selfContained: true,
    };
  }

  return {
    message: status.message,
    selfContained: true,
  };
}

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

  // Determine missing selectors via on-chain check — reused by both browser and x402 paths.
  // This is a single RPC call; result drives both the calldata and the display message.
  let onlySelectors: Hex[] | undefined;
  let isUpdate = false;
  const agentInfo = await getAgentWalletInfo(env.KV, ctx.vaultAddress as string);
  if (agentInfo?.address) {
    isUpdate = true;
    try {
      const { undelegatedSelectors } = await checkDelegationOnChain(
        ctx.chainId,
        ctx.vaultAddress as Address,
        agentInfo.address,
        buildDefaultSelectors(),
        env.ALCHEMY_API_KEY,
      );
      if (undelegatedSelectors.length > 0 && undelegatedSelectors.length < buildDefaultSelectors().length) {
        onlySelectors = undelegatedSelectors;
      }
    } catch { /* on-chain check failed — fall back to all selectors */ }
  }

  const result = await prepareDelegation(
    env,
    ctx.operatorAddress,
    ctx.vaultAddress as Address,
    ctx.chainId,
    onlySelectors,
  );

  const newSelectors = result.selectors; // already filtered to only missing ones

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.transaction.data,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
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

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: revocation.transaction.data,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
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

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.transaction.data,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
    description: result.transaction.description,
  };

  return {
    message: `✅ Selective Revocation ready\nRevoking ${selectorsToRevoke.length} selector(s) on ${chainName}\nSelectors: ${selectorsToRevoke.join(", ")}\n\n💡 Sign to revoke these specific delegated functions.`,
    transaction,
    chainSwitch: chainSwitched,
  };

}

