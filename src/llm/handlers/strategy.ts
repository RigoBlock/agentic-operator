/**
 * Strategy Tool Handlers
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";
import { resolveChainArg } from "../client.js";

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
