/**
 * Token registry tool handler.
 *
 * Lets the user/agent confirm a token address or name after a symbol could not
 * be resolved. The mapping is verified against CoinGecko before it is written,
 * so the LLM cannot prompt-inject arbitrary addresses into the registry.
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";
import { verifyAndRegisterToken } from "../../services/tokenResolver.js";
import { switchChainIfNeeded, resolveChainName } from "../client.js";

export async function handle_verify_token(
  env: Env,
  ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  const chainSwitched = switchChainIfNeeded(args.chain, ctx);
  const symbol = args.symbol as string;
  const identifier = args.identifier as string;

  if (!symbol || !identifier) {
    throw new Error("Both 'symbol' and 'identifier' are required.");
  }

  const address = await verifyAndRegisterToken(ctx.chainId, symbol, identifier);
  const chainName = resolveChainName(ctx.chainId);

  return {
    message: `Verified ${symbol.toUpperCase()} = ${address} on ${chainName}. You can now retry the swap.`,
    chainSwitch: chainSwitched,
  };
}
