/**
 * Liquidity Tool Handlers
 */

/**
 * Tool Handlers — all tool call handlers + registry.
 */

import type { Env, RequestContext, UnsignedTransaction } from "../../types.js";
import type { ToolResult } from "../client.js";
import { resolveTokenAddress } from "../../config.js";
import { type Address } from "viem";
import {
  buildAddLiquidityTx, buildRemoveLiquidityTx, buildInitializePoolTx,
  getVaultLPPositions, buildCollectFeesTx, buildBurnPositionTx,
  getVaultActivePools, getPositionDirect, POOL_MANAGER,
} from "../../services/uniswapLP.js";
import { resolveChainArg, resolveChainName, txActionLine } from "../client.js";

export async function handle_get_pool_info(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  let chainId = ctx.chainId;
  if (args.chain) {
    chainId = resolveChainArg((args.chain as string).trim()).id;
  }

  const activePools = await getVaultActivePools(chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
  const requestedPoolId = args.poolId ? ((args.poolId as string).trim() as `0x${string}`) : undefined;

  const pools = requestedPoolId
    ? activePools.filter((p) => p.poolId.toLowerCase() === requestedPoolId.toLowerCase())
    : activePools;

  if (pools.length === 0) {
    const chainName = resolveChainName(chainId);
    return {
      message: requestedPoolId
        ? `No active Uniswap v4 pool matching ${requestedPoolId} found for this vault on ${chainName}. `
          + `If the pool exists but is not held by the vault, provide the full pool key directly to initialize_pool or add_liquidity.`
        : `No active Uniswap v4 pools found for this vault on ${chainName}.`,
      selfContained: true,
    };
  }

  const formatPool = (info: (typeof pools)[0]) => [
    `Pool ID: ${info.poolId}`,
    `Initialized: ${info.initialized ? "Yes" : "No"}`,
    `Fee: ${info.fee} (${info.fee / 10000}%)`,
    `Tick Spacing: ${info.tickSpacing}`,
    `Hooks: ${info.hooks}`,
    `Currency 0: ${info.currency0}`,
    `Currency 1: ${info.currency1}`,
    `Current Tick: ${info.currentTick}`,
    `Liquidity: ${info.liquidity}`,
    info.initialized
      ? `To add liquidity: use fee=${info.fee}, tickSpacing=${info.tickSpacing}, hooks=${info.hooks}`
      : `⚠️ Pool is NOT initialized. Call initialize_pool first with fee=${info.fee}, tickSpacing=${info.tickSpacing}, hooks=${info.hooks}`,
  ].join("\n");

  const message = [
    `ℹ️ Uniswap v4 Pool Info — ${pools.length} active pool${pools.length === 1 ? "" : "s"}`,
    "",
    ...pools.flatMap((p, i) => (i > 0 ? ["", formatPool(p)] : [formatPool(p)])),
  ].join("\n");

  return { message, selfContained: true };

}

export async function handle_add_liquidity(
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

  const result = await buildAddLiquidityTx(env, {
    tokenA: args.tokenA as string,
    tokenB: args.tokenB as string,
    amountA: args.amountA as string | undefined,
    amountB: args.amountB as string | undefined,
    fee: args.fee as number,
    tickSpacing: args.tickSpacing as number | undefined,
    tickRange: (args.tickRange as string) || "full",
    hooks: args.hooks as Address | undefined,
  }, ctx.chainId, ctx.vaultAddress as Address);

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.calldata,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
    description: result.description,
  };

  const chainName = resolveChainName(ctx.chainId);
  const message = [
    `✅ Add Liquidity ready`,
    `${result.description}`,
    `Tick range: [${result.tickLower}, ${result.tickUpper}]`,
    `Chain: ${chainName}`,
    ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_initialize_pool(
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

  const result = await buildInitializePoolTx(env, {
    tokenA: args.tokenA as string,
    tokenB: args.tokenB as string,
    fee: args.fee as number,
    tickSpacing: args.tickSpacing as number | undefined,
    hooks: args.hooks as Address | undefined,
    sqrtPriceX96: args.sqrtPriceX96 as string | undefined,
    amountA: args.amountA as string | undefined,
    amountB: args.amountB as string | undefined,
  }, ctx.chainId);

  const transaction: UnsignedTransaction = {
    to: POOL_MANAGER[ctx.chainId],
    data: result.calldata,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
    description: result.description,
    operatorOnly: true,
  };

  const chainName = resolveChainName(ctx.chainId);
  const message = [
    `✅ Initialize Pool ready`,
    `${result.description}`,
    `Pool ID: ${result.poolId}`,
    `Chain: ${chainName}`,
    ``,
    `⚠️ This transaction must be signed and broadcast from your wallet (not the vault). ` +
    `After confirmation, you can add liquidity via add_liquidity.`,
  ].join("\n");

  return { message, transaction, chainSwitch: chainSwitched };

}

export async function handle_remove_liquidity(
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

  // Auto-fetch liquidityAmount if not provided or non-numeric (e.g. LLM passes "all", "100%").
  // The LLM knows the tokenId but not raw liquidity units, so we resolve it here.
  let liquidityAmount = args.liquidityAmount as string | undefined;
  const tokenId = args.tokenId as string;
  if ((!liquidityAmount || !/^\d+$/.test(liquidityAmount.trim())) && tokenId) {
    const positions = await getVaultLPPositions(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
    const pos = positions.find(p => p.tokenId === tokenId);
    if (!pos) throw new Error(`LP position #${tokenId} not found. Use get_lp_positions to list your current positions.`);
    if (pos.liquidity === "0") throw new Error(`Position #${tokenId} has zero liquidity — it may already be closed.`);
    liquidityAmount = pos.liquidity;
  }
  if (!liquidityAmount) throw new Error("liquidityAmount is required when position cannot be looked up.");

  const result = await buildRemoveLiquidityTx(env, {
    tokenA: args.tokenA as string,
    tokenB: args.tokenB as string,
    tokenId,
    liquidityAmount,
    burn: args.burn as boolean | undefined,
  }, ctx.chainId, ctx.vaultAddress as Address);

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.calldata,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
    description: result.description,
  };

  const chainName = resolveChainName(ctx.chainId);
  const wasBurned = (args.burn as boolean | undefined) === true;
  const burnNote = wasBurned
    ? `ℹ️ The position NFT #${tokenId} was burned (permanent). If fees remain uncollected they were forfeited.`
    : `ℹ️ Position NFT #${tokenId} persists with 0 liquidity. ` +
      `Use collect_lp_fees to harvest any accrued fees, then burn_position to permanently delete it.`;
  return {
    message: [`✅ Remove Liquidity ready`, result.description, `Chain: ${chainName}`, burnNote, ...(txActionLine(ctx) ? [txActionLine(ctx)] : [])].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_get_lp_positions(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  toolName: string,
): Promise<ToolResult> {
  let chainSwitched: number | undefined;
  if (args.chain) {
    const match = resolveChainArg((args.chain as string).trim());
    if (match.id !== ctx.chainId) {
      ctx.chainId = match.id;
      chainSwitched = match.id;
    }
  }

  const chainName = resolveChainName(ctx.chainId);
  const positions = await getVaultLPPositions(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);

  if (positions.length === 0) {
    return {
      message: `No Uniswap v4 LP positions found for this vault on ${chainName} (0 token IDs returned by vault).\nIf you believe positions exist, verify the vault address and chain, then try again.`,
      chainSwitch: chainSwitched,
      selfContained: true,
    };
  }

  // Format amounts: trim trailing zeros, cap at 6 decimal places
  const fmtAmt = (raw: string): string => {
    const n = parseFloat(raw);
    if (n === 0) return "0";
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4);
    return n.toFixed(6);
  };

  // Block explorer base URLs for address links
  const explorerBase: Record<number, string> = {
    1: "https://etherscan.io/address/",
    10: "https://optimistic.etherscan.io/address/",
    56: "https://bscscan.com/address/",
    137: "https://polygonscan.com/address/",
    8453: "https://basescan.org/address/",
    42161: "https://arbiscan.io/address/",
  };
  const explorer = explorerBase[ctx.chainId] || "";

  // Sort: active positions first, closed (zero liquidity) last
  const sorted = [...positions].sort((a, b) => {
    const aZero = a.liquidity === "0" ? 1 : 0;
    const bZero = b.liquidity === "0" ? 1 : 0;
    return aZero - bZero;
  });

  const active = positions.filter((p) => p.liquidity !== "0").length;
  const closedCount = positions.length - active;
  const subtitle = closedCount > 0 ? ` (${active} active, ${closedCount} closed)` : "";

  // Build markdown table
  const header = `| # | Pair | Fee | ${positions[0]?.symbol0 ?? "Token0"} | ${positions[0]?.symbol1 ?? "Token1"} | Hook | Status |`;
  const sep = "|---|------|-----|------|------|------|--------|";
  const rows = sorted.map((p) => {
    const status = p.liquidity === "0" ? "Closed" : "Active";
    const hookCell = p.hooks.toLowerCase() !== "0x0000000000000000000000000000000000000000"
      ? (explorer ? `[${p.hooks.slice(0, 6)}…${p.hooks.slice(-4)}](${explorer}${p.hooks})` : `${p.hooks.slice(0, 6)}…${p.hooks.slice(-4)}`)
      : "—";
    return `| ${p.tokenId} | ${p.symbol0}/${p.symbol1} | ${p.fee / 10000}% | ${fmtAmt(p.amount0)} | ${fmtAmt(p.amount1)} | ${hookCell} | ${status} |`;
  });

  const message = [
    `📊 **Uniswap v4 LP Positions — ${chainName}** (${positions.length}${subtitle})`,
    "",
    header,
    sep,
    ...rows,
  ].join("\n");

  return {
    message,
    chainSwitch: chainSwitched,
    selfContained: true,
  };

}

export async function handle_collect_lp_fees(
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

  const tokenId = args.tokenId as string;
  const addrA = await resolveTokenAddress(ctx.chainId, args.tokenA as string);
  const addrB = await resolveTokenAddress(ctx.chainId, args.tokenB as string);

  // Sort currency0 < currency1 as required by v4
  const isALower = addrA.toLowerCase() < addrB.toLowerCase();
  const currency0 = (isALower ? addrA : addrB) as Address;
  const currency1 = (isALower ? addrB : addrA) as Address;

  const result = buildCollectFeesTx(tokenId, currency0, currency1, ctx.vaultAddress as Address);

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.calldata,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
    description: result.description,
  };

  const chainName = resolveChainName(ctx.chainId);
  return {
    message: [`✅ Fee Collection ready`, result.description, `Chain: ${chainName}`, ...(txActionLine(ctx) ? [txActionLine(ctx)] : [])].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}

export async function handle_burn_position(
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

  const tokenId = args.tokenId as string;

  // The vault's getUniV4TokenIds() tracks ALL positions (active and closed) until
  // explicitly burned. A closed position appears in getVaultLPPositions() with
  // liquidity = "0" and status = "closed". Use it to validate and get pool key.
  const positions = await getVaultLPPositions(ctx.chainId, ctx.vaultAddress as Address, env.ALCHEMY_API_KEY);
  let pos = positions.find(p => p.tokenId === tokenId);

  // Fallback: if getVaultLPPositions didn't return this position (e.g. transient
  // RPC failure in the batch multicall), query the POSM directly for just this one.
  let currency0: Address;
  let currency1: Address;

  if (pos) {
    if (pos.liquidity !== "0") {
      throw new Error(
        `Position #${tokenId} still has ${pos.liquidity} liquidity units. ` +
        `Remove liquidity first using remove_liquidity, then collect any remaining fees with collect_lp_fees before burning.`,
      );
    }
    // Sort currency0 < currency1 — required for TAKE_PAIR
    const isC0Lower = pos.currency0.toLowerCase() < pos.currency1.toLowerCase();
    currency0 = (isC0Lower ? pos.currency0 : pos.currency1) as Address;
    currency1 = (isC0Lower ? pos.currency1 : pos.currency0) as Address;
  } else {
    // Position not in batch results — query POSM directly
    const directPos = await getPositionDirect(ctx.chainId, tokenId, env.ALCHEMY_API_KEY);
    if (!directPos) {
      throw new Error(
        `Position #${tokenId} not found — the NFT has already been burned in the PositionManager. ` +
        `If the vault's getUniV4TokenIds() still lists it, the tracking array is stale.`,
      );
    }
    if (directPos.liquidity > 0n) {
      throw new Error(
        `Position #${tokenId} still has ${directPos.liquidity} liquidity units. ` +
        `Remove liquidity first using remove_liquidity, then collect any remaining fees with collect_lp_fees before burning.`,
      );
    }
    const isC0Lower = directPos.currency0.toLowerCase() < directPos.currency1.toLowerCase();
    currency0 = (isC0Lower ? directPos.currency0 : directPos.currency1) as Address;
    currency1 = (isC0Lower ? directPos.currency1 : directPos.currency0) as Address;
  }

  const result = buildBurnPositionTx(tokenId, currency0, currency1, ctx.vaultAddress as Address);

  const transaction: UnsignedTransaction = {
    to: ctx.vaultAddress as Address,
    data: result.calldata,
    value: "0x0",
    chainId: ctx.chainId,
    gas: "0x0",
    description: result.description,
  };

  const chainName = resolveChainName(ctx.chainId);
  return {
    message: [
      `✅ Burn Position ready`,
      result.description,
      `Chain: ${chainName}`,
      ``,
      `⚠️ This is PERMANENT and IRREVERSIBLE. The position NFT #${tokenId} will be deleted.`,
      `Make sure you have collected all fees first (collect_lp_fees) — uncollected fees will be lost.`,
      ...(txActionLine(ctx) ? [txActionLine(ctx)] : []),
    ].join("\n"),
    transaction,
    chainSwitch: chainSwitched,
  };

}

