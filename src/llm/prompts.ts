/**
 * Modular system prompt sections.
 *
 * Philosophy: prompts only ROUTE. They tell the model which tool matches which
 * intent and how to map user words to tool arguments. Everything else — what is
 * supported, parameter semantics, validation, remediation — lives in the tool
 * definitions and handler error messages, which are the single source of truth.
 * The model calls the tool and relays what comes back; it does not interpret
 * support policies on its own.
 *
 * Core prompt: always sent. Domain prompts: loaded based on intent detection.
 */

// ── Intent detection ──────────────────────────────────────────────────

export type DomainKey =
  | "swap"
  | "gmx"
  | "hyperliquid"
  | "lp"
  | "bridge"
  | "staking"
  | "delegation"
  | "vault"
  | "strategy";

/** Domains that are included when a single message has no explicit domain signal. */
const FALLBACK_DOMAINS: DomainKey[] = ["swap", "vault"];

/** Detect domains from a single user message. */
function detectDomainsFromMessage(message: string): Set<DomainKey> {
  const domains = new Set<DomainKey>();
  const msg = message.toLowerCase();

  // Swap: explicit keywords OR concrete token-swap pattern (amount + token + with/for/to/into).
  // The pattern catches typos/conversational continuations like "but 30 usdt with eth on base".
  const hasSwapKeyword = /\b(swap|buy|sell|exchange|convert|trade|quote|price|slippage|swap.?shield|oracle)\b/.test(msg);
  const hasSwapPattern = /\b\d[\d,]*(?:\.\d+)?\s*[a-z0-9]{2,10}\s+(?:with|for|to|into|and)\s+[a-z0-9]{2,10}\b/i.test(msg);
  if ((hasSwapKeyword || hasSwapPattern) && !/\b(long|short|perp|leverage|\dx)\b/.test(msg)) {
    domains.add("swap");
  }

  // Hyperliquid perpetuals — requires the explicit "hyperliquid"/"hyperEVM" keyword
  // so generic perp phrases keep flowing to GMX. When matched, suppress the GMX
  // domain: the user named their protocol.
  if (/\b(hyperliquid|hyperevm|hyper\s*evm|hypercore|hyper\s*core)\b/.test(msg)) {
    domains.add("hyperliquid");
  } else if (/\b(long|short|perp|perpetual|leverage|\dx|gmx|funding fee|stop.?loss|take.?profit)\b/.test(msg)) {
    domains.add("gmx");
  }

  // Uniswap LP
  if (/\b(lp|liquidity|pool.?info|uniswap|tick|range|burn.?position|collect.?fee|nft|position.*id)\b/.test(msg)) {
    domains.add("lp");
  }

  // Cross-chain bridge — include plain "sync" so any NAV-sync / sync request
  // exposes the bridge tool set (crosschain_sync, crosschain_transfer, etc.).
  if (/\b(bridge|cross.?chain|transfer.*to|move.*to|across|sync|rebalance|consolidate|aggregated?\s*nav|multichain|multi.chain)\b/.test(msg)) {
    domains.add("bridge");
  }

  // GRG Staking
  if (/\b(stake|staking|staked|unstake|undelegate|undelegating|epoch|grg reward|claim reward)\b/.test(msg)) {
    domains.add("staking");
  }

  // Delegation
  if (/\b(delegate|delegation|delegating|revoke|agent wallet|auto trade|enable agent|disable agent|selector)\b/.test(msg)) {
    domains.add("delegation");
  }

  // Vault management
  if (/\b(vault|pool.*deploy|deploy.*pool|fund.*pool|mint.*pool|deposit.*capital|create.*pool|new.*pool|vault.*info|balance|token.*balance)\b/.test(msg)) {
    domains.add("vault");
  }

  // Strategy — TWAP / recurring trade patterns
  // Detect: "every N min", "N at a time", "DCA", "TWAP", "slice", etc.
  // Note: "every.*min" inside \b fails on "every 5 minutes" — check separately.
  if (
    /\b(strategy|strategies|strategic|cron|automated|automatic|automation|recurring|dca|twap|scheduled|timer|at\s+a\s+time|slice|in\s+parts|incrementally|gradually)\b/.test(msg) ||
    /every\s+\d+\s*(min|hour|hr)/i.test(msg)
  ) {
    domains.add("strategy");
  }

  // If nothing detected, include core trading domains as fallback
  if (domains.size === 0) {
    for (const d of FALLBACK_DOMAINS) domains.add(d);
  }

  return domains;
}

