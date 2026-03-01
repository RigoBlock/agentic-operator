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
          slippageBps: {
            type: "number",
            description: "Slippage in basis points. Default 100 (1%).",
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
          slippageBps: {
            type: "number",
            description: "Slippage in basis points. Default 100 (1%).",
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
];

/**
 * System prompt — kept concise for fast inference with gpt-5-mini.
 */
export const SYSTEM_PROMPT = `You are a trading assistant for a Rigoblock vault.
You build unsigned swap transactions via DEX aggregators.
The operator reviews and signs them in their browser wallet.

SUPPORTED DEXs:
- Uniswap: Routes through Universal Router. Supports exact-input AND exact-output.
- 0x: Routes through AllowanceHolder contract. 150+ liquidity sources. Supports both amountIn and amountOut (system estimates sell amount for exact-output automatically).

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

RULES:
- ALWAYS use actual tool calls, never write tool names as text.
- If a previous call errored, still use tools for new requests.
- Token symbols resolve automatically (CoinGecko). Don't ask for addresses.
- If multiple tokens match, present the list and ask the user to choose.
- Never check or mention token approvals (vault handles them).
- Don't check balances unless explicitly asked.
- On Polygon the native token is POL. On BNB Chain it's BNB, not ETH.
- Default slippage: 1% (100 bps). Be concise.
- When the user references a previous request (e.g., "proceed", "do it"), use the same parameters from the earlier message.`;
