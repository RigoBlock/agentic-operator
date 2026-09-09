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
import { SUPPORTED_CHAINS } from "../../config.js";
import { CROSSCHAIN_TOKENS } from "../../services/crosschainConfig.js";

export interface ToolCardField {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
  /** Render as a dropdown instead of a free-text input (label → sent value). */
  options?: { label: string; value: string }[];
}

export interface ToolCard {
  toolName: string;
  title: string;
  summary: string;
  fields: ToolCardField[];
  /** Pre-filled arguments (e.g. dex='uniswap') rendered as static text and sent with the form. */
  presetArgs?: Record<string, string>;
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
  gmx_get_positions: "View GMX positions",
  gmx_get_markets: "View GMX markets",
  gmx_increase_position: "Open / increase GMX position",
  gmx_decrease_position: "Close / decrease GMX position",
  gmx_cancel_order: "Cancel GMX order",
  gmx_update_order: "Update GMX order",
  gmx_claim_funding_fees: "Claim funding fees",
  get_swap_quote: "Price quote (no transaction)",
  build_vault_swap: "Swap tokens",
  refresh_oracle_feed: "Refresh oracle price feed",
  get_pool_info: "Pool details (by pool ID)",
  initialize_pool: "Initialize Uniswap v4 pool",
  add_liquidity: "Add liquidity",
  remove_liquidity: "Remove liquidity",
  get_lp_positions: "View LP positions",
  collect_lp_fees: "Collect LP fees",
  burn_position: "Burn position NFT",
  crosschain_transfer: "Cross-chain transfer",
  crosschain_sync: "Cross-chain NAV sync",
  get_crosschain_quote: "Bridge quote",
  get_aggregated_nav: "Aggregated multi-chain NAV",
  get_rebalance_plan: "Rebalance plan",
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
    { name: "side", label: "Side", required: true, options: [
      { label: "Buy / long", value: "buy" },
      { label: "Sell / short", value: "sell" },
    ] },
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
    { name: "useNativeEth", label: "Use native ETH (WETH only)", required: false, placeholder: "true = vault wraps ETH→WETH automatically" },
  ],
  crosschain_sync: [
    { name: "sourceChain", label: "Source chain", required: false, placeholder: "empty = current chain" },
    { name: "destinationChain", label: "Destination chain", required: true, placeholder: "Base" },
    { name: "token", label: "Token (only with amount)", required: false, placeholder: "USDC" },
    { name: "amount", label: "Amount (empty = auto NAV equalization)", required: false, placeholder: "5" },
    { name: "useNativeEth", label: "Use native ETH (WETH only)", required: false, placeholder: "true = vault wraps ETH→WETH automatically" },
  ],
  get_crosschain_quote: [
    { name: "sourceChain", label: "Source chain", required: false, placeholder: "empty = current chain" },
    { name: "destinationChain", label: "Destination chain", required: true, placeholder: "Base" },
    { name: "token", label: "Token", required: true, placeholder: "USDC" },
    { name: "amount", label: "Amount", required: true, placeholder: "5" },
  ],
  gmx_increase_position: [
    { name: "market", label: "Market", required: true, placeholder: "ETH" },
    { name: "isLong", label: "Direction", required: true, options: [
      { label: "Long", value: "true" },
      { label: "Short", value: "false" },
    ] },
    { name: "collateral", label: "Collateral token", required: false, placeholder: "WETH or USDC — omit to reuse an existing position's collateral" },
    { name: "notionalUsd", label: "Notional USD", required: false, placeholder: "1500 — position size to add" },
    { name: "collateralAmount", label: "Collateral amount", required: false, placeholder: "200 — omit when using notionalUsd + leverage" },
    { name: "leverage", label: "Leverage", required: false, placeholder: "e.g. 10 — omit to keep current" },
  ],
  gmx_decrease_position: [
    { name: "market", label: "Market", required: true, placeholder: "ETH" },
    { name: "isLong", label: "Direction", required: true, options: [
      { label: "Long", value: "true" },
      { label: "Short", value: "false" },
    ] },
    { name: "collateral", label: "Collateral token", required: false, placeholder: "disambiguates when several positions share market + side" },
    { name: "sizeDeltaUsd", label: "Size to close (USD)", required: false, placeholder: "'all' closes fully · '50%' partially · '0' keeps size (collateral-only)" },
    { name: "collateralDeltaAmount", label: "Collateral amount to withdraw", required: false, placeholder: "e.g. 100 — usable with partial closes or size 0; a full close returns all collateral automatically" },
  ],
  gmx_cancel_order: [
    { name: "orderKey", label: "Order key", required: true, placeholder: "0x… — copy from Pending Orders in View GMX positions" },
  ],
  gmx_update_order: [
    { name: "orderKey", label: "Order key", required: true, placeholder: "0x… — copy from Pending Orders in View GMX positions" },
    { name: "sizeDeltaUsd", label: "New size (USD)", required: true, placeholder: "5000" },
    { name: "triggerPrice", label: "New trigger price (USD)", required: true, placeholder: "3000" },
    { name: "acceptablePrice", label: "Acceptable price (USD)", required: true, placeholder: "worst price you would still accept" },
  ],
  get_swap_quote: [
    { name: "tokenIn", label: "Sell", required: true, placeholder: "ETH" },
    { name: "tokenOut", label: "Buy", required: true, placeholder: "USDC" },
    { name: "amountIn", label: "Amount to sell", required: false, placeholder: "1 — or use amount to buy" },
    { name: "amountOut", label: "Amount to buy", required: false, placeholder: "2000 — alternative to amountIn" },
    { name: "chain", label: "Chain", required: false, placeholder: "empty = current chain" },
  ],
  build_vault_swap: [
    { name: "tokenIn", label: "Sell", required: true, placeholder: "ETH" },
    { name: "tokenOut", label: "Buy", required: true, placeholder: "USDC" },
    { name: "amountIn", label: "Amount to sell", required: false, placeholder: "1 — or use amount to buy" },
    { name: "amountOut", label: "Amount to buy", required: false, placeholder: "2000 — alternative to amountIn" },
    { name: "chain", label: "Chain", required: false, placeholder: "empty = current chain" },
  ],
  add_liquidity: [
    { name: "tokenA", label: "Token A", required: true, placeholder: "ETH" },
    { name: "tokenB", label: "Token B", required: true, placeholder: "USDC" },
    { name: "fee", label: "Pool fee", required: true, placeholder: "500 = 0.05%, 3000 = 0.30%" },
    { name: "amountA", label: "Amount A", required: false, placeholder: "one of amountA/amountB is enough" },
    { name: "amountB", label: "Amount B", required: false, placeholder: "computed from amountA if omitted" },
    { name: "tickRange", label: "Tick range", required: false, placeholder: "full (default), wide, narrow, or -887220,887220" },
    { name: "chain", label: "Chain", required: false, placeholder: "empty = current chain" },
  ],
  remove_liquidity: [
    { name: "tokenA", label: "Token A", required: true, placeholder: "ETH" },
    { name: "tokenB", label: "Token B", required: true, placeholder: "USDC" },
    { name: "tokenId", label: "Position NFT ID", required: true, placeholder: "from View LP positions" },
    { name: "chain", label: "Chain", required: false, placeholder: "empty = current chain" },
  ],
  collect_lp_fees: [
    { name: "tokenId", label: "Position NFT ID", required: true, placeholder: "from View LP positions" },
    { name: "tokenA", label: "Token A", required: true, placeholder: "ETH" },
    { name: "tokenB", label: "Token B", required: true, placeholder: "USDC" },
  ],
  burn_position: [
    { name: "tokenId", label: "Position NFT ID", required: true, placeholder: "must have 0 liquidity and 0 fees" },
  ],
  initialize_pool: [
    { name: "tokenA", label: "Token A", required: true, placeholder: "ETH" },
    { name: "tokenB", label: "Token B", required: true, placeholder: "USDC" },
    { name: "fee", label: "Pool fee", required: true, placeholder: "500 = 0.05%, 3000 = 0.30%" },
    { name: "amountA", label: "Amount A (for initial price)", required: false, placeholder: "with amountB, or use sqrtPriceX96" },
    { name: "amountB", label: "Amount B (for initial price)", required: false, placeholder: "with amountA" },
    { name: "chain", label: "Chain", required: false, placeholder: "empty = current chain" },
  ],
};