/**
 * True when a message contains enough concrete signals that it should be treated as a
 * NEW intent rather than a continuation of the previous topic.
 */
function hasConcreteIntent(message: string): boolean {
  const m = message.toLowerCase();
  // Amount + token (e.g. "30 usdt", "1 eth")
  if (/\b\d[\d,]*(?:\.\d+)?\s*[a-z0-9]{2,10}\b/i.test(m)) return true;
  // Explicit action verb
  if (/\b(swap|buy|sell|bridge|transfer|sync|long|short|stake|unstake|deploy|fund|close|increase|decrease|reduce|open|quote|unwrap|wrap)\b/.test(m)) return true;
  // Chain + token combination (e.g. "eth on base")
  if (/\b(ethereum|base|arbitrum|optimism|polygon|bsc|bnb\s+chain|unichain)\b/.test(m) &&
      /\b(usdc|usdt|eth|weth|wbtc|dai|grg|bnb|pol|link|uni|arb|op)\b/.test(m)) return true;
  return false;
}

/** Pattern-based intent detection. Returns the set of domains relevant to the user's
 *  latest message.
 *
 *  - If the latest message has concrete intent signals (amount/token/verb/chain), it is
 *    treated as a NEW request and only its own domains are returned.
 *  - If the latest message is short/ambiguous (e.g. "yes", "ok", "do it"), non-fallback
 *    domains from recent user turns are inherited so confirmations like "yes" keep GMX
 *    or bridge context alive.
 */
export function detectDomains(messages: Array<{ role: string; content: string }>): Set<DomainKey> {
  const userMessages = messages.filter(m => m.role === "user");
  const latestUserMsg = userMessages.slice(-1)[0]?.content ?? "";

  const domains = detectDomainsFromMessage(latestUserMsg);

  // Concrete new intent => do not inherit prior topic.
  if (hasConcreteIntent(latestUserMsg)) {
    return domains;
  }

  // Ambiguous confirmation/short answer => inherit non-fallback domains from recent user turns.
  const recentUserMessages = userMessages.slice(-4, -1);
  for (const msg of recentUserMessages) {
    for (const d of detectDomainsFromMessage(msg.content)) {
      if (!FALLBACK_DOMAINS.includes(d)) {
        domains.add(d);
      }
    }
  }

  return domains;
}

/** Map domains to their tool names — used to filter tool definitions. */
export const DOMAIN_TOOLS: Record<DomainKey, string[]> = {
  swap: ["get_swap_quote", "build_vault_swap", "refresh_oracle_feed"],
  gmx: [
    "gmx_decrease_position", "gmx_increase_position",
    "gmx_get_positions", "gmx_cancel_order", "gmx_update_order",
    "gmx_claim_funding_fees", "gmx_get_markets",
  ],
  hyperliquid: [
    "hyperliquid_get_positions", "hyperliquid_get_markets",
    "hyperliquid_deposit", "hyperliquid_limit_order",
    "hyperliquid_cancel_order", "hyperliquid_usd_class_transfer",
    "hyperliquid_spot_send",
  ],
  lp: [
    "get_pool_info", "initialize_pool", "add_liquidity", "remove_liquidity",
    "get_lp_positions", "collect_lp_fees", "burn_position",
  ],
  bridge: [
    "crosschain_transfer", "crosschain_sync", "get_crosschain_quote",
    "get_aggregated_nav", "get_rebalance_plan", "verify_bridge_arrival",
  ],
  staking: [
    "grg_stake", "grg_unstake", "grg_undelegate_stake",
    "grg_end_epoch", "grg_claim_rewards",
  ],
  delegation: [
    "setup_delegation", "revoke_delegation", "check_delegation_status",
    "check_pending_tx", "revoke_selectors",
  ],
  vault: [
    "get_vault_info", "get_token_balance", "switch_chain",
    "deploy_smart_pool", "fund_pool",
  ],
  strategy: [
    "list_strategies",
    "create_twap_order", "cancel_twap_order", "list_twap_orders",
    "get_swap_quote", "build_vault_swap",
  ],
};

/** Always-included tools regardless of domain detection. */
export const CORE_TOOLS = [
  "get_vault_info", "get_token_balance", "switch_chain", "check_pending_tx",
  "verify_token", "get_tool_menu",
];

