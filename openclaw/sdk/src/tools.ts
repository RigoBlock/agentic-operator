/**
 * Tool definitions for the Rigoblock OpenClaw skill.
 *
 * Each tool maps to one API call on the Rigoblock Agentic Operator.
 * Tools are invoked by the OpenClaw agent via natural language or explicit
 * function calls. The RigoblockClient handles x402 payment and auth.
 */

import { RigoblockClient } from "./client.js";
import type {
  QuoteParams,
  SwapParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
  GmxOpenParams,
  GmxCloseParams,
  BridgeParams,
  VaultInfoParams,
  QuoteResponse,
  ChatResponse,
} from "./types.js";

// ─── Tool result type ───────────────────────────────────────────────────────

export type ToolResult =
  | { ok: true; data: QuoteResponse | ChatResponse }
  | { ok: false; error: string };

// ─── Tool implementations ───────────────────────────────────────────────────

export async function rigoblockQuote(
  client: RigoblockClient,
  params: QuoteParams,
): Promise<ToolResult> {
  try {
    const data = await client.getQuote(params);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockSwap(
  client: RigoblockClient,
  params: SwapParams,
): Promise<ToolResult> {
  try {
    const dexStr = params.dex ? ` using ${params.dex}` : "";
    const chainStr = params.chain ? ` on ${params.chain}` : "";
    const data = await client.chat(
      `swap ${params.amount} ${params.tokenIn} for ${params.tokenOut}${dexStr}${chainStr}`,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockAddLiquidity(
  client: RigoblockClient,
  params: AddLiquidityParams,
): Promise<ToolResult> {
  try {
    const data = await client.addLiquidity(
      params.token0,
      params.token1,
      params.amount0,
      params.amount1,
      params.chain,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockRemoveLiquidity(
  client: RigoblockClient,
  params: RemoveLiquidityParams,
): Promise<ToolResult> {
  try {
    const data = await client.removeLiquidity(params.positionId, params.chain);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockGetLpPositions(
  client: RigoblockClient,
  params: VaultInfoParams,
): Promise<ToolResult> {
  try {
    const data = await client.getLpPositions(params.chain);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockGmxOpen(
  client: RigoblockClient,
  params: GmxOpenParams,
): Promise<ToolResult> {
  try {
    const data = await client.gmxOpen(
      params.market,
      params.direction,
      params.collateral,
      params.collateralAmount,
      params.leverage ?? 1,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockGmxClose(
  client: RigoblockClient,
  params: GmxCloseParams,
): Promise<ToolResult> {
  try {
    const data = await client.gmxClose(params.market, params.direction);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockGmxPositions(
  client: RigoblockClient,
): Promise<ToolResult> {
  try {
    const data = await client.gmxPositions();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockBridge(
  client: RigoblockClient,
  params: BridgeParams,
): Promise<ToolResult> {
  try {
    const data = await client.bridge(
      params.token,
      params.amount,
      params.fromChain,
      params.toChain,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockVaultInfo(
  client: RigoblockClient,
  params: VaultInfoParams,
): Promise<ToolResult> {
  try {
    const data = await client.vaultInfo(params.chain);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rigoblockAggregatedNav(
  client: RigoblockClient,
): Promise<ToolResult> {
  try {
    const data = await client.aggregatedNav();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