type MenuEntry = string | { tool: string; title?: string; presetArgs?: Record<string, string> };

const GMX_MENU: MenuEntry[] = [
  "gmx_get_positions",
  "gmx_get_markets",
  "gmx_increase_position",
  "gmx_decrease_position",
  "gmx_cancel_order",
  "gmx_update_order",
  "gmx_claim_funding_fees",
];

const SWAP_MENU: MenuEntry[] = [
  "get_swap_quote",
  { tool: "build_vault_swap", title: "Swap via 0x (aggregator)", presetArgs: { dex: "0x" } },
  { tool: "build_vault_swap", title: "Swap via Uniswap", presetArgs: { dex: "uniswap" } },
  "refresh_oracle_feed",
];

const LP_MENU: MenuEntry[] = [
  "get_lp_positions",
  "get_pool_info",
  "add_liquidity",
  "remove_liquidity",
  "collect_lp_fees",
  "burn_position",
  "initialize_pool",
];

const CROSSCHAIN_MENU: MenuEntry[] = [
  "get_aggregated_nav",
  "get_rebalance_plan",
  "crosschain_transfer",
  "crosschain_sync",
  "get_crosschain_quote",
  "verify_bridge_arrival",
];

/** Categories exposed by the menu. Aliases point at shared lists. */
const MENU_CATEGORIES: Record<string, MenuEntry[]> = {
  hyperliquid: [
    "hyperliquid_get_positions",
    "hyperliquid_get_markets",
    "hyperliquid_get_fills",
    "hyperliquid_deposit",
    "hyperliquid_limit_order",
    "hyperliquid_cancel_order",
    "hyperliquid_usd_class_transfer",
    "hyperliquid_spot_send",
  ],
  gmx: GMX_MENU,
  swap: SWAP_MENU,
  lp: LP_MENU,
  uniswap: LP_MENU,
  liquidity: LP_MENU,
  crosschain: CROSSCHAIN_MENU,
  bridge: CROSSCHAIN_MENU,
};

