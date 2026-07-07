/**
 * Tool definitions for LLM function calling.
 *
 * Phase 1: Agent builds unsigned transactions, operator signs from their wallet.
 * One-step flow: user asks → build_vault_swap → transaction modal immediately.
 */

/**
 * OpenAI-compatible tool definitions for function calling.
 *
 * TOOL_DEFINITIONS is the full catalog (used by /api/tools discovery and direct
 * tool invocation). AGENT_TOOL_DEFINITIONS is the subset exposed to the chat LLM.
 * Operator-scoped mutation tools (slippage, swap/NAV shield settings, private
 * strategy lists) are NOT given to the LLM so a prompt-injected agent cannot
 * change safety settings even inside a verified operator session.
 */
export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "get_swap_quote",
      description:
        "Get a price-only quote WITHOUT building a transaction. Use ONLY when the user explicitly asks for a price or quote without wanting to execute. " +
        "For actual conversions (swap/buy/sell/wrap/unwrap), use build_vault_swap instead.",
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
            description: "Amount to sell (human-readable). Provide either amountIn (exact-input) or amountOut (exact-output).",
          },
          amountOut: {
            type: "string",
            description: "Amount to buy (human-readable). Provide either amountIn (exact-input) or amountOut (exact-output).",
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
        "Build an unsigned token conversion transaction for the operator to sign. " +
        "Handles ALL token conversions: swap/buy/sell, wrap ETH→WETH, unwrap WETH→ETH. " +
        "Call this DIRECTLY — it fetches a quote and builds the transaction in one step. " +
        "The frontend shows a confirmation modal with the full quote details. " +
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
            description: "Amount to sell (human-readable). Provide either amountIn (exact-input) or amountOut (exact-output).",
          },
          amountOut: {
            type: "string",
            description: "Amount to buy (human-readable). Provide either amountIn (exact-input) or amountOut (exact-output).",
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
      name: "verify_token",
      description:
        "Verify a token address or name against CoinGecko and register it for the current chain. " +
        "Use this when a previous swap or quote failed because a token symbol could not be resolved " +
        "or was ambiguous. The registry only stores mappings that CoinGecko confirms.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Token symbol, e.g. LIT",
          },
          identifier: {
            type: "string",
            description: "Contract address (0x...) or exact token name as shown on CoinGecko",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID. Only needed if different from the current chain.",
          },
        },
        required: ["symbol", "identifier"],
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
        required: ["token", "tokenIn", "tokenOut"],
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
      name: "gmx_decrease_position",
      description:
        "Close (fully or partially) an existing GMX v2 perpetual position, or withdraw collateral from it. " +
        "Builds an unsigned createDecreaseOrder transaction. " +
        "To close fully, set sizeDeltaUsd to the full position size — all remaining collateral is returned automatically. " +
        "To partially close, set a smaller sizeDeltaUsd. " +
        "To withdraw collateral WITHOUT changing position size, set sizeDeltaUsd='0' and collateralDeltaAmount to the amount to withdraw.",
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
            description: "Absolute USD amount to decrease from the position (e.g. '5000' for $5,000), or a percentage like '50%'. Must be the DOLLAR VALUE to close, not a token amount, not a raw number, and not a literal percentage without the '%' sign. Use 'all' to close entirely. Set '0' to withdraw collateral only without changing position size.",
          },
          collateral: {
            type: "string",
            description: "Collateral token symbol used in the position (e.g., 'WETH', 'USDC'). Helps disambiguate when multiple positions exist for the same market and direction.",
          },
          collateralDeltaAmount: {
            type: "string",
            description: "Amount of collateral to explicitly withdraw (default: '0'). On a full close this is ignored — all collateral is returned automatically. Use this for partial closes or collateral-only withdrawals (sizeDeltaUsd='0').",
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
        "Increase the size of an existing GMX v2 perpetual position or add collateral to it. " +
        "Use this when the user already has an open position and wants to add to it. " +
        "Modes: (1) notionalUsd + leverage → adds size and collateral, (2) notionalUsd without leverage → preserves current leverage ratio, (3) collateralAmount + leverage → adds collateral AND size, (4) collateralAmount with sizeDeltaUsd='0' → adds collateral ONLY, (5) sizeDeltaUsd without collateralAmount (or collateralAmount='0') → increases size WITHOUT adding collateral (leverage goes up).",
      parameters: {
        type: "object",
        properties: {
          market: {
            type: "string",
            description: "Market index token symbol (e.g., 'ETH', 'BTC', 'LIT')",
          },
          collateral: {
            type: "string",
            description: "Collateral token symbol (e.g., 'WETH', 'USDC'). Auto-resolved from existing position when omitted.",
          },
          collateralAmount: {
            type: "string",
            description: "Additional collateral amount in human-readable units (e.g., '200' USDC). Set to '0' or omit to increase size WITHOUT adding collateral (leverage will rise).",
          },
          notionalUsd: {
            type: "string",
            description: "Additional notional position size in USD (e.g., '1500'). When used with leverage, collateral = notionalUsd / leverage. Without leverage, current leverage is preserved. Preferred when user says 'increase by $1500'.",
          },
          sizeDeltaUsd: {
            type: "string",
            description: "Additional position size in USD. Set to '0' to add collateral ONLY without increasing position size. Omit collateralAmount to increase size without adding collateral.",
          },
          isLong: {
            type: "boolean",
            description: "true for long, false for short — must match the existing position",
          },
          leverage: {
            type: "string",
            description: "Desired leverage multiplier (e.g., '10' for 10x). If omitted when increasing size, current leverage is preserved. Ignored when sizeDeltaUsd='0' or collateralAmount='0'.",
          },
        },
        required: ["market", "isLong"],
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
  {
    type: "function" as const,
    function: {
      name: "check_pending_tx",
      description:
        "Check the status of the most recent pending or stuck sponsored/agent transaction for the vault. " +
        "Use this whenever the user asks about a pending, stuck, missing, or slow transaction, swap, or trade — " +
        "for example 'is my trade stuck?', 'what happened to my swap?', 'do I have a pending transaction?', " +
        "or 'did my transaction go through?'. Returns confirmed, reverted, or still-pending status along with " +
        "the transaction hash and explorer link when available.",
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
        "Build a cross-chain bridge transaction in ONE step. Call this DIRECTLY when the user wants " +
        "to bridge/transfer/move a specific amount of a token between named chains. Fetches the quote " +
        "and prepares the transaction in a single call — do NOT call get_crosschain_quote first. " +
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
            description: "Controls destination token form for ETH/WETH bridges. " +
              "OMIT for same-token default (ETH→ETH, WETH→WETH). " +
              "Set false when user explicitly wants WETH on destination with ETH on source (e.g., 'bridge ETH to WETH'). " +
              "Set true when user explicitly wants ETH on destination with WETH on source (e.g., 'bridge WETH to ETH').",
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
        "ONE-OFF cross-chain NAV synchronisation via Across Protocol. Use this for a single " +
        "sync operation, NOT for recurring automation (use create_nav_sync for scheduling). " +
        "The bridged tokens carry a sync message (opType=Sync) — the vault moves tokens to the " +
        "destination chain but does NOT burn/mint virtual supply; instead it propagates NAV state. " +
        "Use when the user says 'sync', 'NAV sync', or wants to move tokens cross-chain while " +
        "preserving supply and updating NAV. " +
        "Supports explicit amount/token OR deterministic equalization. " +
        "Supports WETH↔ETH forms via useNativeEth and shouldUnwrapOnDestination. " +
        "DETERMINISTIC EQUALIZATION (amount OMITTED): the tool simulates updateUnitaryValue() on both " +
        "chains to read live NAV, normalizes unitaryValue " +
        "accounting for decimal differences (e.g. USDT is 6-dec on Arbitrum but 18-dec on BSC), " +
        "applies a closed-form formula to find the exact bridge amount that equalizes NAV, and " +
        "simulates post-bridge NAV to verify convergence. " +
        "Direction, token, and amount are auto-determined. An optional token can be provided as " +
        "a preference. The LLM must NEVER guess an amount. " +
        "EXPLICIT AMOUNT (amount PROVIDED): bridges exactly the operator-specified amount. " +
        `Token is required in this mode.`,
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
            description: "Token to bridge for the sync message (USDC, USDT, WETH, WBTC). " +
              "REQUIRED when amount is provided. OPTIONAL when amount is omitted — used as the preferred token for deterministic equalization.",
          },
          amount: {
            type: "string",
            description: "Explicit amount to bridge (human-readable). Omit for deterministic NAV equalization; " +
              "if provided, token must also be provided.",
          },
          navToleranceBps: {
            type: "number",
            description:
              "On-chain NAV impact tolerance for the sync, in basis points (default: 100 = 1%). " +
              "This is encoded into the depositV3 SourceMessageParams and checked by the AIntents contract on the SOURCE chain: " +
              "because a sync moves tokens out without burning virtual supply, the source-chain unit price drops, and the contract rejects the tx if the drop exceeds this tolerance. " +
              "Raise this (e.g. to 500-1000 bps = 5-10%) if the sync amount is large relative to vault NAV. " +
              "This is INDEPENDENT of the server-side NAV shield threshold controlled via /navshield or Settings → NAV Shield.",
          },
          useNativeEth: {
            type: "boolean",
            description:
              "If true AND token is WETH, the vault wraps native ETH→WETH automatically via sourceNativeAmount. " +
              "Use when the vault holds native ETH but not WETH. Default: false.",
          },
          shouldUnwrapOnDestination: {
            type: "boolean",
            description:
              "Controls destination token form for ETH/WETH syncs. OMIT for same-token default (ETH→ETH, WETH→WETH). " +
              "Set true when the user explicitly wants native ETH on destination with WETH on source (e.g. 'sync WETH to ETH'). " +
              "Set false when the user explicitly wants WETH on destination with ETH on source (e.g. 'sync ETH to WETH').",
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
            description: "Optional pool ID (bytes32 keccak256 hash of the PoolKey). If omitted, returns every active pool owned by the vault — e.g., '0xb896675bfb20eed4b90d83f64cf137a860a99a86604f7fac201a822f2b4abc34'",
          },
          chain: {
            type: "string",
            description: "Chain name or ID (e.g., 'arbitrum', '42161')",
          },
        },
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
        "CRITICAL: fee=0 does NOT auto-derive tickSpacing=32767; the default for fee=0 is tickSpacing=1. " +
        "Always provide tickSpacing explicitly for non-standard pools (e.g. oracle pools with tickSpacing=32767). " +
        "If the pool is not yet initialized, call initialize_pool first. " +
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
              "Tick spacing for the pool — REQUIRED when fee does not map to a standard tier. " +
              "Auto-derived from fee if omitted: 100→1, 500→10, 3000→60, 6000→120, 10000→200. " +
              "WARNING: fee=0 defaults to tickSpacing=1, NOT 32767. " +
              "Oracle pools and full-range positions often use tickSpacing=32767 — pass it explicitly. " +
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
      name: "initialize_pool",
      description:
        "Initialize a Uniswap v4 pool on the PoolManager. " +
        "ANYONE can initialize a pool — it does not require vault ownership. " +
        "Initialization sets the initial price (sqrtPriceX96) and creates the pool so liquidity can be added. " +
        "You must provide either (1) both token amounts, from which the initial price is computed, OR " +
        "(2) an explicit sqrtPriceX96 string. " +
        "After initialization, use add_liquidity to add liquidity through the vault. " +
        "This transaction targets the PoolManager directly (not the vault) and must be signed by the operator.",
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
          fee: {
            type: "number",
            description:
              "Pool fee in hundredths of a bip — REQUIRED. " +
              "Common values: 0=0%, 100=0.01%, 500=0.05%, 3000=0.30%, 10000=1%.",
          },
          tickSpacing: {
            type: "number",
            description:
              "Tick spacing for the pool — REQUIRED for non-standard pools. " +
              "Auto-derived from fee if omitted: 100→1, 500→10, 3000→60, 6000→120, 10000→200. " +
              "WARNING: fee=0 defaults to tickSpacing=1, NOT 32767.",
          },
          hooks: {
            type: "string",
            description: "Hook contract address. Default: zero address (no hooks).",
          },
          sqrtPriceX96: {
            type: "string",
            description:
              "Explicit initial sqrtPriceX96 as a decimal string (Q64.96 fixed-point). " +
              "If omitted, amountA and amountB must be provided to compute the price automatically.",
          },
          amountA: {
            type: "string",
            description:
              "Amount of tokenA to use for price computation (human-readable). " +
              "Required if sqrtPriceX96 is omitted.",
          },
          amountB: {
            type: "string",
            description:
              "Amount of tokenB to use for price computation (human-readable). " +
              "Required if sqrtPriceX96 is omitted.",
          },
          chain: {
            type: "string",
            description: "Target chain name or ID (e.g., 'ethereum', 'base', '42161')",
          },
        },
        required: ["tokenA", "tokenB", "fee"],
        oneOf: [
          {
            description: "Provide an explicit initial sqrtPriceX96",
            required: ["sqrtPriceX96"],
          },
          {
            description: "Provide both token amounts to compute the initial price automatically",
            required: ["amountA", "amountB"],
          },
        ],
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
      name: "set_swap_shield_tolerance",
      description:
        "Temporarily raise the Swap Shield tolerance (max divergence from oracle) for 10 minutes. " +
        "Use when the operator knowingly accepts price impact (e.g., large trades in thin markets). " +
        "Provide a percentage like '30%' or '50'. The default is 5%; you can set up to 50%. " +
        "The shield automatically resets to 5% after 10 minutes.",
      parameters: {
        type: "object",
        properties: {
          tolerance: {
            type: "string",
            description: "Tolerance percentage, e.g. '30%' or '50' (up to 50%)",
          },
        },
        required: ["tolerance"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "enable_swap_shield",
      description:
        "Reset the Swap Shield tolerance to the default 5% immediately. " +
        "Use to cancel a previous tolerance override before the 10-minute timeout.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_nav_shield_threshold",
      description:
        "Temporarily set the NAV Shield maximum allowed loss threshold (1%–100%) for 10 minutes. " +
        "The default is 10%. Trades that would reduce the vault's unit price by more than " +
        "this threshold are blocked. The override auto-resets to the default after 10 minutes.",
      parameters: {
        type: "object",
        properties: {
          threshold: {
            type: "string",
            description: "Threshold percentage, e.g. '15%' or '15' (1%–100%)",
          },
        },
        required: ["threshold"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "enable_nav_shield",
      description:
        "Reset the NAV Shield threshold to the default 10% immediately. " +
        "Use to restore the factory default after a custom threshold was set.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "refresh_oracle_feed",
      description:
        "Swap on the BackgeoOracle's dedicated Uniswap V4 oracle pool to refresh a stale TWAP price feed. " +
        "This is the ONLY tool that routes through the BackgeoOracle hook. " +
        "Use this tool whenever the user asks to: sync/refresh/update a price feed or TWAP, " +
        "fix oracle divergence, swap on the oracle pool / via BackgeoOracle, or anything similar. " +
        "Examples: 'sync grg price feed on polygon', 'refresh oracle for GRG', 'swap on BackgeoOracle', " +
        "'fix oracle divergence'. " +
        "The swap is ALWAYS exact-input on the V4 oracle pool (no external 0x/Uniswap API is used). " +
        "When a vault is connected, the vault path is used by default so the swap happens from the vault " +
        "and supports delegation / NAV shield. The EOA path (operator personal wallet) is used only when " +
        "explicitly requested or no vault is connected.\n\n" +
        "HOW TO SPECIFY THE SWAP:\n" +
        "The oracle pool is always NATIVE (POL/ETH/BNB) / ERC-20 (the 'token' argument). " +
        "Use tokenIn (what the trader pays) and tokenOut (what the trader receives). " +
        "One of tokenIn/tokenOut MUST be the native token, the other MUST be the ERC-20 'token'.\n\n" +
        "DECISION TREE:\n" +
        "1. The token the user wants to RECEIVE is tokenOut.\n" +
        "2. The other token in the pair is tokenIn (what they pay).\n" +
        "3. 'buy N X' / 'receive N X' → tokenOut=X, use amountOut=N.\n" +
        "4. 'sell N X' / 'pay N X' / 'spend N X' → tokenIn=X, use amount=N.\n\n" +
        "EXACT PHRASES FOR THE GRG/POL POOL ON POLYGON:\n" +
        "- 'buy 1 POL' / 'receive 1 POL' → receive POL, pay GRG → token='GRG', tokenIn='GRG', tokenOut='POL', amountOut='1'\n" +
        "- 'sell 1 POL' / 'pay 1 POL' / 'buy GRG with 1 POL' → pay POL, receive GRG → token='GRG', tokenIn='POL', tokenOut='GRG', amount='1'\n" +
        "- 'buy 1 GRG' / 'receive 1 GRG' → receive GRG, pay POL → token='GRG', tokenIn='POL', tokenOut='GRG', amountOut='1'\n" +
        "- 'sell 1 GRG' / 'pay 1 GRG' → pay GRG, receive POL → token='GRG', tokenIn='GRG', tokenOut='POL', amount='1'"
      ,
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description:
              "The ERC-20 token whose oracle feed is stale — symbol (e.g., 'GRG', 'USDC') or " +
              "contract address. The native token (ETH/POL/BNB) cannot be specified (it is always currency0).",
          },
          tokenIn: {
            type: "string",
            description:
              "Token the trader is paying into the swap. Must be either the chain's native token (POL/ETH/BNB) or the ERC-20 'token'. " +
              "Use this together with tokenOut to unambiguously specify direction."
          },
          tokenOut: {
            type: "string",
            description:
              "Token the trader is receiving from the swap. Must be either the chain's native token (POL/ETH/BNB) or the ERC-20 'token'. " +
              "Use this together with tokenIn to unambiguously specify direction."
          },
          amount: {
            type: "string",
            description:
              "Exact INPUT amount in tokenIn units. For tokenIn=native: native amount (e.g. '1' POL). " +
              "For tokenIn=ERC20: ERC-20 amount (e.g. '10' GRG). " +
              "Larger amounts move the oracle pool price more aggressively and converge TWAP faster. " +
              "Either amount or amountOut must be provided; there is no default."
          },
          amountOut: {
            type: "string",
            description:
              "Desired approximate OUTPUT amount in tokenOut units, used instead of amount when the user states what they want to RECEIVE. " +
              "If provided, the system estimates the required tokenIn amount using the vault's on-chain oracle. " +
              "The actual received amount may differ — the swap is exact-input with no on-chain min-out bound. " +
              "Requires an active vault session.",
          },
          viaVault: {
            type: "boolean",
            description:
              "If true, route the swap through the vault adapter instead of the operator's personal wallet. " +
              "The vault must have enough of the input token balance. When delegation is active, this enables " +
              "auto-execution with NAV shield protection. Default: true when a vault is connected, false otherwise.",
          },
          chain: {
            type: "string",
            description:
              "Target chain name or ID (e.g., 'Arbitrum', 'Base'). " +
              "Must match the chain where the oracle feed is stale.",
          },
        },
        required: ["token", "tokenIn", "tokenOut"],
      },
    },
  },
];

/** Tools that the LLM agent must never be allowed to invoke (operator-scoped mutations). */
const AGENT_EXCLUDED_TOOLS = new Set<string>([
  "set_default_slippage",
  "set_swap_shield_tolerance",
  "enable_swap_shield",
  "set_nav_shield_threshold",
  "enable_nav_shield",
]);

/** LLM-facing tool definitions — excludes operator settings to prevent prompt-injection mutations. */
export const AGENT_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(
  (t) => !AGENT_EXCLUDED_TOOLS.has(t.function.name),
);

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
