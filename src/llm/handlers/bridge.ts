/**
 * Bridge Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import { sanitizeError } from "../../config.js";
import { type Address, type Hex } from "viem";
import {
  getCrosschainQuote, buildCrosschainTransfer, buildCrosschainSync,
  getAggregatedNav, buildRebalancePlan, chainName as crosschainChainName,
} from "../../services/crosschain.js";
import {
  friendlyError, estimateGas, resolveChainArg, resolveChainName, txActionLine,
} from "../client.js";

export async function handle_crosschain_transfer(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const srcChainArg = args.sourceChain as string | undefined;
  const destChainArg = args.destinationChain as string;
  const tokenSymbol = args.token as string;
  const amount = args.amount as string;
  const useNativeEth = args.useNativeEth === true || args.useNativeEth === "true";
  // Default: same token on both sides (ETH→ETH when useNativeEth, WETH→WETH otherwise).
  // LLM overrides explicitly for cross-form requests: ETH→WETH (false) or WETH→ETH (true).
  const shouldUnwrapOnDestination = args.shouldUnwrapOnDestination !== undefined
    ? (args.shouldUnwrapOnDestination === true || args.shouldUnwrapOnDestination === "true")
    : useNativeEth;

  if (!destChainArg || !tokenSymbol || !amount) {
    throw new Error("destinationChain, token, and amount are all required.");
  }

  // Resolve source chain (optional — defaults to current chain)
  const srcChainId = srcChainArg
    ? resolveChainArg(srcChainArg.trim()).id
    : ctx.chainId;
  const srcName = resolveChainName(srcChainId);

  // Resolve destination chain
  const destMatch = resolveChainArg(destChainArg.trim());

  if (srcChainId === destMatch.id) {
    throw new Error(
      `Source and destination are both ${destMatch.name}. Cross-chain transfer requires different chains.`,
    );
  }

  const result = await buildCrosschainTransfer({
    vaultAddress: ctx.vaultAddress as Address,
    srcChainId,
    dstChainId: destMatch.id,
    tokenSymbol,
    amount,
    useNativeEth,
    shouldUnwrapOnDestination,
    alchemyKey: env.ALCHEMY_API_KEY,
    operatorAddress: ctx.operatorAddress,
  });

  const gas = await estimateGas(
    srcChainId, ctx.vaultAddress as Address,
    result.calldata as Hex, "0x0",
    ctx.operatorAddress, env.ALCHEMY_API_KEY, "bridge",
  );

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.calldata,
    value: "0x0",
    chainId: srcChainId,
    gas,
    description: result.description,
  };

  const message = [
    `✅ Cross-chain transfer ready`,
    `Route: ${srcName} → ${destMatch.name}`,
    `Send: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
    `Receive: ~${parseFloat(result.quote.outputAmount).toFixed(6)} ${result.quote.outputToken.symbol}`,
    `Bridge fee: ${result.quote.feePct}`,
    `Estimated time: ${result.quote.estimatedTime}`,
    ...(txActionLine(ctx) ? ["", txActionLine(ctx)] : []),
  ].join("\n");

  return {
    message,
    transaction,
    suggestions: ["Check vault balance", "Bridge more", "Get vault info"],
  };

}

export async function handle_crosschain_sync(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const srcChainArg = args.sourceChain as string | undefined;
  const destChainArg = args.destinationChain as string;
  const navToleranceBps = args.navToleranceBps as number | undefined;
  const equalizeNav = args.equalizeNav as boolean | undefined;

  // When equalizeNav=true, IGNORE LLM-provided amount and token.
  // These are computed DETERMINISTICALLY by the equalization algorithm.
  // The LLM's only job is to pass the two chain names + equalizeNav=true.
  const tokenSymbol = equalizeNav ? undefined : (args.token as string | undefined);
  const amount = equalizeNav ? undefined : (args.amount as string | undefined);

  if (!destChainArg) {
    throw new Error("destinationChain is required for crosschain_sync.");
  }

  const userSrcChainId = srcChainArg
    ? resolveChainArg(srcChainArg.trim()).id
    : ctx.chainId;
  const destMatch = resolveChainArg(destChainArg.trim());

  if (userSrcChainId === destMatch.id) {
    throw new Error(
      `Source and destination are both ${destMatch.name}. Cross-chain sync requires different chains.`,
    );
  }

  const result = await buildCrosschainSync({
    vaultAddress: ctx.vaultAddress as Address,
    srcChainId: userSrcChainId,
    dstChainId: destMatch.id,
    tokenSymbol,
    amount,
    navToleranceBps,
    equalizeNav,
    alchemyKey: env.ALCHEMY_API_KEY,
    operatorAddress: ctx.operatorAddress,
  });

  // CRITICAL: Use the EFFECTIVE chain IDs from the quote, NOT the user's
  // original args. When NAV equalization auto-swaps direction (bridges
  // FROM higher-NAV chain), the effective source differs from user input.
  // Using the original srcChainId for estimateGas would simulate on the
  // WRONG chain → SameChainTransfer revert (the calldata targets the
  // swapped source but simulation runs on the original source).
  const effectiveSrcChainId = result.quote.srcChainId;
  const effectiveDstChainId = result.quote.dstChainId;
  const effectiveSrcName = resolveChainName(effectiveSrcChainId);
  const effectiveDstName = resolveChainName(effectiveDstChainId);

  // Build context summary BEFORE estimateGas — so we can include it in errors.
  const eq = result.navEqualization;
  const navEqContext = eq
    ? [
        `NAV equalization${eq.directionAutoSwapped ? ' (direction auto-corrected)' : ''}:`,
        `  ${effectiveSrcName} NAV: ${eq.srcNavFormatted} | ${effectiveDstName} NAV: ${eq.dstNavFormatted}`,
        `  Divergence: ${(eq.divergenceBps / 100).toFixed(2)}% → ~${(eq.postDivergenceBps / 100).toFixed(2)}% after sync`,
        ...(eq.capped ? [`  ⚠ ${eq.capReason}`] : []),
      ].join('\n')
    : '';

  let syncGas: string;
  try {
    syncGas = await estimateGas(
      effectiveSrcChainId, ctx.vaultAddress as Address,
      result.calldata as Hex, "0x0",
      ctx.operatorAddress, env.ALCHEMY_API_KEY, "bridge",
    );
  } catch (err) {
    let revertReason: string;
    if (err instanceof Error) {
      let revertData: string | undefined;
      let bestMessage: string | undefined;
      const GENERIC_MSG = /RPC Request failed|unknown reason/i;
      let e: any = err;
      while (e) {
        const hexData =
          (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) ? e.data
          : (typeof e.error?.data === 'string' && e.error.data.startsWith('0x') && e.error.data.length > 2) ? e.error.data
          : undefined;
        if (hexData) {
          revertData = hexData;
          break;
        }
        if (!bestMessage) {
          if (e.shortMessage && !GENERIC_MSG.test(e.shortMessage)) {
            bestMessage = e.shortMessage;
          } else if (e.details && !GENERIC_MSG.test(e.details)) {
            bestMessage = e.details;
          }
        }
        e = e.cause;
      }
      if (revertData) {
        revertReason = friendlyError(`execution reverted: ${revertData}`);
      } else if (bestMessage) {
        revertReason = friendlyError(sanitizeError(bestMessage));
      } else {
        revertReason = friendlyError(sanitizeError(err.message));
      }
    } else {
      revertReason = friendlyError(sanitizeError(String(err)));
    }

    const errorLines = [
      `❌ NAV sync failed — transaction would revert on-chain`,
      ``,
      `Proposed action:`,
      `  Route: ${effectiveSrcName} → ${effectiveDstName}`,
      `  Token: ${result.quote.inputToken.symbol}`,
      `  Amount: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
      `  Bridge fee: ${result.quote.feePct}`,
    ];
    if (navEqContext) {
      errorLines.push(``, navEqContext);
    }
    errorLines.push(``, `Revert reason: ${revertReason}`);
    throw new Error(errorLines.join('\n'));
  }

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.calldata,
    value: "0x0",
    chainId: effectiveSrcChainId,
    gas: syncGas,
    description: result.description,
  };

  const toleranceDisplay = navToleranceBps
    ? `${(navToleranceBps / 100).toFixed(2)}%`
    : "1.00% (default)";

  const message = [
    `✅ NAV sync ready`,
    `Route: ${effectiveSrcName} → ${effectiveDstName}`,
    `Sync amount: ${result.quote.inputAmount} ${result.quote.inputToken.symbol}`,
    `NAV tolerance: ${toleranceDisplay}`,
    `Bridge fee: ${result.quote.feePct}`,
    `Estimated time: ${result.quote.estimatedTime}`,
    ...(navEqContext ? ['', navEqContext] : []),
    ...(txActionLine(ctx) ? ["", txActionLine(ctx)] : []),
  ].join("\n");

  return {
    message,
    transaction,
    suggestions: ["Check vault info", "Bridge tokens", "Get NAV data"],
  };

}

export async function handle_get_crosschain_quote(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const srcChainArg = args.sourceChain as string | undefined;
  const destChainArg = args.destinationChain as string;
  const tokenSymbol = args.token as string;
  const amount = args.amount as string;

  if (!destChainArg || !tokenSymbol || !amount) {
    throw new Error("destinationChain, token, and amount are all required.");
  }

  const srcChainId = srcChainArg
    ? resolveChainArg(srcChainArg.trim()).id
    : ctx.chainId;
  const srcName = resolveChainName(srcChainId);
  const destMatch = resolveChainArg(destChainArg.trim());

  const quote = await getCrosschainQuote(
    srcChainId,
    destMatch.id,
    tokenSymbol,
    amount,
  );

  const message = [
    `📊 Cross-chain bridge quote`,
    `Route: ${srcName} → ${destMatch.name}`,
    `Send: ${quote.inputAmount} ${quote.inputToken.symbol}`,
    `Receive: ~${parseFloat(quote.outputAmount).toFixed(6)} ${quote.outputToken.symbol}`,
    `Bridge fee: ${quote.feePct}`,
    `Estimated fill time: ${quote.estimatedTime}`,
    "",
    "To execute, ask me to bridge/transfer the tokens.",
  ].join("\n");

  return {
    message,
    suggestions: [`Bridge ${amount} ${tokenSymbol} to ${destMatch.name}`, "Check vault balance"],
  };

}

export async function handle_get_aggregated_nav(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const nav = await getAggregatedNav(
    ctx.vaultAddress as Address,
    env.ALCHEMY_API_KEY,
    env.KV,
  );

  // Build per-chain summary
  const chainLines: string[] = [];
  for (const snap of nav.chains) {
    if (snap.error) {
      chainLines.push(`  ${snap.chainName}: ⚠️ ${snap.error}`);
      continue;
    }
    if (snap.totalValue === 0n && snap.tokenBalances.every((b) => b.balance === 0n)
        && snap.baseTokenSymbol === "N/A") {
      continue; // skip chains where the pool doesn't exist
    }
    const delegation = snap.delegationActive ? "✅" : "❌";
    const divisor = 10 ** snap.baseTokenDecimals;
    const unitaryStr = (Number(snap.unitaryValue) / divisor).toFixed(6);
    const supplyStr = (Number(snap.totalSupply) / divisor).toFixed(4);
    const tokenLines = snap.tokenBalances
      .filter((b) => b.balance > 0n)
      .map((b) => `    ${b.token.symbol}: ${b.balanceFormatted}`)
      .join("\n");

    chainLines.push(
      `  **${snap.chainName}** (delegation: ${delegation})` +
      `\n    Base token: ${snap.baseTokenSymbol} | Supply: ${supplyStr} | Unitary value: ${unitaryStr}` +
      (tokenLines ? `\n${tokenLines}` : ""),
    );
  }

  // Token totals
  const totalLines: string[] = [];
  for (const [tokenType, data] of Object.entries(nav.tokenTotals)) {
    if (data.total === "0" || data.total === "0.000000") continue;
    totalLines.push(`  ${tokenType}: ${data.total}`);
  }

  // Missing delegation
  const missingNames = nav.missingDelegationChains.map(
    (id) => crosschainChainName(id),
  );

  const message = [
    `📊 **Aggregated NAV — ${ctx.vaultAddress}**`,
    "",
    chainLines.length > 0 ? chainLines.join("\n\n") : "  No vault data found on any chain.",
    "",
    totalLines.length > 0
      ? `**Bridgeable token totals:**\n${totalLines.join("\n")}`
      : "",
    missingNames.length > 0
      ? `\n⚠️ **Missing delegation on:** ${missingNames.join(", ")}\nSet up agent delegation on these chains to enable cross-chain operations.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    message,
    selfContained: true,
    suggestions: [
      "Bridge USDT to Arbitrum",
      "Create a TWAP order",
      "Check LP positions",
      "Sync NAV across chains",
    ],
  };

}

export async function handle_get_rebalance_plan(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  const targetChainArg = args.targetChain as string | undefined;
  const targetChainId = targetChainArg
    ? resolveChainArg(targetChainArg.trim()).id
    : undefined;

  const plan = await buildRebalancePlan({
    vaultAddress: ctx.vaultAddress as Address,
    targetChainId,
    alchemyKey: env.ALCHEMY_API_KEY,
    kv: env.KV,
  });

  if (plan.operations.length === 0) {
    return {
      message: plan.summary,
      suggestions: ["Get aggregated NAV", "Check vault info"],
    };
  }

  // List each operation
  const opLines = plan.operations.map((op, i) => {
    const fee = op.estimatedFeePct || "N/A";
    const time = op.estimatedTime || "N/A";
    const cappedNote = op.capped ? " ⚠️ capped to stay within 10% NAV shield" : "";
    return `  ${i + 1}. ${op.srcChainName} → ${plan.targetChainName}: ${op.amount} ${op.tokenType} (fee: ${fee}, ~${time})${cappedNote}`;
  });

  // Check for missing delegation on source chains
  const missingDelegation = plan.nav.missingDelegationChains;
  const opSourceChains = new Set(plan.operations.map((o) => o.srcChainId));
  const blockedSources = [...opSourceChains].filter((id) =>
    missingDelegation.includes(id),
  );
  const blockedNames = blockedSources.map((id) => crosschainChainName(id));

  const message = [
    `📋 **Rebalance Plan → ${plan.targetChainName}**`,
    "",
    `${plan.operations.length} operation${plan.operations.length > 1 ? "s" : ""} recommended:`,
    "",
    opLines.join("\n"),
    blockedNames.length > 0
      ? `\n⚠️ **Delegation missing on:** ${blockedNames.join(", ")}\nSet up agent delegation on these chains first.`
      : "",
    "",
    "Which operations would you like to execute? (e.g., 'all', '1 and 3', 'skip')",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    message,
    suggestions: [
      "Execute all operations",
      "Show aggregated NAV",
      "Skip rebalancing",
    ],
  };

}

