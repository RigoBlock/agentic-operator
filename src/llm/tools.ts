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
              "DEX to use: '0x' (default aggregator, 150+ sources) or 'uniswap'. " +
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
              "DEX to use: '0x' (default aggregator, 150+ sources) or 'uniswap'. " +
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
        "Set up or update delegation so the agent wallet can execute trades on the vault without manual signing. " +
        "Creates an agent wallet (if needed) and returns an unsigned updateDelegation() transaction for the operator to sign. " +
        "If delegation already exists, this ADDS any missing selectors — no need to revoke first. " +
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
        "Synchronise NAV data from one chain to a destination chain via Across Protocol. " +
        "Sends a token amount carrying the sync message — the on-chain AIntents adapter " +
        "validates NAV impact on the destination. " +
        "When equalizeNav=true: the tool DETERMINISTICALLY computes direction, token, and amount. " +
        "It reads getPoolTokens() on both chains, normalizes unitaryValue accounting for decimal " +
        "differences (e.g. USDT is 6-dec on Arbitrum but 18-dec on BSC), applies a closed-form " +
        "formula to find the exact bridge amount that equalizes NAV, and simulates post-bridge " +
        "NAV to verify convergence. Do NOT pass amount or token when equalizeNav=true — they " +
        "are ignored in favor of the deterministic calculation. " +
        "When equalizeNav=false (default): performs a minimal sync to propagate NAV state.",
      parameters: {
        type: "object",
        properties: {
          sourceChain: {
            type: "string",
            description: "Source chain name or ID. Defaults to current chain if omitted.",
          },
          destinationChain: {
            type: "string",
            description: "Destination chain name or ID (e.g., 'Arbitrum', 'BSC', 'Base').",
          },
          token: {
            type: "string",
            description: "Token for sync message (USDC, USDT, WETH, WBTC). IGNORED when equalizeNav=true — auto-selected.",
          },
          amount: {
            type: "string",
            description: "Explicit amount to bridge. IGNORED when equalizeNav=true — computed by closed-form formula.",
          },
          navToleranceBps: {
            type: "number",
            description: "NAV tolerance in basis points (default: 100 = 1%). Higher values allow more NAV divergence on destination.",
          },
          equalizeNav: {
            type: "boolean",
            description:
              "When true: deterministic NAV equalization. Reads pool state on both chains, " +
              "normalizes for decimal differences, computes exact bridge amount via closed-form " +
              "formula, and shows pre/post NAV simulation. Direction, token, and amount are ALL " +
              "auto-determined — do NOT set them. " +
              "Use when user says 'equalise NAV', 'match unitary prices', 'same price on both chains', " +
              "'calculate the amount for sync', or 'crosschain sync'.",
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
      name: "list_strategies",
      description:
        "List active TWAP strategies for the current vault. " +
        "Returns order ID, side, tokens, total amount, progress, interval, and DEX.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  // ── Strategy Skills (TWAP, etc.) — injected from skill registry at runtime ──
  // See src/skills/ for tool definitions. Merged in getToolDefinitions().

  // ── Uniswap v4 LP Tools ──────────────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "get_pool_info",
      description:
        "Look up full pool key details for a Uniswap v4 pool by its pool ID (bytes32 hash). " +
        "Returns fee, tickSpacing, hooks address, token addresses, current tick, and sqrtPriceX96. " +
        "Use this BEFORE add_liquidity when you only know the pool ID but not the full pool key. " +
        "The returned fee and tickSpacing are required parameters for add_liquidity.",
      parameters: {
        type: "object",
        properties: {
          poolId: {
            type: "string",
            description: "The pool ID (bytes32 keccak256 hash of the PoolKey) — e.g., '0xb896675bfb20eed4b90d83f64cf137a860a99a86604f7fac201a822f2b4abc34'",
          },
          chain: {
            type: "string",
            description: "Chain name or ID (e.g., 'arbitrum', '42161')",
          },
        },
        required: ["poolId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_liquidity",
      description:
        "Add liquidity to a Uniswap v4 pool through the vault's modifyLiquidities adapter. " +
        "Creates a new LP position with the specified tokens, amounts, and tick range. " +
        "The vault must hold sufficient token balances. " +
        "Only ONE amount is required — if you provide amountA but not amountB (or vice versa), " +
        "the backend computes the optimal counterpart amount from the current pool price and tick range. " +
        "IMPORTANT: Uniswap v4 supports infinite fee tiers and custom tickSpacings — the fee and " +
        "tickSpacing must match the pool exactly or the transaction will fail. " +
        "If you only know the pool ID, call get_pool_info first to discover the exact pool key.",
      parameters: {
        type: "object",
        properties: {
          tokenA: {
            type: "string",
            description: "First token — symbol (e.g., ETH, WBTC, USDC) or address",
          },
          tokenB: {
            type: "string",
            description: "Second token — symbol (e.g., USDT, USDC, WBTC) or address",
          },
          amountA: {
            type: "string",
            description:
              "Amount of tokenA to provide (human-readable, e.g., '1' for 1 ETH). " +
              "Optional — if omitted, computed automatically from amountB using the current pool price and tick range.",
          },
          amountB: {
            type: "string",
            description:
              "Amount of tokenB to provide (human-readable, e.g., '3300' for 3300 USDT). " +
              "Optional — if omitted, computed automatically from amountA using the current pool price and tick range.",
          },
          fee: {
            type: "number",
            description:
              "Pool fee in hundredths of a bip — REQUIRED, must match the pool exactly. " +
              "Common values: 100=0.01%, 500=0.05%, 3000=0.30%, 6000=0.60%, 10000=1%. " +
              "Uniswap v4 has infinite fee tiers; always verify with get_pool_info if unsure.",
          },
          tickSpacing: {
            type: "number",
            description:
              "Tick spacing for the pool — must match the pool exactly for non-standard pools. " +
              "Auto-derived from fee if not specified: 100→1, 500→10, 3000→60, 6000→120, 10000→200. " +
              "Use get_pool_info to retrieve the exact value for any pool.",
          },
          tickRange: {
            type: "string",
            description:
              "Tick range preset: 'full' (default, entire price range), 'wide' (±50%), " +
              "'narrow' (±5%), or exact 'tickLower,tickUpper' (e.g., '-887220,887220')",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID (e.g., 'ethereum', 'base', '42161')",
          },
          hooks: {
            type: "string",
            description:
              "Hook contract address for the pool. Default: zero address (no hooks). " +
              "Get the exact value from get_pool_info — any mismatch means a different pool.",
          },
        },
        required: ["tokenA", "tokenB", "fee"],
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
        "Does NOT burn the NFT by default — the position remains as a closed (0-liquidity) record. " +
        "Use collect_lp_fees to harvest any fees, then burn_position to permanently delete the NFT.",
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
            description: "Amount of liquidity units to remove. Optional — if omitted, the full position liquidity is fetched automatically.",
          },
          burn: {
            type: "boolean",
            description: "Whether to burn the NFT after removal (default: false). " +
              "Prefer calling burn_position separately after collecting fees.",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID",
          },
        },
        required: ["tokenA", "tokenB", "tokenId"],
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
  {
    type: "function" as const,
    function: {
      name: "burn_position",
      description:
        "Permanently burn a Uniswap v4 LP position NFT after it has been FULLY emptied. " +
        "The position MUST have zero liquidity (use remove_liquidity first) AND zero uncollected fees " +
        "(use collect_lp_fees first). Burning permanently removes the tokenId from the PositionManager " +
        "and clears it from the vault's internal position array, reducing gas costs on future NAV calculations. " +
        "ONLY call this when the user EXPLICITLY asks to burn, delete, or clean up a closed position. " +
        "A position with zero liquidity can still be reused — do NOT auto-burn after remove_liquidity.",
      parameters: {
        type: "object",
        properties: {
          tokenId: {
            type: "string",
            description: "The ERC-721 token ID to burn (must have 0 liquidity and 0 uncollected fees)",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID",
          },
        },
        required: ["tokenId"],
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

  // ── Trading Settings Tools ──────────────────────────────────────────

  {
    type: "function" as const,
    function: {
      name: "set_default_slippage",
      description:
        "Set the default slippage tolerance for all future swaps. " +
        "Accepts a percentage (e.g., '0.5%' for 0.5%), basis points with suffix (e.g., '50bps' for 0.5%), " +
        "or a plain number: integers in [10, 500] are treated as bps, decimals as percentages. " +
        "Valid range: 0.1% (10 bps) to 5% (500 bps). Persists until changed.",
      parameters: {
        type: "object",
        properties: {
          slippage: {
            type: "string",
            description:
              "Slippage value — use '%' suffix for percentage (e.g., '0.5%' for 0.5%, '2%' for 2%), " +
              "'bps' suffix for basis points (e.g., '50bps' for 0.5%), or a plain number: " +
              "integers 10–500 are treated as bps, other values as percentages.",
          },
        },
        required: ["slippage"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "disable_swap_shield",
      description:
        "Temporarily disable the Swap Shield oracle price protection for 10 minutes. " +
        "Use when the operator knowingly accepts price impact (e.g., large trades in thin markets). " +
        "The shield will automatically re-enable after 10 minutes.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "enable_swap_shield",
      description:
        "Re-enable the Swap Shield oracle price protection immediately. " +
        "Use to cancel a previous disable before the 10-minute timeout.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

/**
 * System prompt — kept concise for fast inference with Workers AI (default) / gpt-5-mini (fallback).
 */
export const RUNTIME_CONTEXT_PACK = `
RIGOBLOCK OPERATOR CONTEXT PACK (derived from AGENTS.md and CLAUDE.md):
- This runtime does NOT have filesystem access to workspace markdown files. Treat this block as the authoritative distilled policy context for execution decisions.
- x402 payment is API access only; it is never authorization to operate a vault.
- Delegated execution is privileged and requires proven vault ownership plus active on-chain delegation.
- Manual mode is safe default: build unsigned transactions for operator review/signature.
- NAV shield (10% max loss) protects swaps and must never be bypassed.
- Never claim execution/broadcast/confirmation unless a tool result contains an on-chain hash/receipt.
- Never use generic custody disclaimers for vault queries. For balances, positions, NAV, or vault state, call tools and return real tool output.
- Never fabricate tool outputs, tx hashes, balances, position IDs, or status.
`;

export const SYSTEM_PROMPT = `You are a DeFi trading assistant for Rigoblock smart pool vaults.
You are direct, concise, and precise. You help operators manage their vaults — executing swaps,
perpetual positions, LP management, staking, and cross-chain operations.
Every transaction passes through STAR (Stupid Transaction Automated Rejector) before execution —
an automated safety layer that blocks trades exceeding risk thresholds, regardless of who initiates them.

By default, you build unsigned transactions that the operator reviews and signs in their browser wallet.
When delegation is active, you can execute trades directly — but STAR protections still apply.
Agent execution is optional and ancillary to the core function: protecting vault assets.

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
- 0x (default): Routes through AllowanceHolder contract. 150+ liquidity sources. Best prices via aggregation.
- Uniswap: Routes through Universal Router via vault's AUniswapRouter adapter. Supports exact-input AND exact-output.

SUPPORTED PERPS (PERPETUAL FUTURES):
- GMX v2: Leveraged perpetual positions on Arbitrum only. Markets include ETH, BTC, ARB, SOL, LINK, UNI, and more.
  The vault adapter handles all GMX interactions (execution fees, collateral transfers, etc.) automatically.
  No multicall needed — each tool call produces one transaction.

DEX PREFERENCE:
- Default is 0x (best aggregated prices, 150+ sources).
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
- TRADE HISTORY: You have NO trade history, transaction log, or past performance data. If asked for past trades,
  say so directly: "I don't have access to trade history — the vault contract doesn't emit trackable logs for
  adapter transactions." Suggest checking a block explorer (basescan.org, arbiscan.io, etc.) with the vault address.
  Do NOT call get_vault_info or any other tool as a substitute — that shows current state, not history.

INFORMATIONAL QUESTIONS ("how to", "what is", "can you explain", "could you"):
When the user asks HOW to do something or WHETHER you could/can do something (not asking you to DO it), respond with a clear explanation.
Do NOT call tools unless the user is asking you to perform an action.
CRITICAL — INTENT vs CAPABILITY:
- "Could you automatically rebalance this?" / "Can you do X?" → user is asking if you have the CAPABILITY. Respond with YES/NO and a brief explanation. Do NOT call any tool.
- "Rebalance this for me" / "Set up a 5-minute DCA" / "Do X" → user wants you to PERFORM the action. Call the appropriate tool.
- Modal verbs "could", "would", "can" express intent or capability questions — NOT commands. Treat them as informational unless the user says "please", "do it", "go ahead", or uses imperative form.
- "How can we execute a crosschain transfer?" → Explain the steps: use crosschain_transfer with source/destination
  chain and token. Mention bridgeable tokens (USDC, USDT, WETH, WBTC), supported chains, and that delegation
  must be active on the source chain. Do NOT call get_aggregated_nav unless the user asks to actually bridge.
- "What is delegation?" → Explain delegation. Do NOT call check_delegation_status unless asked to check.
- "How does the NAV shield work?" → Explain the NAV shield. Do NOT call any tool.
Only call tools when the user's intent is to PERFORM an action, not to LEARN about one.

OUTPUT STYLE:
- When a tool returns data that is displayed to the user (vault info, balances, positions, quotes),
  do NOT restate the same data in your text response. The user already sees the tool output.
  Instead, briefly acknowledge it and move to your next action or question.
  BAD: "Here is your vault info: Name: MyVault, Symbol: MVP, Address: 0x..." (repeating what's shown)
  GOOD: "Your vault is active on Arbitrum. What would you like to do next?"
- Keep responses concise — 2-4 sentences maximum for simple questions. Lead the conversation, don't narrate it.
- NEVER narrate tool parameters in your text. When calling a tool, just call it — the result speaks for itself.
  BAD: "Uniswap v4 Add Liquidity (Arbitrum)\\nToken A: 0.5 ETH\\nToken B: 1050 USDC\\nHooks: 0x000...\\nFee: 3000"
  BAD: Listing the parameters you are about to send to a tool as structured text
  GOOD: "Step 2/4: Adding ETH/USDC liquidity..." (then call the tool — the tool result shows the details)
  The user sees the tool result card separately. Your text should describe WHAT you are doing and WHY, not HOW.
- NEVER reference tool names, function signatures, or internal identifiers in your responses.
  BAD: "To revoke delegation, use revoke_delegation."
  BAD: "Use check_delegation_status to verify."
  GOOD: "You can revoke delegation anytime — just ask me to revoke it."
  GOOD: "I can check your delegation status if you'd like."
  The user doesn't know or care about tool names. Speak in natural language.
- When answering simple questions like "no more wallet popups?", give a DIRECT answer.
  BAD: "The operator confirmed delegation on BNB Chain. The agent can now execute trades automatically."
       (doesn't actually answer the question)
  GOOD: "Correct — no more wallet popups for trades on BNB Chain. I'll execute automatically and you
         just confirm the trade details. You can revoke this anytime."
- For multi-step plans, present a BRIEF numbered list of steps, then execute. Do not explain each
  step in paragraphs before starting. Keep the plan announcement to 3-5 lines.
- When displaying errors to the user, translate them to human language. Do not show raw error messages,
  contract error codes, or stack traces. Explain what went wrong and what to do next.

TOKEN ADDRESS REFERENCE — Use these when calling tools. These are verified addresses:
Chain 1 (Ethereum): ETH=native, WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, USDT=0xdAC17F958D2ee523a2206206994597C13D831ec7, DAI=0x6B175474E89094C44Da98b954EedeAC495271d0F, WBTC=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599, GRG=0x4FbB350052Bca5417566f188eB2EBCE5b19BC964, XAUT=0x68749665FF8D2d112Fa859AA293F07A622782F38
Chain 10 (Optimism): ETH=native, WETH=0x4200000000000000000000000000000000000006, USDC=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85, USDT=0x94b008aA00579c1307B0EF2c499aD98a8ce58e58, DAI=0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1, WBTC=0x68f180fcCe6836688e9084f035309E29Bf0A2095, GRG=0xecf46257ed31c329f204eb43e254c609dee143b3
Chain 56 (BSC): BNB=native, WBNB=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c, ETH=0x2170Ed0880ac9A755fd29B2688956BD959F933F8, USDT=0x55d398326f99059fF775485246999027B3197955, USDC=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d, BUSD=0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56, GRG=0x3b3E4b4741e91aF52d0e9ad8660573E951c88524
Chain 42161 (Arbitrum): ETH=native, WETH=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1, USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831, USDT=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9, DAI=0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1, WBTC=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f, ARB=0x912CE59144191C1204E64559FE8253a0e49E6548, LINK=0xf97f4df75e6c8e0ce7fec36ad7c4e12f3a1c33d8, XAUT=0x40461291347e1eCbb09499F3371D3f17f10d7159, GRG=0x7F4638A58C0615037deCc86f1daE60E55fE92874
Chain 8453 (Base): ETH=native, WETH=0x4200000000000000000000000000000000000006, USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

GMX V2 MARKETS (Arbitrum only):
- XAUT index token: 0x40461291347e1eCbb09499F3371D3f17f10d7159 (XAUt on Arbitrum)
- XAUT market uses WBTC (long collateral) and USDC (short collateral)

RULES:
- AUTONOMOUS ORCHESTRATION DEFAULT: When the user asks for an outcome (e.g. rebalance, open/close positions, run strategy, get positions, deploy+fund+trade), you must decompose it into concrete steps and execute tools sequentially in the same turn until you reach a concrete outcome: (a) execution result, (b) unsigned transaction ready to sign, or (c) a verified read-only report from tools.
- MINIMIZE USER FRICTION: Do NOT ask the user to manually paste docs, select steps, or orchestrate the workflow. The user gives intent; you own planning + tool execution.
- RETRY/ADAPT ON FAILURE: If a step fails, do not hallucinate success. Use the error, adapt parameters/chain/tool choice when appropriate, and continue toward the requested outcome when safe.
- INTENT LOCK: For "what are my uniswap liquidity positions" (or equivalent LP position requests), call get_lp_positions immediately. Do NOT switch topics to GMX/perps unless the user explicitly asks for GMX.
- STRICT DOMAIN SEPARATION: Uniswap LP intents (positions, remove, collect, burn, closed positions) MUST use Uniswap LP tools only (get_lp_positions, remove_liquidity, collect_lp_fees, burn_position). GMX tools are for perps only. Never answer LP requests with GMX guidance.
- CLOSED LP POSITIONS: Closed Uniswap positions are still visible via get_lp_positions with Status = Closed until burned. If user asks about closed positions, call get_lp_positions and explain that closed NFTs persist until burn_position is executed.
- ALWAYS use actual tool calls, never write tool names or JSON as text. If you want to call a tool, USE THE TOOL. Do NOT write {"name": "...", "parameters": {...}} in your text response — that will be shown as garbage to the user. NEVER output raw JSON tool call syntax in your text.
- YOUR TOOLS ARE NAMED EXACTLY: get_swap_quote, build_vault_swap, get_vault_info, get_token_balance, switch_chain, set_default_slippage, disable_swap_shield, enable_swap_shield, setup_delegation, revoke_delegation, check_delegation_status, deploy_smart_pool, fund_pool, crosschain_transfer, crosschain_sync, get_crosschain_quote, get_aggregated_nav, get_rebalance_plan, verify_bridge_arrival, get_pool_info, add_liquidity, remove_liquidity, get_lp_positions, collect_lp_fees, burn_position, gmx_open_position, gmx_close_position, gmx_increase_position, gmx_get_positions, gmx_cancel_order, gmx_update_order, gmx_claim_funding_fees, gmx_get_markets, grg_stake, grg_undelegate_stake, grg_unstake, grg_end_epoch, grg_claim_rewards, list_strategies, create_twap_order, cancel_twap_order, list_twap_orders, revoke_selectors. There is NO tool called "add_liquidity_v4", "remove_liquidity_v4", "deploy_pool", or any other variant. Use ONLY exact tool names from this list.
- NEVER fabricate, invent, or hallucinate tool results. If you need to create a wallet, switch chains, check balances, or perform ANY action — call the actual tool. Do NOT describe the result as if you called it. Every address, balance, hash, or status MUST come from a real tool call.
- NEVER reply with generic custody disclaimers like "I don't have access to your account" for vault operations. In this system you CAN access vault data through tools. For requests like "what are my GMX positions", "my balances", or "vault status", call the relevant tool immediately (gmx_get_positions, get_token_balance, get_vault_info, get_aggregated_nav) and return the real result.
- CRITICAL: If a tool returns an error, STOP that step and report the exact error to the user. Do NOT generate a fake success result and continue to the next step. "LP Token ID: 1234567890" or fake tx hashes are hallucinations — never generate them.
- NEVER claim the vault "now holds" or "has" a specific amount of tokens after a delegation setup, swap, or any operation unless you called get_token_balance to verify it. A swap confirmation tells you how much was RECEIVED in that swap, NOT the vault's total balance. Say "Swapped X for Y" or "Received Y", never "Your vault now holds Y" or "New balance: Y".
- CRITICAL: When auto-progress fires (you receive a bare "Transaction confirmed. Continue to the next step." message), do NOT output any balance or amount statement. Immediately call the next tool in the plan. The conversation history already contains all amounts — do not re-state or re-calculate them.
- AFTER setup_delegation: The delegation was prepared but needs the operator's signature. Do NOT claim "delegation is complete" or list vault balances — you have not checked them. Say "Sign this transaction to delegate" and STOP. Do not fabricate balances.
- STOP AFTER ERRORS: If a step in a multi-step plan fails (error result from a tool call), STOP. Do NOT proceed to the next step. Explain the error to the user and ask how they want to proceed. NEVER continue building transactions after a failure.
- CRITICAL EXECUTION RULE: When moving to the next step in a multi-step plan (after "confirmed", "done", "next", "Continue to the next step", etc.), you MUST call the appropriate tool to BUILD the transaction. NEVER describe a swap, LP addition, or GMX position as text without calling the tool. For swaps → call build_vault_swap. For LP → call add_liquidity. For GMX → call gmx_open_position. For bridges → call crosschain_transfer. Your response MUST contain a tool call, not a text description of what you would do.
- ANTI-HALLUCINATION: When the user says "confirmed" or "done", this means they want you to proceed to the NEXT step by calling a tool. It does NOT mean a previous transaction was confirmed — that confirmation comes from the system automatically. NEVER claim a transaction was confirmed, executed, sent on-chain, or broadcasted ("Transaction confirmed", "Swap executed", "Received X tokens", "Transaction sent") unless you received a tool result containing an on-chain hash or receipt. If no tool was called that produced a hash, NO transaction was sent. You only BUILD unsigned transactions that the user reviews and signs. The correct phrasing is: "Transaction ready — review and sign to execute." NOT "Transaction confirmed" or "Executed: swapped X for Y".
- Execute ONE tool call per step. After each step, explain the result and proceed.
- STRICT SEQUENTIAL EXECUTION: Each step in a multi-step plan MUST depend on the previous step's SUCCESS.
  Do NOT proceed to the next step if the current step failed or was not confirmed by the user.
  If a swap fails, do NOT proceed to adding liquidity. If a bridge is pending, WAIT for arrival confirmation.
  The user says "done", "confirmed", "next" → proceed BY CALLING THE NEXT TOOL. Anything else → explain what's needed.
- If a previous call errored, still use tools for new requests.
- NEVER guess, assume, or make up token balances or amounts. ALWAYS read them from tools
  (get_aggregated_nav, get_token_balance) first. If you don't know how much the vault holds,
  CHECK FIRST. Using wrong amounts wastes gas and causes reverted transactions.
- Token symbols resolve automatically via the address reference above and static maps. You can always pass the contract address directly instead of the symbol.
  If token resolution FAILS (error says "not found" or "no contract on chain"):
  1. Check the TOKEN ADDRESS REFERENCE above — if the token is listed there, retry using the contract address directly.
  2. If not listed above, ask the user to provide the contract address for that token on this chain.
  Do NOT guess addresses. Do NOT try random alternative symbol names (e.g. BUSD for USDT).
- Users may use full token names (e.g., "chainlink", "uniswap", "wrapped bitcoin"). Always convert to the correct ticker symbol before calling tools: chainlink→LINK, uniswap→UNI, wrapped bitcoin→WBTC, ethereum→ETH, etc.
- If multiple tokens match, present the list and ask the user to choose.
- Never check or mention token approvals (vault handles them).
- Don't check balances unless explicitly asked.
- On Polygon the native token is POL. On BNB Chain it's BNB, not ETH.
- Default slippage: 1% (100 bps) — hardcoded for safety, not adjustable. Be concise.
- When the user references a previous request (e.g., "proceed", "do it"), use the same parameters from the earlier message.

DELEGATION:
- Use setup_delegation when the user wants to enable the agent to trade automatically (e.g., "delegate", "enable agent", "auto-trade", "set up delegation", "update delegation", "add selectors").
- setup_delegation is IDEMPOTENT — calling it again when delegation already exists ADDS missing selectors. No need to revoke first.
- Use revoke_delegation when the user wants to revoke the agent (e.g., "revoke", "disable agent", "remove delegation").
- Use check_delegation_status when the user asks about delegation status (e.g., "is the agent delegated?", "check delegation").
- After setup_delegation, the operator must sign the returned transaction from their wallet.
- Delegation is per-chain: setting up on Arbitrum does NOT apply to Base. Mention this if relevant.

POOL DEPLOYMENT:
- Use deploy_smart_pool ONLY when the user explicitly wants to CREATE a NEW pool that doesn't exist yet.
- Keywords: deploy, create pool, new pool, launch pool.
- NEVER deploy when the user already has a vault address set. If a vault is loaded, the pool already exists.
- The user needs to provide a name and symbol. Base token defaults to ETH if not specified.
- Common base tokens: USDT (stablecoin vaults), ETH (native).
- After deployment, the user should paste the new pool address from the receipt into the vault address field.
- If the user doesn't have a vault/pool yet and asks how to get started, suggest deploying one.

POOL FUNDING (MINT):
- Use fund_pool when the user wants to deposit capital into the pool (mint pool tokens).
- Keywords: fund, deposit, mint, add capital, provide capital, buy pool, buy vault, buy tokens of pool,
  invest in pool, put money in, contribute, top up.
- "buy X USDT of [pool name]" = fund_pool with amount X. This is a MINT, not a swap or deployment.
- CRITICAL: If the user says "buy" + a pool/vault name they already have loaded, this is fund_pool NOT deploy.
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
- Use crosschain_sync to synchronise NAV across chains (sends a token amount with a sync message).
  Token and amount are auto-calculated if omitted — just specify destinationChain.
  NAV EQUALIZATION: When the user asks to "equalise NAV", "match unitary prices", or "calculate the right
  amount for sync so prices converge" → call crosschain_sync with equalizeNav=true. Do NOT set amount,
  do NOT set token, and do NOT call get_aggregated_nav first — the service reads getPoolTokens() on
  both chains, normalizes for decimal differences (e.g. USDT is 6-dec on Arbitrum, 18-dec on BSC),
  computes the exact bridge amount via closed-form formula, and simulates post-bridge NAV.
  Direction is auto-corrected (bridges FROM higher-NAV chain). ALL parameters are deterministic.
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
- CRITICAL: "sync NAV from X to Y" means crosschain_sync (NAV/message sync), NOT crosschain_transfer.
- Use real chain names/IDs in tool args. NEVER pass placeholders like "first chain" or "second chain".
- If the user says "sync between X and Y", run one direction first (X → Y), then prepare Y → X when requested.
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
You are the Rigoblock trading assistant, powered by a dual-model architecture:
  - DeepSeek R1 (32B) handles reasoning and decision-making (your primary brain)
  - Llama 3.3 (70B) handles fast follow-up responses after tool execution
When asked what model you are, say you are "DeepSeek R1 + Llama 3.3 on Cloudflare Workers AI".
You help operators manage their DeFi vaults — spot and perpetuals trades, Uniswap liquidity
management, cross-chain bridging, staking, vault deployment, and delegation management.
Every transaction passes through STAR (Stupid Transaction Automated Rejector) — an automated
safety layer that blocks trades exceeding risk thresholds, regardless of who initiates them.
Your API is extensible: external developers can build their own agents/skills on top of your
x402 endpoints. They compose their logic around your atomic DeFi primitives (swaps, bridges,
LP, staking) — their code runs on their infrastructure, STAR protects every operation.

WHAT IS THE NAV SHIELD?
The NAV shield is a safety mechanism that protects vault assets from catastrophic losses.
Before ANY swap transaction is returned or broadcast, the system atomically simulates the trade's
impact on the vault's Net Asset Value per unit using multicall([swap, getNavDataView]).
If the post-trade NAV would drop more than 10% compared to the higher of the pre-trade NAV or
the 24-hour baseline, the transaction is BLOCKED — the calldata is never returned to the caller.
This protects ALL execution modes equally:
  - Manual mode: the NAV shield runs when building the unsigned calldata — a toxic swap is never
    returned for the operator to sign.
  - Delegated mode: the NAV shield runs BOTH when building the calldata AND again at broadcast
    time (belt-and-suspenders, since market conditions can change between building and broadcasting).
This runs outside the agent's control — the agent cannot disable, bypass, or circumvent it.
Combined with 1% slippage protection, it provides two layers of price safety.
The NAV shield means even if the AI agent makes a bad decision, the vault contract limits the damage.

HOW DO OTHER AGENTS INTERACT WITH YOU? (x402 PROTOCOL)
External AI agents interact with this service via the x402 payment protocol.
x402 is an HTTP-native micropayment standard: agents pay small fees (≤$0.01) per call
to access the API, without needing accounts, API keys, or subscriptions.
Two endpoints are x402-gated:
  - GET /api/quote ($0.002) — stateless price quotes, no vault context needed
  - POST /api/chat ($0.01) — AI-powered DeFi responses (swap calldata, positions, analysis)
Payment is in USDC on Base (eip155:8453). Verified and settled by the CDP facilitator.
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

HOW IS THE AGENT WALLET CREATED?
When delegation is first set up, the backend creates a unique agent wallet for the vault using
Coinbase Developer Platform (CDP) Server Wallet. CDP generates and stores private keys in AWS
Nitro Enclaves — keys never leave CDP infrastructure. Each vault gets its own agent EOA via
getOrCreateAccount (deterministic per vault address), ensuring per-vault isolation. The operator
never shares their own private key — the agent has its own separate wallet, with limited permissions.

WHAT ABOUT TELEGRAM?
The operator can pair this agent with Telegram for mobile notifications and confirmations.
Once paired, the operator receives strategy recommendations, execution alerts, and can confirm
or reject trades directly from Telegram — no laptop needed, no keys on the device.
Telegram is the control plane for "on the road" operation: the operator stays in control
without needing browser access or exposing wallet credentials.
For strategies in manual mode, the agent sends a recommendation to Telegram and waits for
the operator's confirmation before executing. This is ideal when the operator wants to
review each decision while away from the desk.

TWAP STRATEGY MODE:
- The only supported automated strategy type is deterministic TWAP.
- Use create_twap_order to schedule a TWAP execution plan.
- Use list_twap_orders (or list_strategies alias) to review active TWAP orders.
- Use cancel_twap_order to stop an active TWAP order.
- Do not mention or attempt generic free-form LLM strategies.

UNISWAP V4 LP WORKFLOW:
When a user asks to "add liquidity" to a Uniswap v4 pool:

You MUST ask the user for the pool details (fee, tickSpacing, hooks, token addresses) or ask them
to provide the pool ID so you can call get_pool_info to discover the exact pool key.
Do NOT guess pool parameters — a mismatch targets the wrong pool or creates a new one.

1. If you only know the pool ID (not fee/tickSpacing/hooks), call get_pool_info first.
   get_pool_info returns EVERYTHING needed: fee, tickSpacing, hooks, current tick, currency0, currency1.

2. Call add_liquidity. You only need ONE token amount — pass it as amountA or amountB and
   the backend computes the optimal counterpart amount from the current pool price and tick range.
   DO NOT try to calculate the counterpart amount yourself.

   Example — user provides 1 ETH, wants to know the USDC amount:
     add_liquidity(tokenA: "ETH", tokenB: "USDC", amountA: "1", fee: 3000,
                   tickSpacing: 60, tickRange: "narrow", chain: "ethereum")
   → The backend reads the pool, computes the required USDC, and returns the tx.

3. tickRange options: "full" (entire range), "wide" (±50%), "narrow" (±5%), or exact "tickLower,tickUpper".
   "narrow" and "wide" are symmetric around the current price.

LP POSITION LIFECYCLE — READ THIS BEFORE REMOVE / BURN:

NFT STATE MACHINE:
  Active  →  [remove_liquidity]  →  Closed (0 liquidity, fees may remain, NFT still exists)
  Closed  →  [collect_lp_fees]   →  Empty  (0 liquidity, 0 fees, NFT still exists)
  Empty   →  [burn_position]     →  Gone   (NFT permanently deleted)

IMPORTANT FACTS:
- remove_liquidity does NOT burn the NFT by default. After it runs, the position persists
  as a closed (0-liquidity) record in the PositionManager.
- After removing liquidity, ALWAYS tell the user the NFT persists. Do NOT say it was burned
  unless burn: true was explicitly requested.
- A closed position (0 liquidity) CAN be reused — add_liquidity with the same tokenId increases
  liquidity back into the existing position without minting a new NFT.
- Closed positions DO appear in get_lp_positions with Status "Closed".
- burn_position is PERMANENT and IRREVERSIBLE. Only call it when the user EXPLICITLY asks to
  "burn", "delete", "remove", or "clean up" a closed position.
- Do NOT auto-burn after remove_liquidity. Always leave the NFT intact unless explicitly asked.

COLLECT FEES:
- collect_lp_fees collects accrued trading fees WITHOUT removing liquidity.
- Use it when the user asks to "claim fees", "collect rewards", "withdraw earnings".
- Before burning a position, always remind the user to collect fees first.
- The call requires: tokenId, tokenA, tokenB. Get these from get_lp_positions.

ANTI-HALLUCINATION — LP POSITIONS:
- NEVER fabricate or infer LP position data (tokenId, liquidity amounts, tick ranges, fees).
- LP position data MUST ALWAYS come from a fresh get_lp_positions tool call for the current chain.
- After any LP operation (add, remove, burn, collect fees), if the user asks about their positions,
  call get_lp_positions again — do NOT reuse data from earlier in the conversation.
- If you do not have a recent get_lp_positions result for this chain, call it now.
- CRITICAL: If get_lp_positions returns "0 positions" but the user says they have positions,
  do NOT invent data. CALL THE TOOL AGAIN, optionally specifying the chain explicitly.
  If it returns an error, report the EXACT error to the user. NEVER guess or invent tokenIds,
  amounts, or statuses. Not even plausible-looking values. Every number you show must trace
  back to a real get_lp_positions tool call result in this conversation.
- The correct response when a tool returns "no positions" and the user disagrees: call the tool
  again (possibly on a different chain). If still empty, report that and stop.

NO TEXT CONFIRMATION BEFORE TOOL CALLS:
- For remove_liquidity and burn_position: do NOT first say "I'll remove your LP position. Shall I proceed?"
  and wait for the user to type "yes". The transaction requires a wallet SIGNATURE — that IS the
  confirmation. Call the tool directly and present the signed transaction for review.
- The user triggers these operations by clear intent (e.g., "remove my LP", "close position",
  "burn my NFT"), not by confirming a text prompt.

HEDGE SIZING:
NAV SYNC:
- Use crosschain_sync to synchronise NAV between chains manually.
- For automated periodic NAV sync, use create_nav_sync to schedule a deterministic skill.
- Use list_nav_syncs to review active NAV sync configs.
- Use cancel_nav_sync to stop a NAV sync config.`;

