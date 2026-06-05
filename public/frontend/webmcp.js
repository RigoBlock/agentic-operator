import { apiHeaders } from './state.js';

// WebMCP — expose site tools to AI agents via the browser (WebMCP API).
// See https://webmachinelearning.github.io/webmcp/
(function () {
  if (!navigator.modelContext) return;
  const ac = new AbortController();
  navigator.modelContext.registerTool({
    name: 'get_swap_quote',
    description: 'Get a DEX price quote for a token swap on a given chain. Returns sell/buy amounts, routing, and gas estimate.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenIn: { type: 'string', description: 'Token to sell (symbol or address, e.g. "ETH")' },
        tokenOut: { type: 'string', description: 'Token to buy (symbol or address, e.g. "USDC")' },
        amountIn: { type: 'string', description: 'Amount to sell in human-readable form (e.g. "1"). Provide amountIn or amountOut, not both.' },
        amountOut: { type: 'string', description: 'Exact amount to receive (e.g. "100"). Provide amountIn or amountOut, not both.' },
        chain: { type: 'string', description: 'Chain name or ID (e.g. "base", "arbitrum", "8453"). Defaults to Base.' },
      },
      required: ['tokenIn', 'tokenOut'],
    },
    execute: async ({ tokenIn, tokenOut, amountIn, amountOut, chain }) => {
      const args = { tokenIn, tokenOut };
      if (amountIn) args.amountIn = amountIn;
      if (amountOut) args.amountOut = amountOut;
      if (chain) args.chain = chain;
      const res = await fetch('/api/tools?toolName=get_swap_quote', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ arguments: args, chainId: 8453 }),
      });
      return res.json();
    },
    signal: ac.signal,
  });
  navigator.modelContext.registerTool({
    name: 'get_vault_info',
    description: 'Get information about a Rigoblock smart pool vault: NAV, balances, owner, and delegation status.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultAddress: { type: 'string', description: 'Vault contract address (0x...)' },
        chainId: { type: 'number', description: 'EVM chain ID (e.g. 8453 for Base)' },
      },
      required: ['vaultAddress', 'chainId'],
    },
    execute: async (args) => {
      const res = await fetch('/api/tools?toolName=get_vault_info', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ arguments: args, chainId: args.chainId, vaultAddress: args.vaultAddress }),
      });
      return res.json();
    },
    signal: ac.signal,
  });
})();
