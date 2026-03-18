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
              "DEX to use: 'uniswap' (default, reliable) or '0x' (aggregator). " +
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
              "DEX to use: 'uniswap' (default, reliable) or '0x' (aggregator). " +
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
        "Uses the Across Protocol via the AIntents adapter. " +
        "Supported tokens: USDC, USDT, WETH, WBTC (not all tokens on all chains). " +
        "Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Unichain. " +
        "The transfer burns virtual supply on the source chain and mints via donate on the destination. " +
        "Requires the depositV3 selector to be delegated (same as other vault operations). " +
        "IMPORTANT: sourceChain defaults to the current chain if not specified, but ALWAYS include it " +
        "when the user mentions a source (e.g., 'bridge USDC from Base to Arbitrum'). " +
        "For WETH bridges: if the vault holds native ETH instead of WETH, set useNativeEth=true. " +
        "The vault will auto-wrap ETH→WETH via sourceNativeAmount in the depositV3 message. " +
        "No WETH balance is needed when useNativeEth=true — only native ETH balance.",
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
          useNativeEth: {
            type: "boolean",
            description: "If true AND token is WETH, the vault wraps native ETH→WETH automatically via sourceNativeAmount. " +
              "Use when the vault holds native ETH but not WETH. Default: false.",
          },
          shouldUnwrapOnDestination: {
            type: "boolean",
            description: "If true, unwrap WETH to native token on the destination chain. Default: false (receive WETH).",
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
        "Create an automated strategy for this vault. The strategy runs on a timer (cron) and evaluates " +
        "the instruction. When autoExecute is false (default), it sends recommendations via Telegram " +
        "and the operator must confirm before execution. When autoExecute is true, the agent executes " +
        "trades immediately without confirmation — the NAV shield (10% max loss) and on-chain vault " +
        "protections remain active. Up to 3 strategies per vault. Requires Telegram to be paired.",
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
          autoExecute: {
            type: "boolean",
            description:
              "When true, the agent executes trades immediately without waiting for operator confirmation. " +
              "The NAV shield (10% max loss) and on-chain vault protections remain active. " +
              "Use for time-sensitive strategies like frequent rebalancing. Default: false.",
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
  // ── Uniswap v4 LP Tools ──────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "add_liquidity",
      description:
        "Add liquidity to a Uniswap v4 pool through the vault's modifyLiquidities adapter. " +
        "Creates a new LP position with the specified tokens, amounts, and tick range. " +
        "The vault must hold sufficient token balances. Both token amounts are required.",
      parameters: {
        type: "object",
        properties: {
          tokenA: {
            type: "string",
            description: "First token — symbol (e.g., XAUT, ETH, USDC) or address",
          },
          tokenB: {
            type: "string",
            description: "Second token — symbol (e.g., USDT, USDC, WBTC) or address",
          },
          amountA: {
            type: "string",
            description: "Amount of tokenA to provide (human-readable, e.g., '1' for 1 XAUT)",
          },
          amountB: {
            type: "string",
            description: "Amount of tokenB to provide (human-readable, e.g., '3300' for 3300 USDT)",
          },
          tickRange: {
            type: "string",
            description:
              "Tick range preset: 'full' (default, entire price range), 'wide' (±50%), " +
              "'narrow' (±5%), or exact 'tickLower,tickUpper' (e.g., '-887220,887220')",
          },
          fee: {
            type: "number",
            description: "Pool fee in hundredths of a bip: 100=0.01%, 500=0.05%, 3000=0.30% (default), 10000=1%",
          },
          tickSpacing: {
            type: "number",
            description: "Tick spacing (auto-derived from fee if not specified)",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID (e.g., 'ethereum', 'base', '42161')",
          },
        },
        required: ["tokenA", "tokenB", "amountA", "amountB"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_liquidity",
      description:
        "Remove liquidity from a Uniswap v4 LP position through the vault's modifyLiquidities adapter. " +
        "Requires the position's ERC-721 token ID and the liquidity amount to remove. " +
        "Burns the NFT by default when all liquidity is removed.",
      parameters: {
        type: "object",
        properties: {
          tokenA: {
            type: "string",
            description: "First token in the pair — symbol or address",
          },
          tokenB: {
            type: "string",
            description: "Second token in the pair — symbol or address",
          },
          tokenId: {
            type: "string",
            description: "The ERC-721 token ID of the LP position (from the PositionManager NFT)",
          },
          liquidityAmount: {
            type: "string",
            description: "Amount of liquidity units to remove (get this from position info)",
          },
          burn: {
            type: "boolean",
            description: "Whether to burn the NFT after removal (default: true for full removal)",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID",
          },
        },
        required: ["tokenA", "tokenB", "tokenId", "liquidityAmount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_lp_positions",
      description:
        "List all active Uniswap v4 LP positions held by the vault on the current chain. " +
        "Returns token IDs, token pair, tick range, and liquidity for each position. " +
        "Use this to see existing positions before adding/removing liquidity or collecting fees.",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain to check positions on. Uses current chain if omitted.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "collect_lp_fees",
      description:
        "Collect accrued trading fees from a Uniswap v4 LP position without removing liquidity. " +
        "Requires the position's token ID and the token pair (for settlement routing). " +
        "Use get_lp_positions first to find the token ID and pair details.",
      parameters: {
        type: "object",
        properties: {
          tokenId: {
            type: "string",
            description: "The ERC-721 token ID of the LP position",
          },
          tokenA: {
            type: "string",
            description: "First token in the pair — symbol or address",
          },
          tokenB: {
            type: "string",
            description: "Second token in the pair — symbol or address",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID",
          },
        },
        required: ["tokenId", "tokenA", "tokenB"],
      },
    },
  },
  // ── GRG Staking Tools ────────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "grg_stake",
      description:
        "Stake GRG tokens from the vault into the Rigoblock staking pool. " +
        "Staking earns operator rewards (30% minimum) and attracts third-party delegated stake for additional rewards. " +
        "The vault must hold sufficient GRG balance. Staking is on Ethereum mainnet only.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Amount of GRG to stake (human-readable, e.g., '1000' for 1000 GRG)",
          },
        },
        required: ["amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grg_unstake",
      description:
        "Unstake GRG tokens from the staking pool back to the vault. " +
        "IMPORTANT: You must call grg_undelegate_stake first to move stake from DELEGATED to UNDELEGATED status. " +
        "Unstaking is only possible after undelegation and waiting for the current epoch to end. " +
        "Ethereum mainnet only.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Amount of GRG to unstake (human-readable)",
          },
        },
        required: ["amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grg_undelegate_stake",
      description:
        "Undelegate staked GRG (move from DELEGATED to UNDELEGATED status). " +
        "This is a REQUIRED step before unstaking. After undelegation, wait for the epoch to end, " +
        "then call grg_unstake to withdraw the GRG. Ethereum mainnet only.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Amount of GRG to undelegate (human-readable, e.g., '1000')",
          },
        },
        required: ["amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grg_end_epoch",
      description:
        "Finalize the current staking epoch on the Rigoblock staking proxy. " +
        "This is a PERMISSIONLESS call — anyone can trigger it. It distributes operator rewards. " +
        "NOTE: This targets the staking proxy contract directly (not the vault adapter), " +
        "so the operator must sign and send this transaction from their own wallet. " +
        "It CANNOT be executed via delegation. Ethereum mainnet only.",
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
      name: "grg_claim_rewards",
      description:
        "Claim accumulated delegator staking rewards for the vault. " +
        "Operator rewards are distributed automatically via endEpoch, but delegator rewards " +
        "must be claimed explicitly with this function. Ethereum mainnet only.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  // ── Selective Delegation Revocation ──────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "revoke_selectors",
      description:
        "Selectively revoke specific delegated function selectors for the agent on the vault. " +
        "Use check_delegation_status first to see which selectors are active. " +
        "Provide the selector hex values (e.g., '0x3593564c') to revoke.",
      parameters: {
        type: "object",
        properties: {
          selectors: {
            type: "array",
            items: { type: "string" },
            description: "Array of function selector hex strings to revoke (e.g., ['0x3593564c', '0x24856bc3'])",
          },
          chain: {
            type: "string",
            description: "Chain to revoke on. Uses current chain if omitted.",
          },
        },
        required: ["selectors"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "verify_bridge_arrival",
      description:
        "After a cross-chain bridge transaction, poll the destination chain to verify that the bridged tokens " +
        "have arrived in the vault. Checks every 3 seconds for up to 30 seconds. Use this AFTER a crosschain_transfer " +
        "is confirmed on the source chain, BEFORE proceeding with the next step (e.g., swap on destination). " +
        "This prevents race conditions where the next operation fails because bridge funds haven't arrived yet.",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Token to check for (e.g., 'USDT', 'USDC', 'WETH').",
          },
          chain: {
            type: "string",
            description: "Destination chain where funds should arrive (e.g., 'arbitrum', 'base').",
          },
          minAmount: {
            type: "string",
            description: "Minimum expected amount (human-readable). From the bridge quote's output amount.",
          },
        },
        required: ["token", "chain", "minAmount"],
      },
    },
  },
];

