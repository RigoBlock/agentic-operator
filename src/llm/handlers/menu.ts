/**
 * Tool Menu Handler
 *
 * Returns structured "tool cards" for the frontend to render as clickable boxes
 * with inline parameter forms. Each card carries only the fields the user must
 * provide, and submitting a card invokes the tool directly via POST /api/tools —
 * bypassing the LLM entirely. This gives a deterministic path to run any tool,
 * which isolates LLM issues from tool/on-chain issues.
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";
import { AGENT_TOOL_DEFINITIONS } from "../tools.js";

export interface ToolCardField {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

export interface ToolCard {
  toolName: string;
  title: string;
  summary: string;
  fields: ToolCardField[];
}

/** Short human titles for menu cards. */
const MENU_TITLES: Record<string, string> = {
  hyperliquid_get_positions: "View Hyperliquid account",
  hyperliquid_get_markets: "View Hyperliquid markets",
  hyperliquid_get_fills: "Recent fills & open orders",
  hyperliquid_deposit: "Deposit USDC to Hyperliquid",
  hyperliquid_limit_order: "Trade (open / close position)",
  hyperliquid_cancel_order: "Cancel Hyperliquid order",
  hyperliquid_usd_class_transfer: "Withdraw ① perp → Core spot",
  hyperliquid_spot_send: "Withdraw ② Core spot → HyperEVM",
  crosschain_transfer: "Cross-chain transfer",
  crosschain_sync: "Cross-chain NAV sync",
  get_crosschain_quote: "Bridge quote",
  verify_bridge_arrival: "Check bridge arrival",
};

/**
 * Field overrides where the JSON-schema `required` list alone is not enough for
 * a usable form (e.g. hyperliquid_limit_order requires only `coin` but a trade
 * needs side and size).
 */
const MENU_FIELD_OVERRIDES: Record<string, ToolCardField[]> = {
  hyperliquid_limit_order: [
    { name: "coin", label: "Market", required: true, placeholder: "BTC" },
    { name: "side", label: "Side", required: true, placeholder: "buy (long) or sell (short)" },
    { name: "size", label: "Size", required: false, placeholder: "0.5 — or use notionalUsd, e.g. 3000" },
    { name: "notionalUsd", label: "Notional USD", required: false, placeholder: "3000 — alternative to size" },
    { name: "orderType", label: "Order type", required: false, placeholder: "market (default) or limit" },
    { name: "price", label: "Limit price (USD)", required: false, placeholder: "required for limit — omit for market" },
  ],
  crosschain_transfer: [
    { name: "sourceChain", label: "Source chain", required: false, placeholder: "empty = current chain" },
    { name: "destinationChain", label: "Destination chain", required: true, placeholder: "Base" },
    { name: "token", label: "Token", required: true, placeholder: "USDC" },
    { name: "amount", label: "Amount", required: true, placeholder: "5" },
  ],
  crosschain_sync: [
    { name: "sourceChain", label: "Source chain", required: false, placeholder: "empty = current chain" },
    { name: "destinationChain", label: "Destination chain", required: true, placeholder: "Base" },
    { name: "token", label: "Token (only with amount)", required: false, placeholder: "USDC" },
    { name: "amount", label: "Amount (empty = auto NAV equalization)", required: false, placeholder: "5" },
  ],
  get_crosschain_quote: [
    { name: "sourceChain", label: "Source chain", required: false, placeholder: "empty = current chain" },
    { name: "destinationChain", label: "Destination chain", required: true, placeholder: "Base" },
    { name: "token", label: "Token", required: true, placeholder: "USDC" },
    { name: "amount", label: "Amount", required: true, placeholder: "5" },
  ],
};

/** Categories exposed by the menu. "hyperliquid" includes cross-chain ops (USDC bridging to/from HyperEVM). */
const MENU_CATEGORIES: Record<string, string[]> = {
  hyperliquid: [
    "hyperliquid_get_positions",
    "hyperliquid_get_markets",
    "hyperliquid_get_fills",
    "hyperliquid_deposit",
    "hyperliquid_limit_order",
    "hyperliquid_cancel_order",
    "hyperliquid_usd_class_transfer",
    "hyperliquid_spot_send",
    "crosschain_transfer",
    "crosschain_sync",
    "get_crosschain_quote",
    "verify_bridge_arrival",
  ],
};

/** First sentence of a tool description — enough for a card summary. */
function summarize(description: string): string {
  const first = description.split(/(?<=[.!?])\s/)[0] || description;
  return first.length > 90 ? first.slice(0, 87) + "…" : first;
}

function buildCard(toolName: string): ToolCard | null {
  const def = AGENT_TOOL_DEFINITIONS.find((t) => t.function.name === toolName);
  if (!def) return null;

  const overridden = MENU_FIELD_OVERRIDES[toolName];
  let fields: ToolCardField[];
  if (overridden) {
    fields = overridden;
  } else {
    const params = def.function.parameters as unknown as {
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };
    const required = new Set(params.required ?? []);
    fields = Object.entries(params.properties ?? {})
      .filter(([name]) => required.has(name))
      .map(([name, prop]) => ({
        name,
        label: name,
        required: true,
        placeholder: prop.description?.slice(0, 60),
      }));
  }

  return {
    toolName,
    title: MENU_TITLES[toolName] ?? toolName,
    summary: summarize(def.function.description),
    fields,
  };
}

export async function handle_get_tool_menu(
  _env: Env,
  _ctx: RequestContext,
  args: Record<string, unknown>,
  _toolName: string,
): Promise<ToolResult> {
  const category = String(args.category ?? "").trim().toLowerCase();
  const toolNames = MENU_CATEGORIES[category];

  if (!toolNames) {
    return {
      message:
        `Available tool menus: ${Object.keys(MENU_CATEGORIES).join(", ")}. ` +
        `Call get_tool_menu with a category, e.g. category="hyperliquid".`,
      metadata: { toolCategories: Object.keys(MENU_CATEGORIES) },
      selfContained: true,
    };
  }

  const cards = toolNames
    .map(buildCard)
    .filter((c): c is ToolCard => c !== null);

  return {
    message: `Here are the ${category} tools. Pick one and fill in the fields — it runs directly, no agent involved.`,
    metadata: { toolCards: cards },
    selfContained: true,
  };
}
