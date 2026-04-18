# Rigoblock Trader

> Browser-based autonomous DeFi agent for Rigoblock smart pool vaults.
> Open [trader.rigoblock.com](https://trader.rigoblock.com), connect your
> wallet, and start trading — no API key needed. Uses Cloudflare Workers AI
> (Llama 4 Scout) by default, with optional premium model override.

**Built on Coinbase CDP.** The backend uses:
- **Coinbase Developer Platform (CDP) Server Wallet** — per-vault agent wallets with keys in AWS Nitro Enclaves
- **USDC on Base** — x402 payments for external agent API access

**Two wallet modes:**
- **External wallet** — MetaMask, WalletConnect, etc. via EIP-6963 discovery.
- **Agent wallet** — CDP Server Wallet per-vault EOA (keys in AWS Nitro Enclaves, never extractable).

**Zero-friction AI.** Uses Cloudflare Workers AI (Llama 4 Scout) by default —
no API key required. Power users can optionally add their own OpenRouter or
OpenAI key for premium models, like MetaMask lets users customize RPC endpoints.

**Also accessible via x402 API.** External AI agents can call the same
backend via `GET /api/quote` and `POST /api/chat`, paying $0.01/call in
USDC on Base. A TypeScript SDK with a typed HTTP client is included in `sdk/`.

---

## Architecture

```
Browser Chat UI (trader.rigoblock.com)
    ↓ operator connects wallet — starts chatting immediately
    ↓ Workers AI default (Llama 4 Scout), optional premium model override
Cloudflare Worker Backend (trader.rigoblock.com/api)
    ↓ Workers AI reasoning (open-source LLMs) + tool execution
    ↓ tool execution (Uniswap, GMX, Across, vault management)
    ↓ own agent wallet per vault (CDP Server Wallet)
    ↓ EIP-7702 gas-sponsored execution
    ↓ NAV shield (10% max loss) + 7-point validation + delegation check
Rigoblock Vault (on-chain: Ethereum + Arbitrum + 5 more chains)
    ↓ DEX spot + Uni v4 LP + GMX perps + Across bridge
```

**Two interfaces, one backend:**
- **Browser chat** — operator opens the URL, connects wallet, and starts
  chatting immediately. No API key needed (Workers AI default).
- **x402 API** — external AI agents pay $0.01/call in USDC on Base to use the
  same execution backend programmatically.

### What the Agent Does

The agent is a **browser-based AI assistant** with embedded strategy knowledge.
The operator chats with it and it gains:

1. **Knowledge** — what DeFi strategies exist, when to enter/exit, risk factors
2. **Primitives** — tool functions for swaps, LP, perps, bridging, vault ops
3. **Safety rules** — what the NAV shield does, what's fail-closed, what to watch for

The agent then **reasons autonomously** — it picks strategies, sequences
operations, monitors positions, and decides when to rebalance.

### Directory Structure

```
agentic-operator/
├── rigoblock-skill/            ← Strategy docs + reference files
│   ├── README.md               ← You're reading this
│   └── references/
│       ├── API.md              ← HTTP API spec with request/response examples
│       ├── CHAINS.md           ← Chain-specific tokens, addresses, capabilities
│       ├── STRATEGIES.md       ← Strategy entry/exit/monitoring templates
│       └── SAFETY.md           ← NAV shield + delegation security model
├── sdk/                        ← Optional TypeScript SDK for external agents
│   ├── package.json            ← Typed HTTP client, no wallet dependencies
│   └── src/
│       ├── client.ts           ← x402-ready HTTP client wrapper
│       ├── tools.ts            ← Individual tool functions for agent invocation
│       └── types.ts            ← Request/response type definitions
├── src/                        ← Cloudflare Worker backend
│   ├── llm/                    ← LLM client + tool definitions
│   ├── routes/                 ← API routes (chat, quote, delegation)
│   ├── services/               ← Trading, execution, safety
│   └── middleware/             ← x402 payment gate
└── public/
    └── index.html              ← Browser chat UI
```

---

## Getting Started

### Browser (recommended)

1. Open [trader.rigoblock.com](https://trader.rigoblock.com)
2. Connect your wallet (MetaMask / WalletConnect)
3. Start chatting: *"Show vault info on Arbitrum"*
4. (Optional) Click **⚙ AI Model** → add your own OpenRouter or OpenAI key for premium models

No install, no terminal. Agent wallets use EIP-7702 gas sponsorship (no ETH needed).

### From source

```bash
git clone https://github.com/RigoBlock/agentic-operator
cd agentic-operator && npm install && npx wrangler dev
```

### SDK for external agents

The `sdk/` folder provides a typed TypeScript HTTP client
for developers who want programmatic access via x402:

```bash
cd sdk && npm install
```

---

## Quick Start for Judges

1. Open [trader.rigoblock.com](https://trader.rigoblock.com) in your browser
2. Connect your wallet (MetaMask, WalletConnect, etc.)
3. Ask: *"Show vault info on Arbitrum"*  (uses Workers AI — no API key needed)
4. (Optional) Click **⚙ AI Model** → add OpenRouter or OpenAI key for premium models

**Security model:** Agent wallets are managed by CDP Server Wallet — keys are generated and stored by Coinbase in AWS Nitro Enclaves (TEE). Private keys never leave CDP infrastructure and cannot be extracted. Each vault has a unique agent EOA. The vault owner can revoke delegation at any time. Transactions are gas-sponsored via EIP-7702 (Alchemy) — no ETH needed for the agent wallet.

To verify the SDK independently:

```bash
git clone https://github.com/RigoBlock/agentic-operator
cd agentic-operator/sdk && npm install
npx tsc --noEmit  # type-check
```

The SDK is a pure typed HTTP wrapper. It provides:
- `RigoblockClient` for x402-authenticated API calls
- Individual tool functions for agent invocation
- Full TypeScript type definitions for all request/response shapes

Operator auth signature (EIP-191) is handled by the agent's own wallet.

To try the full agent flow with the live API, open
[trader.rigoblock.com](https://trader.rigoblock.com) and connect your wallet.

---

## How It Works (for agent developers)

Every DeFi operation maps to one HTTP call:

| Operation | HTTP Call |
|-----------|----------|
| Get a price quote | `GET /api/quote?sell=ETH&buy=USDC&amount=1&chain=base` |
| Swap tokens | `POST /api/chat` with message: `"swap 1000 USDT for ETH on Arbitrum"` |
| Add LP | `POST /api/chat` with message: `"add liquidity to ETH/USDC pool..."` |
| Open GMX position | `POST /api/chat` with message: `"open a 1x short ETH/USD..."` |
| Bridge tokens | `POST /api/chat` with message: `"bridge 1000 USDT from Ethereum to Arbitrum"` |
| Get vault info | `POST /api/chat` with message: `"show vault info on Arbitrum"` |

The chat endpoint understands natural language. The agent doesn't need to
construct exact JSON — it describes what it wants in plain English and the
API's LLM backend routes to the right tool.

### x402 Payment

Every request needs an `X-PAYMENT` header. Without it, the API returns `402`.
The x402 protocol handles payment signing — your wallet signs a micropayment
($0.002 for quotes, $0.01 for operations) and includes it in the header.

### Operator Auth (for execution)

Manual mode (default) returns unsigned transaction data — safe for any caller.
Delegated mode requires the operator to sign this EIP-191 message:

```
Welcome to Rigoblock Operator

Sign this message to verify your wallet and access your smart pool assistant.
```

---

## Strategies

The service exposes atomic DeFi primitives via `POST /api/chat` and `GET /api/quote`.
External agents compose these into custom strategies. Built-in automated strategies:
TWAP and NAV Sync. See [references/STRATEGIES.md](./references/STRATEGIES.md).

---

## Safety Guarantees

Every transaction passes five checks before broadcast:

1. **Operator auth** — EIP-191 signature proving vault ownership
2. **Delegation** — vault must delegate to agent wallet for the function selector
3. **7-point validation** — config, target, selector whitelist, agent ID,
   simulation, balance, gas caps
4. **NAV shield** — blocks if vault unit price drops >10%. **Fail-closed**.
5. **Slippage** — 1% default tolerance on all swaps

See [references/SAFETY.md](./references/SAFETY.md) for the full model.

---

## Supported Chains

| Chain | ID | Swap | LP | Perps | Bridge |
|-------|----|------|----|-------|--------|
| Ethereum | 1 | Uniswap, 0x | Uni v4 | — | Across |
| Base | 8453 | Uniswap, 0x | Uni v4 | — | Across |
| Arbitrum | 42161 | Uniswap, 0x | Uni v4 | GMX V2 | Across |
| Optimism | 10 | Uniswap, 0x | Uni v4 | — | Across |
| Polygon | 137 | Uniswap, 0x | — | — | Across |
| BNB Chain | 56 | Uniswap, 0x | — | — | Across |
| Unichain | 130 | Uniswap | Uni v4 | — | — |

---

## x402 API — For External AI Agents

External agents can also use the same backend via `GET /api/quote` and
`POST /api/chat`, paying $0.01/call in USDC on Base. See [AGENTS.md](../AGENTS.md)
for the full x402 integration guide, auth model, and safety guarantees.

---

## Gumloop Integration (Python Agent)

For agents running in **Gumloop** or any Python sandbox — fully autonomous,
no manual setup, no Node.js needed. These agents use the x402 API endpoint.

### How It Works

The Gumloop agent creates its own wallet, deploys vaults, and starts trading
— all autonomously. The only manual step is funding the wallet after the agent
creates it (because the agent can't fiat-on-ramp itself yet).

### Agent Self-Bootstrap Flow

```
1. Agent generates a wallet:
     account = Account.create()
   → Agent stores private key for future sessions
   → Or use CDP Server Wallet for managed keys

2. Agent outputs its address → operator funds it:
     - USDC on Base        → x402 API payments ($0.01/call)
     - ETH on Ethereum   → vault deploy + delegation + LP gas (~$5)
     - ETH on Arbitrum   → vault deploy + delegation gas (~$1)

3. Agent deploys vaults:
     rigoblock_chat("deploy a smart pool named 'GumVault' with symbol 'GV' on Ethereum")
     → signs and broadcasts unsigned tx → saves vault address
     rigoblock_chat("deploy a smart pool named 'GumVault' with symbol 'GV' on Arbitrum")
     → signs and broadcasts unsigned tx → saves vault address

4. Agent sets up delegation on both chains:
     rigoblock_chat("setup delegation on Ethereum", vaultAddress=VAULT_ETH)
     rigoblock_chat("setup delegation on Arbitrum", vaultAddress=VAULT_ARB)

5. Agent funds vaults and starts trading in delegated mode:
     rigoblock_chat("fund pool with 1 ETH", vaultAddress=VAULT_ETH, chainId=1)
     rigoblock_chat("bridge 500 USDT from Ethereum to Arbitrum", ...)
     rigoblock_chat("swap 100 USDT for ETH on Ethereum", executionMode="delegated")
```

The agent uses `rigoblock_chat()` and `rigoblock_quote()` skills (HTTP wrappers
around our API with x402 payment built in).

### Cross-Chain Setup (Ethereum + Arbitrum)

```
1. Deploy vault on Ethereum → save VAULT_ETH
2. Deploy vault on Arbitrum → save VAULT_ARB
3. Setup delegation on both chains
4. Fund vault on Ethereum (investors mint pool tokens here)
5. Bridge hedge collateral from Ethereum to Arbitrum via Across:
     rigoblock_chat("bridge 500 USDT from Ethereum to Arbitrum",
       vaultAddress=VAULT_ETH, chainId=1)
6. LP on Ethereum (ETH/USDC Uni v4 pool):
     rigoblock_chat("add liquidity to ETH/USDC pool",
       vaultAddress=VAULT_ETH, chainId=1)
7. Hedge on Arbitrum (GMX perps):
     rigoblock_chat("open 1x short ETH/USD with 500 USDT collateral on GMX",
       vaultAddress=VAULT_ARB, chainId=42161)
8. Sync NAV across chains:
     rigoblock_chat("sync NAV", ...)
```

### Architecture

This project provides two core layers:

**Wallet Layer (CDP Server Wallet)**
- Coinbase CDP creates per-vault agent wallets (TEE-sealed, keys never extractable)
- Agent signs x402 USDC micropayments on Base
- Agent signs operator auth (EIP-191) for vault access
- Agent holds and manages assets autonomously via vault

**Autonomous DeFi Agent**
- Agent decides strategy, timing, and allocation — fully autonomous
- CDP wallet handles all signing (payments, auth, transactions)
- DeFi execution via Rigoblock API (Uniswap, GMX, Across bridge)
- STAR (Stupid Transaction Automated Rejector) protects every transaction
- Agent bootstraps itself: creates wallet → deploys vaults → delegates → trades

```
┌─────────────────────────────────────────────┐
│  Agent Layer (any framework)                │
│  • Reads STRATEGIES.md for strategy knowledge│
│  • Decides when/what to trade               │
│  • Sequences multi-step operations          │
│  • Monitors positions, rebalances           │
└──────────────────┬──────────────────────────┘
                   │ HTTP calls
┌──────────────────▼──────────────────────────┐
│  Wallet Layer (Coinbase CDP)                │
│  • TEE-sealed keys (AWS Nitro Enclave)      │
│  • Signs x402 USDC micropayments            │
│  • Signs operator auth (EIP-191)            │
└──────────────────┬──────────────────────────┘
                   │ X-PAYMENT header + auth
┌──────────────────▼──────────────────────────┐
│  Execution Layer (Rigoblock API + STAR)     │
│  • NAV shield: blocks >10% loss per trade   │
│  • Delegation check: vault must authorize   │
│  • 7-point validation before broadcast      │
│  • Spot (Uniswap/0x) + Perps (GMX) + LP    │
│  • Cross-chain bridge (Across Protocol)     │
└──────────────────┬──────────────────────────┘
                   │ on-chain transactions
┌──────────────────▼──────────────────────────┐
│  On-Chain (Rigoblock Vault)                 │
│  • Smart pool with delegation controls      │
│  • Vault owner retains full control         │
│  • withdraw/transferOwnership never delegated│
└─────────────────────────────────────────────┘
```

---

## Development

```bash
# Run the Worker locally
cd /path/to/agentic-operator
npm run dev

# Install and test the SDK
cd sdk && npm install && npx tsx test/test-secure-wallet.ts

# Type-check the SDK
cd sdk && npx tsc --noEmit
```
