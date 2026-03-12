/**
 * Tool definitions for LLM function calling.
 *
 * Phase 1: Agent builds unsigned transactions, operator signs from their wallet.
 * One-step flow: user asks → build_vault_swap → transaction modal immediately.
 */

/**
 * OpenAI-compatible tool definitions for function calling.
 */
export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "get_swap_quote",
      description:
        "Get a price-only quote WITHOUT building a transaction. Use ONLY when the user explicitly asks for a price or quote without wanting to execute. " +
        "For actual swap requests (buy/sell/swap), use build_vault_swap instead.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: {
            type: "string",
            description: "Token to sell — symbol (e.g., ETH, USDC) or address",
          },
          tokenOut: {
            type: "string",
            description: "Token to buy — symbol (e.g., ETH, USDC) or address",
          },
          amountIn: {
            type: "string",
            description: "Amount to sell (human-readable). Use for EXACT_INPUT.",
          },
          amountOut: {
            type: "string",
            description: "Amount to buy (human-readable). Use for EXACT_OUTPUT.",
          },
          dex: {
            type: "string",
            description:
              "DEX to use: '0x' or 'uniswap'. Default is '0x' (aggregator, best prices). " +
              "If the user previously used a specific DEX in this conversation, keep using it. " +
              "When user says 'uniswap' → set dex='uniswap'. When user says '0x'/'zero x'/'zerox'/'aggregator' → set dex='0x'.",
          },
          chain: {
            type: "string",
            description:
              "Target chain name or ID (e.g., 'Arbitrum', 'Base', 'Unichain'). " +
              "Include this when the user mentions a chain. Auto-switches if different from current.",
          },
        },
        required: ["tokenIn", "tokenOut"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "build_vault_swap",
      description:
        "Build an unsigned swap transaction for the operator to sign. Call this DIRECTLY when the user wants to swap/buy/sell tokens. " +
        "Internally fetches a quote and builds the transaction in one step. " +
        "The frontend will show a confirmation modal with the quote details. " +
        "If the user mentions a target chain, include the chain parameter — do NOT call switch_chain separately.",
      parameters: {
        type: "object",
        properties: {
          tokenIn: {
            type: "string",
            description: "Token to sell — symbol (e.g., ETH, USDC) or address",
          },
          tokenOut: {
            type: "string",
            description: "Token to buy — symbol (e.g., ETH, USDC) or address",
          },
          amountIn: {
            type: "string",
            description: "Amount to sell (human-readable). Use for EXACT_INPUT.",
          },
          amountOut: {
            type: "string",
            description: "Amount to buy (human-readable). Use for EXACT_OUTPUT.",
          },
          dex: {
            type: "string",
            description:
              "DEX to use: '0x' or 'uniswap'. Default is '0x' (aggregator, best prices). " +
              "If the user previously used a specific DEX in this conversation, keep using it. " +
              "When user says 'uniswap' → set dex='uniswap'. When user says '0x'/'zero x'/'zerox'/'aggregator' → set dex='0x'.",
          },
          chain: {
            type: "string",
            description:
              "Target chain name or ID (e.g., 'Arbitrum', 'Base', 'Unichain'). " +
              "Include this when the user mentions a chain. Auto-switches if different from current.",
          },
        },
        required: ["tokenIn", "tokenOut"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_vault_info",
      description: "Get vault name, symbol, owner, total supply.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_token_balance",
      description: "Check vault balance of a specific token.",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token symbol or address",
          },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "switch_chain",
      description:
        "Switch active chain. Call when user mentions a different chain, then proceed with their request.",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain name or ID (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Unichain, Sepolia)",
          },
        },
        required: ["chain"],
      },
    },
  },

  // ── GMX Perpetuals Tools ────────────────────────────────────────────

  {
    type: "function" as const,
    function: {
      name: "gmx_open_position",
      description:
        "Open a new leveraged perpetual position on GMX v2 (Arbitrum only). " +
        "Builds an unsigned createIncreaseOrder transaction. " +
        "If not on Arbitrum, auto-switches. The vault must have sufficient collateral. " +
        "The adapter handles execution fees automatically. Default collateral is always USDC.",
      parameters: {
        type: "object",
        properties: {
          market: {
            type: "string",
            description: "Market to trade — index token symbol (e.g., 'ETH', 'BTC', 'ARB', 'SOL', 'LINK'). May include 'USD'/'USDC' suffix (e.g. 'ETHUSDC') — the suffix is ignored.",
          },
          collateral: {
            type: "string",
            description: "Collateral token symbol (e.g., 'USDC', 'WETH', 'USDT'). Default: USDC for all positions.",
          },
          collateralAmount: {
            type: "string",
            description: "Amount of collateral in human-readable units (e.g., '200' USDC). If notionalUsd and leverage are given instead, collateral = notionalUsd / leverage.",
          },
          notionalUsd: {
            type: "string",
            description: "Notional position size in USD (e.g., '1000'). When used with leverage, collateral is derived as notionalUsd / leverage. Use when user says 'long 1000 ETHUSDC 5x'.",
          },
          sizeDeltaUsd: {
            type: "string",
            description: "Position size in USD (e.g., '5000' for $5,000 position). Determines leverage = sizeDeltaUsd / collateralValue.",
          },
          isLong: {
            type: "boolean",
            description: "true for long (profit when price rises), false for short (profit when price falls)",
          },
          leverage: {
            type: "string",
            description: "Desired leverage (e.g., '5' for 5x). If provided without sizeDeltaUsd, the system computes sizeDeltaUsd = collateralValue * leverage.",
          },
        },
        required: ["market", "isLong"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_close_position",
      description:
        "Close (fully or partially) an existing GMX v2 perpetual position. " +
        "Builds an unsigned createDecreaseOrder transaction. " +
        "To close fully, set sizeDeltaUsd to the full position size. " +
        "To partially close, set a smaller sizeDeltaUsd.",
      parameters: {
        type: "object",
        properties: {
          market: {
            type: "string",
            description: "Market index token symbol (e.g., 'ETH', 'BTC')",
          },
          isLong: {
            type: "boolean",
            description: "true for long, false for short — must match the open position",
          },
          sizeDeltaUsd: {
            type: "string",
            description: "Amount to decrease in USD (e.g., '5000'). Use 'all' or the full position size to close entirely.",
          },
          collateral: {
            type: "string",
            description: "Collateral token symbol used in the position (e.g., 'WETH', 'USDC')",
          },
          collateralDeltaAmount: {
            type: "string",
            description: "Amount of collateral to withdraw (default: '0' — only decrease size)",
          },
          orderType: {
            type: "string",
            description: "Order type: 'market' (default), 'limit', or 'stop_loss'",
          },
          triggerPrice: {
            type: "string",
            description: "Trigger price in USD for limit/stop-loss orders",
          },
        },
        required: ["market", "isLong"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_increase_position",
      description:
        "Increase an existing GMX v2 position size or add collateral. " +
        "Same as gmx_open_position but intended for adding to existing positions.",
      parameters: {
        type: "object",
        properties: {
          market: {
            type: "string",
            description: "Market index token symbol (e.g., 'ETH', 'BTC')",
          },
          collateral: {
            type: "string",
            description: "Collateral token symbol",
          },
          collateralAmount: {
            type: "string",
            description: "Additional collateral amount to add",
          },
          sizeDeltaUsd: {
            type: "string",
            description: "Additional position size in USD",
          },
          isLong: {
            type: "boolean",
            description: "true for long, false for short",
          },
          leverage: {
            type: "string",
            description: "Desired leverage for the additional size",
          },
        },
        required: ["market", "collateralAmount", "isLong"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_get_positions",
      description:
        "Get all open GMX v2 perpetual positions and pending orders for the vault. " +
        "Returns a detailed dashboard with unrealized PnL, entry/mark prices, leverage, and funding costs. " +
        "Arbitrum only — auto-switches if needed.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_cancel_order",
      description:
        "Cancel a pending GMX v2 order. Recovers collateral and execution fees back to the vault. " +
        "Note: GMX enforces a 300-second delay before cancellation is allowed.",
      parameters: {
        type: "object",
        properties: {
          orderKey: {
            type: "string",
            description: "The order key (bytes32 hex) to cancel. Get this from gmx_get_positions.",
          },
        },
        required: ["orderKey"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_update_order",
      description:
        "Update a pending limit/stop-loss GMX v2 order. Only works for LimitIncrease, LimitDecrease, or StopLossDecrease orders.",
      parameters: {
        type: "object",
        properties: {
          orderKey: {
            type: "string",
            description: "The order key (bytes32 hex) to update",
          },
          sizeDeltaUsd: {
            type: "string",
            description: "New size delta in USD",
          },
          triggerPrice: {
            type: "string",
            description: "New trigger price in USD",
          },
          acceptablePrice: {
            type: "string",
            description: "New acceptable execution price in USD",
          },
        },
        required: ["orderKey", "sizeDeltaUsd", "triggerPrice", "acceptablePrice"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_claim_funding_fees",
      description:
        "Claim accumulated funding fees from GMX v2 positions. Tokens are sent to the vault.",
      parameters: {
        type: "object",
        properties: {
          markets: {
            type: "array",
            items: { type: "string" },
            description: "Array of GMX market addresses to claim from. Leave empty to auto-detect from open positions.",
          },
          tokens: {
            type: "array",
            items: { type: "string" },
            description: "Array of token addresses (one per market). Leave empty to auto-detect.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmx_get_markets",
      description:
        "List available GMX v2 perpetual markets on Arbitrum with current prices and symbols.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  // ── Delegation Management Tools ─────────────────────────────────────

  {
    type: "function" as const,
    function: {
      name: "setup_delegation",
      description:
        "Set up delegation so the agent wallet can execute trades on the vault without manual signing. " +
        "Creates an agent wallet and returns an unsigned updateDelegation() transaction for the operator to sign. " +
        "The operator must sign and broadcast this transaction to enable delegated execution.",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain to set up delegation on (e.g., 'Arbitrum', 'Base'). Uses current chain if omitted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "revoke_delegation",
      description:
        "Revoke the agent wallet's delegation on the vault. " +
        "Returns an unsigned revokeAllDelegations() transaction for the operator to sign. " +
        "After the operator sends this, the agent can no longer execute trades on the vault.",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain to revoke delegation on. Uses current chain if omitted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_delegation_status",
      description:
        "Check whether delegation is currently active for the agent on the vault, including on-chain verification. " +
        "Returns which selectors are delegated and which are not.",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain to check. Uses current chain if omitted.",
          },
        },
        required: [],
      },
    },
  },

  // ── Pool Deployment ─────────────────────────────────────────────────

  {
    type: "function" as const,
    function: {
      name: "deploy_smart_pool",
      description:
        "Deploy a new Rigoblock smart pool via the RigoblockPoolProxyFactory. " +
        "Returns an unsigned createPool() transaction for the operator to sign. " +
        "After deployment, the operator can set the new pool address in the interface. " +
        "Default base tokens: ETH (address(0)) or USDC. User can also paste a custom token address.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Pool name (e.g., 'My Trading Pool')",
          },
          symbol: {
            type: "string",
            description: "Pool symbol (e.g., 'MTP'). 3-5 uppercase chars recommended.",
          },
          baseToken: {
            type: "string",
            description: "Base token symbol (ETH, USDC) or address. Default: ETH (address(0)).",
          },
          chain: {
            type: "string",
            description: "Chain to deploy on. Uses current chain if omitted.",
          },
        },
        required: ["name", "symbol"],
      },
    },
  },

  // ── Pool Funding (Mint) ─────────────────────────────────────────────

  {
    type: "function" as const,
    function: {
      name: "fund_pool",
      description:
        "Fund (mint into) the current Rigoblock smart pool by depositing the pool's base token. " +
        "Returns an unsigned mint() transaction (and approve() if base token is ERC-20). " +
        "The pool's base token and NAV are read on-chain automatically. " +
        "Applies 5% slippage protection on the minimum pool tokens received. " +
        "For ERC-20 base tokens, an approve transaction is built first. " +
        "For native ETH base tokens, the mint is sent with msg.value.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Amount of base token to deposit (human-readable, e.g., '1.5' ETH or '1000' USDC).",
          },
          recipient: {
            type: "string",
            description: "Address to receive pool tokens. Defaults to the operator's wallet address.",
          },
        },
        required: ["amount"],
      },
    },
  },

  // ── Cross-chain (AIntents + Across Protocol) ────────────────────────

  {
    type: "function" as const,
    function: {
      name: "crosschain_transfer",
      description:
        "Bridge tokens from the vault on one chain to the same vault on a destination chain. " +
        "Uses the Across Protocol via the AIntents adapter. The vault must hold the token being bridged. " +
        "Supported tokens: USDC, USDT, WETH, WBTC (not all tokens on all chains). " +
        "Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Unichain. " +
        "The transfer burns virtual supply on the source chain and mints via donate on the destination. " +
        "Requires the depositV3 selector to be delegated (same as other vault operations). " +
        "IMPORTANT: sourceChain defaults to the current chain if not specified, but ALWAYS include it " +
        "when the user mentions a source (e.g., 'bridge USDC from Base to Arbitrum').",
      parameters: {
        type: "object",
        properties: {
          sourceChain: {
            type: "string",
            description: "Source chain name or ID (e.g., 'Base', 'Arbitrum'). Defaults to current chain if omitted.",
          },
          destinationChain: {
            type: "string",
            description: "Destination chain name or ID (e.g., 'Arbitrum', 'Base', '42161').",
          },
          token: {
            type: "string",
            description: "Token to bridge — symbol (USDC, USDT, WETH, WBTC).",
          },
          amount: {
            type: "string",
            description: "Amount to bridge (human-readable, e.g., '1000' USDC or '0.5' WETH).",
          },
        },
        required: ["destinationChain", "token", "amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "crosschain_sync",
      description:
        "Synchronise NAV data from one chain to a destination chain. " +
        "Uses a small token amount to carry the sync message via Across Protocol. " +
        "This validates NAV impact tolerance without moving significant tokens. " +
        "Token and amount are AUTO-CALCULATED if not provided — the agent picks the cheapest " +
        "bridgeable token with sufficient balance and uses the minimum amount to cover fees. " +
        "Useful when the vault has positions on multiple chains and needs NAV consistency.",
      parameters: {
        type: "object",
        properties: {
          sourceChain: {
            type: "string",
            description: "Source chain name or ID. Defaults to current chain if omitted.",
          },
          destinationChain: {
            type: "string",
            description: "Destination chain name or ID (e.g., 'Arbitrum', 'Base').",
          },
          token: {
            type: "string",
            description: "Token to use for the sync message (USDC, USDT, WETH, WBTC). Auto-selected if omitted.",
          },
          amount: {
            type: "string",
            description: "Amount to carry the sync. Auto-calculated if omitted (minimum to cover fees).",
          },
          navToleranceBps: {
            type: "number",
            description: "NAV tolerance in basis points (default: 100 = 1%). Higher values allow more NAV divergence.",
          },
        },
        required: ["destinationChain"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_crosschain_quote",
      description:
        "Get a cross-chain bridge fee quote without executing. Shows the estimated output, fee percentage, " +
        "and estimated fill time. Use when the user asks 'how much to bridge?' or 'what's the bridge fee?'.",
      parameters: {
        type: "object",
        properties: {
          sourceChain: {
            type: "string",
            description: "Source chain name or ID. Defaults to current chain.",
          },
          destinationChain: {
            type: "string",
            description: "Destination chain name or ID.",
          },
          token: {
            type: "string",
            description: "Token to bridge (USDC, USDT, WETH, WBTC).",
          },
          amount: {
            type: "string",
            description: "Amount to bridge (human-readable).",
          },
        },
        required: ["destinationChain", "token", "amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_aggregated_nav",
      description:
        "Read the vault's NAV data and bridgeable token balances across ALL supported chains. " +
        "Returns per-chain NAV (unitary value, total value, base token), token balances, " +
        "delegation status, and aggregate totals. " +
        "Also checks which chains have agent delegation set up and which are missing. " +
        "Use this to give the operator a full cross-chain portfolio overview, " +
        "or before recommending rebalancing operations.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_rebalance_plan",
      description:
        "Analyse the vault's cross-chain positions and recommend the minimum set of bridge " +
        "operations needed to consolidate tokens to a target chain. " +
        "Reads NAV + balances on all chains, then computes one bridge per (source, token type). " +
        "Includes fee estimates for each operation and flags chains missing agent delegation. " +
        "If targetChain is omitted, auto-selects the chain with the most value.",
      parameters: {
        type: "object",
        properties: {
          targetChain: {
            type: "string",
            description: "Chain to consolidate everything to (e.g., 'Arbitrum', 'Base'). Auto-selected if omitted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_strategy",
      description:
        "Create an automated strategy for this vault. The strategy runs on a timer (cron) and sends " +
        "recommendations via Telegram — the operator must confirm before execution. " +
        "Supports any instruction the LLM can evaluate: rebalancing, DCA purchases, limit orders, etc. " +
        "Up to 3 strategies per vault. Requires Telegram to be paired.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description:
              "Natural language instruction for the strategy, e.g. " +
              "'Rebalance all tokens to Base, keeping NAV impact below 10%', " +
              "'Buy 100 GRG with ETH if GRG/ETH price is below 0.001', " +
              "'Check if any chain has more than 50% of total NAV and suggest rebalancing'",
          },
          intervalMinutes: {
            type: "number",
            description:
              "How often to check, in minutes. Minimum 5. Examples: 5 (every 5 min), " +
              "60 (hourly), 480 (every 8 hours), 1440 (daily). Default: 480.",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_strategy",
      description:
        "Remove an automated strategy by ID. Use list_strategies to see IDs. " +
        "Pass id=0 to remove ALL strategies for this vault.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "Strategy ID to remove (from list_strategies), or 0 to remove all.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_strategies",
      description:
        "List all automated strategies for the current vault, showing their ID, instruction, " +
        "interval, status (active/paused), last run time, and error count.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

/**
 * System prompt — kept concise for fast inference with gpt-5-mini.
 */
export const SYSTEM_PROMPT = `You are a trading assistant for a Rigoblock vault.
You build unsigned swap and perpetual trading transactions.
The operator reviews and signs them in their browser wallet.

PERPETUAL vs SWAP DISAMBIGUATION — TOP PRIORITY:
When the user says "long" or "short", this is ALWAYS a GMX perpetual position, NEVER a spot swap.
- "long 100 UNIUSD 5x" → GMX perp: gmx_open_position(market="UNI", isLong=true, notionalUsd="100", leverage="5")
- "short 500 ETHUSDC 3x" → GMX perp: gmx_open_position(market="ETH", isLong=false, notionalUsd="500", leverage="3")
- "long ETH" → GMX perp (ask for size/leverage if missing)
Keywords that ALWAYS mean GMX perpetuals: long, short, perp, leverage, Nx (5x, 10x, etc.), position, margin.
Keywords that mean spot swap: buy, sell, swap, exchange, convert, trade ... for/to/into.
If in doubt between perp and swap, treat "long/short" as a GMX perpetual.
Pair suffixes like USD, USDC, USDT after a token symbol (e.g. ETHUSD, UNIUSDC, BTCUSD) indicate a GMX perpetual market, not a swap pair.

SUPPORTED DEXs (SWAPS):
- Uniswap: Routes through Universal Router. Supports exact-input AND exact-output.
- 0x: Routes through AllowanceHolder contract. 150+ liquidity sources. Supports both amountIn and amountOut.

SUPPORTED PERPS (PERPETUAL FUTURES):
- GMX v2: Leveraged perpetual positions on Arbitrum only. Markets include ETH, BTC, ARB, SOL, LINK, UNI, and more.
  The vault adapter handles all GMX interactions (execution fees, collateral transfers, etc.) automatically.
  No multicall needed — each tool call produces one transaction.

DEX PREFERENCE:
- If the user explicitly says "uniswap", set dex="uniswap".
- If the user explicitly says "0x"/"zero x"/"zerox"/"aggregator", set dex="0x".
- If the user previously used a specific DEX in this conversation, keep using it.
- If no preference, default to 0x (aggregator with 150+ sources and best prices).
- Always honor explicit DEX requests.

CHAIN HANDLING:
- build_vault_swap and get_swap_quote accept a "chain" parameter.
- When the user mentions a chain (e.g., "swap on Arbitrum", "buy on Base", "on ethereum"), you MUST include chain in the tool call.
- CRITICAL: The current session chain may differ from what the user asks. ALWAYS pass the chain parameter when the user names a chain, even if you think it's already selected.
- The system auto-switches chains. Do NOT call switch_chain before a swap — just include the chain parameter.
- Only use switch_chain when the user wants to change chain WITHOUT a swap (e.g., "switch to Base").
- NEVER ask for confirmation when the user already specified the chain in their message.

MULTI-CHAIN SWAPS:
When the user requests multiple swaps in one message (e.g., "buy 300 GRG on Ethereum, buy 100 GRG on Arbitrum"):
- Make ONE build_vault_swap call PER swap, each with its own chain and amount.
- Use the EXACT amount specified for each swap. Do NOT duplicate amounts across calls.
- Each call MUST have the correct chain parameter matching that specific swap.
- Example: "buy 300 GRG on ethereum, buy 100 GRG on arbitrum" → two calls:
  1. build_vault_swap(tokenIn=ETH, tokenOut=GRG, amountOut="300", chain="ethereum")
  2. build_vault_swap(tokenIn=ETH, tokenOut=GRG, amountOut="100", chain="arbitrum")
When the user corrects or changes a previous request (e.g., "no, do it on base and optimism instead"):
- ONLY include swaps from the CURRENT message. Do NOT re-include trades from previous turns.
- The previous trades are cancelled. Build new tool calls only for what the user is asking NOW.

GMX PERPETUALS:
- GMX is ONLY available on Arbitrum. If on another chain, auto-switch to Arbitrum.
- To open a position: use gmx_open_position. Requires market (e.g. "ETH") and isLong.
- To close: use gmx_close_position. sizeDeltaUsd="all" closes the full position.
- To increase: use gmx_increase_position (same flow as open).
- To view positions: use gmx_get_positions. Shows a dashboard with PnL, leverage, entry/mark prices.
- To cancel pending order: use gmx_cancel_order with the orderKey from gmx_get_positions.
- To set stop-loss or take-profit: use gmx_close_position with orderType="stop_loss" or "limit" and a triggerPrice.
- Default collateral: ALWAYS USDC (for both longs and shorts), unless user explicitly specifies otherwise.
- Market symbols may include USD/USDC suffix (ETHUSDC, ETHUSD, ETH all mean the ETH/USD market).
- NOTIONAL (USD) SYNTAX: "long 1000 ETHUSDC 5x" means notionalUsd=1000, leverage=5, so collateral = 1000/5 = 200 USDC.
  When a number appears before a market pair like ETHUSDC/BTCUSD, it is the NOTIONAL USD SIZE, not collateral.
- COLLATERAL SYNTAX: "long ETH 5x with 0.5 ETH" means collateral 0.5 ETH, leverage 5x → explicit collateral.
- If user says "long ETH 5x with 200 USDC" → market="ETH", isLong=true, collateralAmount="200", leverage="5".
- If user says "short BTC 10x with 5000 USDC" → market="BTC", isLong=false, collateralAmount="5000", leverage="10".
- If no leverage/sizeDeltaUsd given, ask for one or default to moderate leverage (e.g. 2x-5x).
- claimFundingFees: use gmx_claim_funding_fees to claim accumulated funding.
- Available markets: use gmx_get_markets to see what's tradeable.

ONE-STEP FLOW:
When the user wants to swap, buy, or sell tokens, call build_vault_swap DIRECTLY.
Do NOT call get_swap_quote first. The build tool fetches the quote internally and
the frontend shows a confirmation modal with full details.
Only use get_swap_quote if the user explicitly asks for a price check without executing.

INTENT PARSING — CRITICAL:
The number ALWAYS belongs to the token it is adjacent to in the user's message. Parse carefully:
- "buy 100 GRG with ETH" → the user wants to RECEIVE 100 GRG. tokenIn=ETH, tokenOut=GRG, amountOut="100"
- "buy 50 GRG using ETH" → the user wants to RECEIVE 50 GRG. tokenIn=ETH, tokenOut=GRG, amountOut="50"
- "sell 0.5 ETH for USDC" → the user wants to SELL 0.5 ETH. tokenIn=ETH, tokenOut=USDC, amountIn="0.5"
- "swap 50 USDC to DAI" → the user wants to SELL 50 USDC. tokenIn=USDC, tokenOut=DAI, amountIn="50"
- "buy 100 GRG with ETH on Arbitrum using 0x" → tokenIn=ETH, tokenOut=GRG, amountOut="100", chain="Arbitrum", dex="0x"
- "get 200 USDC for ETH" → the user wants to RECEIVE 200 USDC. tokenIn=ETH, tokenOut=USDC, amountOut="200"

Key rule: "buy N TOKEN" ALWAYS means amountOut=N with tokenOut=TOKEN.
The number N is the amount of the TOKEN next to it, NOT the other token.
NEVER set amountIn when the user says "buy" — "buy" ALWAYS means amountOut.
Provide exactly ONE of amountIn or amountOut, never both.

GMX INTENT PARSING:
- "long 1000 ETHUSDC 5x" → gmx_open_position: market="ETH", isLong=true, notionalUsd="1000", leverage="5" (collateral = 1000/5 = 200 USDC)
- "long 100 UNIUSD 5x" → gmx_open_position: market="UNI", isLong=true, notionalUsd="100", leverage="5" (collateral = 100/5 = 20 USDC)
- "long 500 BTCUSD 10x" → gmx_open_position: market="BTC", isLong=true, notionalUsd="500", leverage="10" (collateral = 500/10 = 50 USDC)
- "short 2000 SOLUSD 4x" → gmx_open_position: market="SOL", isLong=false, notionalUsd="2000", leverage="4" (collateral = 2000/4 = 500 USDC)
- "long ETH 5x with 0.5 ETH" → gmx_open_position: market="ETH", isLong=true, collateralAmount="0.5", collateral="ETH", leverage="5"
- "long ETH 5x with 200 USDC" → gmx_open_position: market="ETH", isLong=true, collateralAmount="200", leverage="5"
- "short BTC with 5000 USDC at 10x" → gmx_open_position: market="BTC", isLong=false, collateralAmount="5000", leverage="10"
- "open a $10000 long on ETH with 1 ETH" → gmx_open_position: market="ETH", isLong=true, collateralAmount="1", collateral="ETH", sizeDeltaUsd="10000"
- "close my ETH long" → gmx_close_position: market="ETH", isLong=true, sizeDeltaUsd="all"
- "reduce ETH long by $5000" → gmx_close_position: market="ETH", isLong=true, sizeDeltaUsd="5000"
- "set stop loss on ETH long at $3000" → gmx_close_position: market="ETH", isLong=true, sizeDeltaUsd="all", orderType="stop_loss", triggerPrice="3000"
- "show my perps" / "show positions" / "gmx positions" → gmx_get_positions
- "what markets are available on gmx" → gmx_get_markets

RULES:
- ALWAYS use actual tool calls, never write tool names as text.
- If a previous call errored, still use tools for new requests.
- Token symbols resolve automatically (CoinGecko). Don't ask for addresses.
- Users may use full token names (e.g., "chainlink", "uniswap", "wrapped bitcoin"). Always convert to the correct ticker symbol before calling tools: chainlink→LINK, uniswap→UNI, wrapped bitcoin→WBTC, ethereum→ETH, etc.
- If multiple tokens match, present the list and ask the user to choose.
- Never check or mention token approvals (vault handles them).
- Don't check balances unless explicitly asked.
- On Polygon the native token is POL. On BNB Chain it's BNB, not ETH.
- Default slippage: 1% (100 bps) — hardcoded for safety, not adjustable. Be concise.
- When the user references a previous request (e.g., "proceed", "do it"), use the same parameters from the earlier message.

DELEGATION:
- Use setup_delegation when the user wants to enable the agent to trade automatically (e.g., "delegate", "enable agent", "auto-trade", "set up delegation").
- Use revoke_delegation when the user wants to revoke the agent (e.g., "revoke", "disable agent", "remove delegation").
- Use check_delegation_status when the user asks about delegation status (e.g., "is the agent delegated?", "check delegation").
- After setup_delegation, the operator must sign the returned transaction from their wallet.
- Delegation is per-chain: setting up on Arbitrum does NOT apply to Base. Mention this if relevant.

POOL DEPLOYMENT:
- Use deploy_smart_pool when the user wants to create a new Rigoblock smart pool.
- The user needs to provide a name and symbol. Base token defaults to ETH if not specified.
- Common base tokens: ETH (native), USDC.
- After deployment, the user should paste the new pool address from the receipt into the vault address field.
- If the user doesn't have a vault/pool yet and asks how to get started, suggest deploying one.

POOL FUNDING (MINT):
- Use fund_pool when the user wants to deposit capital into the pool (mint pool tokens).
- Keywords: fund, deposit, mint, add capital, add liquidity to pool, provide capital.
- The pool's base token and current NAV are read automatically — the user just specifies the amount.
- Slippage: 5% is applied automatically to protect against front-running.
- For ERC-20 base tokens (e.g., USDC), an approve transaction is required first.
- For native ETH base tokens, the mint is sent with msg.value (no approval needed).
- After funding, the user's wallet receives pool tokens proportional to the deposit.
- Suggest funding after a new pool is deployed (the pool needs initial capital).

CROSS-CHAIN (AINTENTS + ACROSS PROTOCOL):
- Use crosschain_transfer to bridge tokens between chains via the AIntents adapter and Across Protocol.
- Use crosschain_sync to synchronise NAV across chains (sends a small amount with a sync message).
  Token and amount are auto-calculated if omitted — just specify destinationChain.
- Use get_crosschain_quote to show bridge fees without executing.
- Use get_aggregated_nav to see the vault's NAV and token balances on ALL chains at once.
  This also shows which chains have delegation set up and which are missing.
- Use get_rebalance_plan to compute the optimal set of bridge operations to consolidate tokens to one chain.
  If targetChain is omitted, auto-selects the chain with the most value.
  Present the plan to the operator and ask which operations to execute.
- Keywords: bridge, cross-chain, transfer to [chain], move to [chain], sync NAV, synchronise,
  rebalance, consolidate, aggregate NAV, portfolio overview, multichain.
- Bridgeable tokens: USDC, USDT, WETH, WBTC (not all tokens available on all chains).
- Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Unichain.
- The vault must hold the bridged token on the source chain. Balance is checked automatically.
- Typical bridge fees: 0.01%-0.5% depending on route and amount. Max 2%.
- Fill time: usually 2s-10min depending on the route.
- The sourceChain and destinationChain parameters accept names ("Arbitrum", "Base") or chain IDs ("42161", "8453").
  ALWAYS include sourceChain when the user mentions a specific source (e.g. "bridge from Polygon").
- Requires depositV3 selector delegated for delegated execution mode.
- REBALANCING WORKFLOW: when a user says "rebalance" or "consolidate",
  1. Call get_aggregated_nav to see current positions.
  2. Call get_rebalance_plan (with user's preferred target chain if stated).
  3. Show the recommended operations (source → target, token, amount, fee) and ask which to execute.
  4. For each confirmed operation, call crosschain_transfer with the sourceChain, token, and amount.
  5. If the plan shows missing delegation on any source chain, inform the operator and ask them to set up delegation first.

AUTO-REBALANCE STRATEGY:
- Use create_strategy to set up any automated check: rebalancing, DCA, limit buys, etc.
- Use remove_strategy to delete a strategy by ID (or 0 for all). Use list_strategies to show them.
- Each strategy is a natural language instruction evaluated by the LLM on a cron timer.
- The cron sends recommendations via Telegram — the operator confirms before execution.
- Up to 3 strategies per vault. Minimum interval: 5 minutes. Default: 8 hours (480 min).
- Strategies auto-pause after 3 consecutive failures and notify the operator.
- Requires Telegram pairing. If not paired, tell the user to pair first.
- Keywords: automate, auto-rebalance, DCA, recurring, schedule, timer, every X hours.`;