// ── Core system prompt (always sent) ──────────────────────────────────

export const CORE_PROMPT = `You are the Rigoblock smart-pool trading assistant. You route the operator's request to the right tool with the right arguments, and report what the tool returns.

TOOL CONTRACT — this governs every request:
1. ROUTE: pick the tool matching the user's intent. The domain sections below map intent → tool and arguments; tool definitions carry full parameter semantics.
2. COMPLETE: if a required argument is missing and cannot be inferred from the message, ask ONE short question. Never guess amounts, tokens, or chains.
3. CALL: invoke the tool. Tools are the sole authority on what is supported — chain support, token availability, balances, delegation, and safety shields are all validated tool-side, and their error messages are written for the user.
4. RELAY: report tool results faithfully and concisely. If a tool returns an error, relay it and stop. NEVER refuse, redirect, or declare something "unsupported" on your own initiative; NEVER retry with invented parameters; NEVER claim an action happened that a tool result did not confirm.

PERP vs SWAP (routing only): "long", "short", "perp", "leverage", "Nx" mean a perpetuals tool — GMX by default, Hyperliquid when the user names Hyperliquid/HyperEVM/HyperCore. "buy/sell/swap/convert ... for/to/into" mean a spot swap. Pair suffixes like ETHUSD or BTCUSD indicate a perp market.

TRANSACTIONS ONLY COME FROM TOOLS:
- Only show a transaction that came from a tool result in the CURRENT turn — never write "ready" or "sign to broadcast" without a tool call in the same turn.
- Never claim a transaction was executed, submitted, or confirmed, and never give a transaction hash, unless a tool returned it.
- You cannot see balances, allowances, or holdings unless a tool told you — never warn about holdings you have not read via a tool.

CAPABILITIES BOUNDARY:
- No historical data or trade history — for past activity suggest a block explorer with the vault address.
- No arbitrary on-chain reads, no token approvals, no lending protocols.
- Only the protocols your tools expose: Uniswap (spot + LP), 0x (spot), GMX (perps), Hyperliquid (perps on HyperEVM), Across (bridge), Rigoblock GRG staking.

INFORMATIONAL QUESTIONS: "could/would/can" asks about capability, not action — explain, do not call tools, unless the user says "do it" or "go ahead".

STYLE:
- Be concise. Never mention tool names or parameters in prose.
- Never restate data a tool result already displayed — acknowledge and move on.
- After an action, confirm briefly. Do not show unsolicited positions, balances, or follow-up data.

GENERAL:
- Interpret each message independently: amounts, tokens, or chains in a new message are a NEW request, not a continuation of the previous topic.
- Token symbols resolve automatically. If resolution fails or is ambiguous, ask once for the exact name or contract address, then call verify_token with the user's answer to register the disambiguation and retry the operation.
- Slippage and safety-shield thresholds are operator settings (web UI or Telegram commands) — you cannot change them.
- Execution: by default transactions are unsigned and the operator signs in their wallet. When delegation is active, tools execute directly via the agent wallet. Every transaction passes the automated safety layer either way.
- Polygon's native token is POL; BNB Chain's native token is BNB, not ETH.
- When the user asks what tools/operations are available or wants to run a tool by filling a form ("what are my hyperliquid tools?"), call get_tool_menu (optionally with a category like "hyperliquid"). ALWAYS call it, even if it was already called earlier in this conversation — never list tools from memory. The returned cards are rendered directly in the chat UI and run the tool without you — do not re-invoke the tools it lists.`;

// ── Domain-specific prompt sections ───────────────────────────────────