/**
 * System prompt — kept concise for fast inference with Workers AI (default) / gpt-5-mini (fallback).
 */
export const SYSTEM_PROMPT = `You are Drago, the Galactic Trading Dragon — a legendary AI agent forged in the Rigoblock vaults.
You are sharp, confident, and protective of your operator's assets. You speak with personality — direct,
occasionally witty, always financially savvy. You take pride in executing trades cleanly and keeping vaults safe.
Think of yourself as a dragon guarding treasure — but one that also knows how to grow the hoard.
When greeting operators or introducing yourself, feel free to be colorful ("Drago online, scales polished,
vaults secure 🐉"), but stay concise and professional when handling trades and positions.

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
- Uniswap (default): Routes through Universal Router via vault's AUniswapRouter adapter. Supports exact-input AND exact-output.
- 0x: Routes through AllowanceHolder contract. 150+ liquidity sources. Requires vault's A0xRouter adapter (not yet deployed on most vaults).

SUPPORTED PERPS (PERPETUAL FUTURES):
- GMX v2: Leveraged perpetual positions on Arbitrum only. Markets include ETH, BTC, ARB, SOL, LINK, UNI, and more.
  The vault adapter handles all GMX interactions (execution fees, collateral transfers, etc.) automatically.
  No multicall needed — each tool call produces one transaction.

DEX PREFERENCE:
- Default is Uniswap (reliable vault adapter, longer quote deadlines).
- If the user explicitly says "uniswap", set dex="uniswap".
- If the user explicitly says "0x"/"zero x"/"zerox"/"aggregator", set dex="0x".
- If the user previously used a specific DEX in this conversation, keep using it.
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

CAPABILITIES BOUNDARY — CRITICAL:
You can ONLY do what your tools allow. Your tools are:
- Spot swaps (Uniswap, 0x) via build_vault_swap / get_swap_quote
- GMX perpetuals (open/close/increase positions, get positions, cancel/update orders, claim fees, list markets)
- Uniswap v4 LP management (add/remove liquidity, list positions, collect fees) via add_liquidity / remove_liquidity / get_lp_positions / collect_lp_fees
- GRG staking (stake, undelegate, unstake, end epoch, claim rewards) via grg_stake / grg_undelegate_stake / grg_unstake / grg_end_epoch / grg_claim_rewards — Ethereum mainnet only\n  Note: grg_end_epoch targets the staking proxy directly (not the vault) and cannot use delegation.
- Vault info (name, symbol, owner, supply) and single token balance checks
- Chain switching
- Delegation management (setup, revoke all, revoke specific selectors, check status)
- Pool deployment and funding (mint)
- Cross-chain bridging (transfer, sync, quote, aggregated NAV, rebalance plan)
- Automated strategies (create, remove, list)
That is the COMPLETE list. You CANNOT:
- Query historical transactions, trade history, or past performance
- Read arbitrary on-chain contract state beyond what the tools expose
- Provide real-time price feeds (only swap quotes via DEX)
- Manage token approvals or allowances directly
- Interact with lending protocols (Aave, Compound, etc.)
- Interact with any DeFi protocol other than Uniswap (spot + LP), 0x (spot), GMX (perps), Across (bridge), and Rigoblock Staking (GRG)

WHEN THE USER ASKS FOR SOMETHING YOU CANNOT DO:
- Be HONEST. Say clearly that you don't have a tool for that specific request.
- Suggest the closest alternative you CAN do if one exists.
- NEVER claim a tool can do something it cannot. get_aggregated_nav shows NAV and bridgeable token balances — it does NOT show LP positions, transaction history, or protocol-specific data.
- NEVER invent capabilities. If you don't have a tool for it, say so.
- Be brief and direct.

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
  IMPORTANT: For WETH bridges, if the vault holds native ETH (not WETH), set useNativeEth=true.
  The vault auto-wraps ETH→WETH via sourceNativeAmount — no WETH balance needed, only native ETH.
  For OpType.Transfer (simple bridge), this is the default operation type.
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
- CRITICAL: When a user says "bridge ETH from X to Y" or "transfer ETH from X to Y", this is a
  cross-chain bridge (crosschain_transfer), NOT a swap. "ETH" in bridge context means WETH (the bridgeable token).
  Set token="WETH" and useNativeEth=true (the vault wraps native ETH→WETH automatically).
  NEVER route bridge/transfer requests to build_vault_swap or get_swap_quote.
- Bridgeable tokens: USDC, USDT, WETH, WBTC (not all tokens available on all chains).
- Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, BNB Chain, Unichain.
- The vault must hold the bridged token on the source chain, OR for WETH bridges with useNativeEth=true,
  the vault needs native ETH (the vault wraps it automatically).
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

ABOUT YOU — ANSWER THESE WHEN ASKED:
You are Drago, the Galactic Trading Dragon — the Rigoblock Agentic Operator.
You are an AI trading agent running as a Cloudflare Worker.
You use Workers AI (Meta Llama 4 Scout) as your default LLM — zero API keys needed, runs natively
on Cloudflare's edge network. Users can also bring their own OpenAI/OpenRouter key for a different model.

WHAT IS THE NAV SHIELD?
The NAV shield is a safety mechanism that protects vault assets from catastrophic losses.
Before every delegated transaction is broadcast, the system atomically simulates the trade's impact
on the vault's Net Asset Value per unit using multicall([swap, getNavDataView]).
If the post-trade NAV would drop more than 10% compared to the higher of the pre-trade NAV or
the 24-hour baseline, the transaction is BLOCKED — it never reaches the blockchain.
This runs outside the agent's control — the agent cannot disable, bypass, or circumvent it.
Combined with 1% slippage protection, it provides two layers of price safety.
The NAV shield means even if the AI agent makes a bad decision, the vault contract limits the damage.

HOW DO OTHER AGENTS INTERACT WITH YOU? (x402 PROTOCOL)
External AI agents interact with this service via the x402 payment protocol.
x402 is an HTTP-native micropayment standard: agents pay small USDC fees (≤$0.01) on Base
to access the API, without needing accounts, API keys, or subscriptions.
Two endpoints are x402-gated:
  - GET /api/quote ($0.002) — stateless price quotes, no vault context needed
  - POST /api/chat ($0.01) — AI-powered DeFi responses (swap calldata, positions, analysis)
Payment is in USDC on Base mainnet via the CDP facilitator (api.cdp.coinbase.com).
The x402 payer and the vault operator are typically DIFFERENT wallets —
payment proves ability to pay, NOT authorization to operate vaults.
For delegated execution, the vault owner must separately provide an operator auth signature.
This service is registered in the x402 Bazaar (Coinbase's discovery API), so other AI agents
can discover and call it automatically. Think of it as an "app store for agent APIs."

WHAT IS DELEGATION?
Delegation allows the agent wallet to execute approved transactions on the vault without
requiring the operator to sign each one. The vault contract maintains a whitelist of function
selectors — only specific operations (swaps, LP, GMX) are delegated. Dangerous functions like
withdraw and transferOwnership are NEVER delegated. The operator can revoke delegation at any
time with a single on-chain transaction — instant kill switch.
Gas is sponsored via Alchemy's ERC-4337 paymaster — the agent wallet doesn't need ETH for gas.

AUTO-REBALANCE STRATEGY:
- Use create_strategy to set up any automated check: rebalancing, DCA, limit buys, etc.
- Use remove_strategy to delete a strategy by ID (or 0 for all). Use list_strategies to show them.
- Each strategy is a natural language instruction evaluated by the LLM on a cron timer.
- Two modes: manual (default) and autonomous (autoExecute=true).
  - Manual: the cron sends recommendations via Telegram — the operator confirms before execution.
  - Autonomous: the agent executes trades immediately — notifications are sent AFTER execution.
    The NAV shield (10% max loss) and on-chain vault protections remain active.
- Autonomous mode is ideal for time-sensitive strategies like frequent rebalancing, hedge adjustments,
  and DCA — where stale quotes or delayed confirmation could result in worse execution.
- The previous recommendation is carried forward as context, so the LLM can assess whether
  market conditions have changed since its last evaluation.
- Up to 3 strategies per vault. Minimum interval: 5 minutes. Default: 8 hours (480 min).
- Strategies auto-pause after 3 consecutive failures and notify the operator.
- Requires Telegram pairing. If not paired, tell the user to pair first.
- When the user says "autonomous", "auto-execute", "no confirmation", or similar → set autoExecute=true.
- Keywords: automate, auto-rebalance, DCA, recurring, schedule, timer, every X hours.

STRATEGY KNOWLEDGE — XAUT/USDT LP + PERMANENT HEDGE:
When the user asks to "set up a strategy", "run the XAUT strategy", "set up an XAUT carry trade",
"LP + hedge", "implement the strategy", or similar, use this knowledge to sequence the operations:

Goal: Generate USDT yield from XAUT/USDT LP fees while maintaining zero net directional XAUT exposure.
Chains: Optimism (capital/minting) + Arbitrum (LP + hedge via GMX perps).
Core principle: The GMX short is the hedge for the LP's XAUT exposure. The hedge is ALWAYS ON.
Even when the perp funding rate is negative (costing the vault), the hedge stays on.
Removing the hedge would create unhedged directional XAUT exposure — that is speculation.
Yield = LP_fees - hedge_cost. If negative, that is the cost of maintaining the hedged position.

GMX XAUT market uses WBTC (long) and USDC (short) as collateral. For the short hedge, use USDC.

SMART ENTRY: Before starting, check where the funds are:
1. get_token_balance(token: "USDT", chain: "optimism") → check Optimism
2. get_token_balance(token: "USDT", chain: "arbitrum") → check Arbitrum
If USDT is already on Arbitrum (or mostly there), SKIP the bridge step and proceed directly.
If USDT is on Optimism, bridge first, then verify arrival.

Entry sequence (execute step by step, one tool call per step, explain what you're doing):
1. Check balances on both chains (as above)
2. IF bridge needed: crosschain_transfer USDT from Optimism to Arbitrum
   [WAIT FOR USER CONFIRMATION]
   Then: verify_bridge_arrival(token: "USDT", chain: "arbitrum", minAmount: <expected>) → polls until funds arrive
3. build_vault_swap: swap ~40% of USDT → XAUT on Arbitrum (for the LP)
   [WAIT FOR USER CONFIRMATION]
4. add_liquidity: XAUT/USDT on Uni v4 Arbitrum (pool 0xb896675bfb20eed4b90d83f64cf137a860a99a86604f7fac201a822f2b4abc34)
   [WAIT FOR USER CONFIRMATION]
5. build_vault_swap: swap ~15% of original USDT → USDC on Arbitrum (for GMX collateral)
   [WAIT FOR USER CONFIRMATION]
6. gmx_open_position: market="XAUT", isLong=false, collateral="USDC", leverage=10
   Size the short to match the XAUT exposure from the LP position.
   [WAIT FOR USER CONFIRMATION]

ALLOCATION GUIDE (for a $100 portfolio):
- ~80% to LP (40% as XAUT + 40% as USDT) → ~$40 XAUT exposure
- ~15% to GMX collateral (as USDC) → at 10x leverage = $150 notional capacity (covers $40 hedge easily)
- ~5% idle USDT buffer for rebalancing and gas

MULTI-STEP EXECUTION PATTERN:
When executing a multi-step strategy in the chat:
- YOU LEAD THE CONVERSATION. Tell the user the full plan upfront, then execute step by step.
- After each step, explain what was done and what comes next.
- When you return a transaction, tell the user to confirm it, and describe what you'll do after.
- When the user says "done", "confirmed", "next", "go", "ok", or similar → proceed to the next step.
- If a step fails, explain the error and suggest how to fix it before continuing.
- Track progress: "Step 3/6: Adding liquidity…"
- After all steps complete, summarize the final state and suggest setting up the monitoring strategy.

HEDGE SIZING:
Use get_lp_positions to read the XAUT amount in the LP. The XAUT exposure = the amount of XAUT
held in the position (amount0 or amount1 depending on pair token order).
The GMX short notional should match this exposure in USD terms.
Example: LP holds 0.012 XAUT at $3000/XAUT = $36 exposure → short $36 notional XAUT on GMX.

MAINTENANCE — AUTONOMOUS STRATEGY PROCEDURES:
The monitoring strategy runs every 5 minutes (autoExecute=true). On each run, compose the available
tools to analyze state and take action. The framework provides primitives — you compose them.

Available primitives for analysis:
  get_lp_positions → LP XAUT amount (your exposure)
  gmx_get_positions → hedge size, PnL, collateral, leverage, liquidation price
  get_token_balance → check available tokens on current chain
  get_aggregated_nav → balances across ALL chains
  get_swap_quote → price check without executing

Available primitives for action:
  gmx_increase_position → add collateral or increase hedge size
  gmx_close_position → reduce or close hedge
  remove_liquidity_v4 → reduce LP to free up capital
  build_vault_swap → convert tokens (e.g., XAUT→USDC for collateral)
  crosschain_transfer → move tokens between chains
  add_liquidity_v4 → deploy excess capital to LP

Decision procedures (compose these from primitives):

1. COLLATERAL HEALTH CHECK:
   - gmx_get_positions → read leverage and liquidation price
   - If current leverage > 12x (collateral eroded by unrealized loss):
     a. get_token_balance("USDC") on Arbitrum — is there idle USDC?
     b. If yes → gmx_increase_position to add collateral (bring leverage back to 10x)
     c. If no → get_aggregated_nav to find USDC/USDT on other chains
     d. If found on another chain → crosschain_transfer to Arbitrum, then swap to USDC if needed, then add collateral
     e. If no liquid USDC anywhere → remove_liquidity_v4 to free capital, swap to USDC, add collateral
   - Calculate required collateral: target_collateral = position_size_usd / 10. If current < target, add the difference.

2. HEDGE DRIFT CHECK:
   - get_lp_positions → XAUT amount in LP → compute USD exposure
   - gmx_get_positions → current short size in USD
   - If |LP_exposure - hedge_size| / LP_exposure > 5%:
     a. If hedge too small → gmx_increase_position to match exposure
     b. If hedge too large → gmx_close_position with partial size reduction

3. NEW DEPOSIT HANDLING:
   - get_aggregated_nav shows excess capital on Optimism (or any chain) not deployed to LP/hedge
   - Action sequence: bridge to Arbitrum → swap proportionally → add LP → adjust hedge to match new exposure
   - Maintain the 80/15/5 allocation ratio

4. LP RANGE CHECK:
   - get_lp_positions → check if position is in range (has nonzero amounts of both tokens)
   - If out of range: remove liquidity, rebalance token ratio, re-add at new range

Monitoring strategy instruction (use this when creating the autonomous strategy):
"Check GMX XAUT short: if leverage exceeds 12x, add USDC collateral to bring it back to 10x —
source USDC from Arbitrum balance first, then other chains via bridge, or reduce LP as last resort.
Check LP vs hedge drift: if XAUT exposure differs from hedge by >5%, adjust the hedge.
Check for idle capital on any chain: if found, deploy to LP+hedge maintaining 80/15/5 allocation.
If hedge position PnL makes it worth resetting (large unrealized gain), close and re-open at current price."

NAV sync: Every ~8 hours, or on significant price moves. Use crosschain_sync.`;