/** Per-chain bridgeable token list shown in the crosschain menu message. */
function crosschainTokenSummary(): string {
  return SUPPORTED_CHAINS
    .map((c) => {
      const tokens = CROSSCHAIN_TOKENS[c.id];
      if (!tokens || tokens.length === 0) return null;
      return `${c.name}: ${tokens.map((t) => t.symbol).join("/")}`;
    })
    .filter((line): line is string => line !== null)
    .join(" · ");
}

/** First sentence of a tool description — enough for a card summary. */
function summarize(description: string): string {
  const first = description.split(/(?<=[.!?])\s/)[0] || description;
  return first.length > 90 ? first.slice(0, 87) + "…" : first;
}

function buildCard(entry: MenuEntry): ToolCard | null {
  const toolName = typeof entry === "string" ? entry : entry.tool;
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
    title: (typeof entry === "object" && entry.title) || MENU_TITLES[toolName] || toolName,
    summary: summarize(def.function.description),
    fields,
    ...(typeof entry === "object" && entry.presetArgs ? { presetArgs: entry.presetArgs } : {}),
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

  let message = `Here are the ${category} tools. Pick one and fill in the fields — it runs directly, no agent involved.`;
  if (toolNames === CROSSCHAIN_MENU) {
    message += ` Supported bridgeable tokens per chain: ${crosschainTokenSummary()}. ` +
      `Native ETH can bridge as WETH — set "Use native ETH" to true on WETH transfers and the vault wraps ETH automatically.`;
  }

  return {
    message,
    metadata: { toolCards: cards },
    selfContained: true,
  };
}