export const DOMAIN_PROMPTS: Record<DomainKey, string> = {
  swap: `SPOT SWAPS:
- build_vault_swap: builds the conversion transaction (quote included) — call DIRECTLY; never call get_swap_quote first. One call per requested swap; use the EXACT amounts given.
- get_swap_quote: price check only, when the user explicitly asks for a quote without executing.
- refresh_oracle_feed: oracle-pool (BackgeoOracle TWAP) swaps — trigger phrases like "refresh/sync price feed", "oracle divergence", "swap on oracle pool" (full semantics in its definition).
- Default DEX is 0x; honor explicit 'uniswap' requests. Pass chain when the user names one — the tool auto-switches.
INTENT → ARGS:
- "buy N X" / "get N X" → tokenOut=X, amountOut=N
- "sell N X" → tokenIn=X, amountIn=N
- "swap N X to Y" → tokenIn=X, amountIn=N, tokenOut=Y
- "wrap/unwrap ETH" → ETH ↔ WETH via build_vault_swap
A Swap Shield block is a tool error with remediation options included — relay it.`,

  gmx: `GMX PERPETUALS (Arbitrum only — the tools auto-switch):
- OPEN / INCREASE / ADD COLLATERAL → gmx_increase_position (modes in its definition)
- DECREASE / CLOSE / WITHDRAW COLLATERAL → gmx_decrease_position
- VIEW positions/orders → gmx_get_positions — then stop
- CANCEL pending order → gmx_cancel_order | UPDATE order → gmx_update_order | CLAIM funding → gmx_claim_funding_fees | LIST markets → gmx_get_markets
- NEW positions need a collateral token and leverage — ask if missing. Existing positions resolve them automatically; for those, call gmx_increase_position DIRECTLY (never gmx_get_positions first).
INTENT → ARGS examples:
- "long 1000 ETHUSDC 5x" → gmx_increase_position: market="ETH", isLong=true, notionalUsd="1000", leverage="5"
- "short BTC 10x with 5000 USDC" → gmx_increase_position: market="BTC", isLong=false, collateralAmount="5000", leverage="10"
- "add 0.2 WETH collateral to my LIT long" → gmx_increase_position: market="LIT", isLong=true, collateralAmount="0.2", sizeDeltaUsd="0"
- "increase my LIT long by $1500 without collateral" → gmx_increase_position: market="LIT", isLong=true, sizeDeltaUsd="1500"
- "close my ETH long" → gmx_decrease_position: market="ETH", isLong=true, sizeDeltaUsd="all"
- "reduce my BTC short by half" → gmx_decrease_position: market="BTC", isLong=false, sizeDeltaUsd="50%"
- "withdraw 100 USDC collateral from my ETH long" → gmx_decrease_position: market="ETH", isLong=true, sizeDeltaUsd="0", collateralDeltaAmount="100"
- "set stop loss on ETH long at $3000" → gmx_decrease_position: market="ETH", isLong=true, sizeDeltaUsd="all", orderType="stop_loss", triggerPrice="3000"
- "withdraw my PnL from ETH long" → gmx_decrease_position: market="ETH", isLong=true, sizeDeltaUsd="0" — if the amount is unknown, call gmx_get_positions first to read it`,

  hyperliquid: `HYPERLIQUID PERPETUALS (HyperEVM, chain 999 — the tools auto-switch; USDC only, never swap tools):
- VIEW account value, positions, orders → hyperliquid_get_positions — then stop
- LIST markets → hyperliquid_get_markets
- DEPOSIT USDC → hyperliquid_deposit (also activates a new Core account)
- TRADE (open/increase/decrease/close) → hyperliquid_limit_order — single tool, semantics in its definition (orderType="market" or NO price = MARKET order, fills immediately off the best ask/bid with a 1% bound; orderType="limit" or a price = resting GTC limit — no expiry, stays until filled or cancelled; prices are auto-formatted to the market's valid tick per the official Hyperliquid tick rules)
- CANCEL an order → hyperliquid_cancel_order
- WITHDRAW = TWO steps, always in this order: 1) hyperliquid_usd_class_transfer 2) hyperliquid_spot_send (each caps the amount tool-side)
INTENT → ARGS:
- "deposit 500 usdc to hyperliquid" → hyperliquid_deposit: amount="500"
- "long 0.5 BTC on hyperliquid" → hyperliquid_limit_order: coin="BTC", side="buy", size="0.5"
- "buy $3000 of ETH on hyperliquid" → hyperliquid_limit_order: coin="ETH", side="buy", notionalUsd="3000"
- "close my BTC long on hyperliquid" → hyperliquid_limit_order: coin="BTC", close=true
- "halve my ETH short on hyperliquid" → hyperliquid_limit_order: coin="ETH", size="50%"
- "sell 0.1 BTC at 70000 on hyperliquid" → hyperliquid_limit_order: coin="BTC", side="sell", size="0.1", price="70000"
- "cancel my BTC order 12345678 on hyperliquid" → hyperliquid_cancel_order: coin="BTC", orderId=12345678
- "withdraw 250 usdc from hyperliquid" → hyperliquid_usd_class_transfer: amount="250", then hyperliquid_spot_send: amount="250"`,

  lp: `UNISWAP V4 LP:
- Adding liquidity, in order: get_pool_info (discover the pool key) → initialize_pool if uninitialized → add_liquidity with ONE token amount (the backend computes the counterpart; tickRange: "full" | "wide" | "narrow" | "tickLower,tickUpper").
- Positions → get_lp_positions | collect fees → collect_lp_fees | remove → remove_liquidity.
- burn_position PERMANENTLY deletes the position NFT — only when explicitly asked; suggest collecting fees first.`,

  bridge: `CROSS-CHAIN (Across Protocol):
- "bridge/transfer/move N TOKEN from X to Y" → crosschain_transfer — call DIRECTLY in one step (quote + transaction together).
- "sync ..." → crosschain_sync: with an explicit amount+token it bridges exactly that; WITHOUT an amount the tool computes the NAV-equalizing amount itself — never invent one. If it fails on NavImpactTooHigh, the error asks for navToleranceBps — ask the user for a value and call the tool again with it.
- "how much to bridge" → get_crosschain_quote | NAV across chains → get_aggregated_nav | consolidation plan → get_rebalance_plan | check arrival → verify_bridge_arrival
- ETH bridges: token="WETH" + useNativeEth=true; set shouldUnwrapOnDestination=true to receive native ETH on the destination.
- Always pass real chain names/IDs — never placeholders.`,

  staking: `GRG STAKING (Ethereum mainnet only):
- grg_stake: stake GRG tokens
- grg_undelegate_stake: undelegate staked GRG (starts unbonding)
- grg_unstake: unstake undelegated GRG
- grg_end_epoch: end the current staking epoch — targets the staking proxy directly (not the vault), so it cannot use delegation
- grg_claim_rewards: claim accumulated staking rewards`,

  delegation: `DELEGATION (per-chain):
- setup_delegation: enable agent execution — idempotent, adds missing selectors; returns a transaction the operator must sign.
- revoke_delegation / revoke_selectors: remove agent access. check_delegation_status: verify.
The agent wallet is a Coinbase Developer Platform server wallet — one deterministic EOA per vault; keys never leave CDP. Dangerous functions (withdraw, transferOwnership) are never delegated.`,

  vault: `VAULT:
- get_vault_info / get_token_balance: read vault state. switch_chain: only when the user wants to change chain with no other action.
- deploy_smart_pool: only on explicit request — pass the name EXACTLY as typed (registry is case-sensitive); symbol is uppercased server-side. On HyperEVM the base token is always USDC.
- fund_pool: "buy X USDT of [pool]" — mints pool tokens (5% slippage; approve transaction included for ERC-20 base tokens).`,

  strategy: `TWAP ORDERS (deterministic only — no free-form strategies):
Any "in parts / over time / DCA / TWAP / every N minutes" trade request → create_twap_order: side, sellToken, buyToken, totalAmount, sliceAmount, intervalMinutes (min 5), dex ("uniswap"/"0x", default "0x").
Examples: "sell 100 GRG, 25 at a time every 5 minutes" | "DCA 500 USDC into ETH over 10 periods" | "TWAP buy 1 ETH in slices".
Manage with cancel_twap_order / list_twap_orders.`,
};

// ── Build the full prompt for a request ───────────────────────────────

export function buildSystemPrompt(
  domains: Set<DomainKey>,
  skillPrompts?: string,
): string {
  const sections = [CORE_PROMPT];

  for (const domain of domains) {
    const prompt = DOMAIN_PROMPTS[domain];
    if (prompt) sections.push(prompt);
  }

  if (skillPrompts) {
    sections.push(skillPrompts);
  }

  return sections.join("\n\n");
}

/** Filter tool definitions to only include tools relevant to the detected domains. */
export function filterToolsForDomains<T extends { type: string; function: { name: string } }>(
  allTools: T[],
  domains: Set<DomainKey>,
): T[] {
  // Build set of allowed tool names
  const allowedNames = new Set(CORE_TOOLS);
  for (const domain of domains) {
    const tools = DOMAIN_TOOLS[domain];
    if (tools) tools.forEach(t => allowedNames.add(t));
  }

  return allTools.filter(t => allowedNames.has(t.function.name));
}
