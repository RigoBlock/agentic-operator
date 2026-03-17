# Galactica Trader

> Browser-based autonomous DeFi agent for Rigoblock smart pool vaults.
> Open [trader.rigoblock.com](https://trader.rigoblock.com), connect your
> wallet, pick your AI model, and start managing XAUT/USDT LP + permanent
> hedge positions across Ethereum and Arbitrum.

**Built on Tether WDK.** The backend creates and manages agent wallets using
three Tether technologies:
- **`@tetherto/wdk-wallet-evm`** — BIP-39 seed generation, BIP-44 key derivation, transaction signing
- **`@tetherto/wdk-secret-manager`** — seed encryption at rest (PBKDF2 + XSalsa20-Poly1305)
- **USDT0** — x402 payments on Plasma for external agent API access

**Model-agnostic.** The operator picks their AI model via OpenRouter (100+
models including Claude, GPT, Gemini, Llama) or direct OpenAI key. The
operator pays for their own AI usage; execution and safety layer are free.

**Also accessible via x402 API.** External AI agents can call the same
backend via `GET /api/quote` and `POST /api/chat`, paying $0.01/call in
USDT0. A TypeScript SDK with WDK wallet integration is included in `sdk/`.

---

## Architecture

```
Browser Chat UI (trader.rigoblock.com)
    ↓ operator connects wallet, picks AI model (OpenRouter / OpenAI)
    ↓ strategy reasoning via operator's LLM (model-agnostic)
Cloudflare Worker Backend (trader.rigoblock.com/api)
    ↓ routes AI calls via operator's API key
    ↓ tool execution (Uniswap, GMX, Across, vault management)
    ↓ own agent wallet per vault (Tether WDK)
    ↓ EIP-7702 gas-sponsored execution
    ↓ NAV shield (10% max loss) + 7-point validation + delegation check
Rigoblock Vault (on-chain: Ethereum + Arbitrum + 5 more chains)
    ↓ DEX spot + Uni v4 LP + GMX perps + Across bridge
```

**Two interfaces, one backend:**
- **Browser chat** — operator opens the URL, connects wallet, picks their
  model, chats with the agent. No install, no local keys.
- **x402 API** — external AI agents pay $0.01/call in USDT0 to use the
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
├── galactica-trader/           ← Strategy docs + reference files
│   ├── README.md               ← You're reading this
│   └── references/
│       ├── API.md              ← HTTP API spec with request/response examples
│       ├── CHAINS.md           ← Chain-specific tokens, addresses, capabilities
│       ├── STRATEGIES.md       ← Strategy entry/exit/monitoring templates
│       └── SAFETY.md           ← NAV shield + delegation security model
├── sdk/                        ← Optional TypeScript SDK for external agents
│   ├── package.json            ← Deps: wdk-wallet-evm, wdk-secret-manager, viem
│   ├── patches/
│   │   └── patch-bare-crypto.cjs  ← Postinstall: makes wdk-secret-manager work in Node.js
│   ├── test/
│   │   └── test-secure-wallet.ts   ← E2E test: create → encrypt → unlock → sign
│   └── src/
│       ├── wallet.ts           ← WDK wallet: SecureWalletSession, encryption, x402
│       ├── client.ts           ← x402 HTTP client wrapper
│       └── ...                 ← tools, strategies, types
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
2. Connect your wallet (MetaMask, WalletConnect, etc.)
3. Click **⚙ AI Model** → pick your provider (OpenRouter or OpenAI) → paste API key → select model
4. Start chatting: *"Show vault info on Arbitrum"*

No install, no terminal, no local dependencies.

### From source

```bash
git clone https://github.com/RigoBlock/agentic-operator
cd agentic-operator && npm install && npx wrangler dev
```

### SDK for external agents

The `sdk/` folder provides a TypeScript SDK with WDK wallet integration
for developers who want programmatic access via x402:

```bash
cd sdk && npm install  # includes WDK postinstall patch
npx ts-node test/test-secure-wallet.ts  # runs WDK E2E test
```

---

## Quick Start for Judges

1. Open [trader.rigoblock.com](https://trader.rigoblock.com) in your browser
2. Connect wallet (MetaMask, WalletConnect, etc.)
3. Click **⚙ AI Model** → select OpenRouter or OpenAI → paste your API key
4. Ask: *"Show vault info on Arbitrum"*

To verify the WDK integration independently:

```bash
git clone https://github.com/RigoBlock/agentic-operator
cd agentic-operator/sdk && npm install
npx ts-node test/test-secure-wallet.ts
```

This runs the full Tether WDK integration test:
- **`@tetherto/wdk-wallet-evm`** generates a BIP-39 seed and derives an EVM account
- **`@tetherto/wdk-secret-manager`** encrypts the seed with a passkey (PBKDF2 + XSalsa20-Poly1305)
- Encrypted store saved to disk, reloaded, and decrypted — proving round-trip key management
- Operator auth signature (EIP-191) produced and verified

To try the full agent flow with the live API, open
[trader.rigoblock.com](https://trader.rigoblock.com) and connect your wallet.

---

## How It Works (for agent developers)

Every DeFi operation maps to one HTTP call:

| Operation | HTTP Call |
|-----------|----------|
| Get a price quote | `GET /api/quote?sell=ETH&buy=USDC&amount=1&chain=base` |
| Swap tokens | `POST /api/chat` with message: `"swap 1000 USDT for XAUT on Arbitrum"` |
| Add LP | `POST /api/chat` with message: `"add liquidity to XAUT/USDT pool..."` |
| Open GMX position | `POST /api/chat` with message: `"open a 1x short XAUT/USD..."` |
| Bridge tokens | `POST /api/chat` with message: `"bridge 1000 USDT from Ethereum to Arbitrum"` |
| Get vault info | `POST /api/chat` with message: `"show vault info on Arbitrum"` |

The chat endpoint understands natural language. The agent doesn't need to
construct exact JSON — it describes what it wants in plain English and the
API's LLM backend routes to the right tool.

### x402 Payment

Every request needs an `X-PAYMENT` header. Without it, the API returns `402`.
The x402 protocol handles payment signing — your WDK wallet signs a micropayment
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

The agent composes strategies from API primitives. The system prompt embeds
strategy knowledge; the agent provides the reasoning. See
[references/STRATEGIES.md](./references/STRATEGIES.md) for detailed templates.

| Strategy | Chain(s) | What | When |
|----------|----------|------|------|
| LP + Permanent Hedge | Ethereum + Arbitrum | XAUT/USDT LP on Uni v4 + 1x GMX short hedge + NAV sync | Always hedged — hedge is never removed |

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
`POST /api/chat`, paying $0.01/call in USDT0. See [AGENTS.md](../AGENTS.md)
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
     account, mnemonic = Account.create_with_mnemonic(num_words=12)
   → WDK-compatible (same BIP-39/BIP-44 derivation as @tetherto/wdk-wallet-evm)
   → Agent stores mnemonic + private key for future sessions

2. Agent outputs its address → operator funds it:
     - USDT0 on Plasma  → x402 API payments ($0.01/call)
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
     rigoblock_chat("swap 100 USDT for XAUT on Ethereum", executionMode="delegated")
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
6. LP on Ethereum (XAUT/USDT Uni v4 pool):
     rigoblock_chat("add liquidity to XAUT/USDT pool",
       vaultAddress=VAULT_ETH, chainId=1)
7. Hedge on Arbitrum (GMX perps):
     rigoblock_chat("open 1x short XAUT/USD with 500 USDT collateral on GMX",
       vaultAddress=VAULT_ARB, chainId=42161)
8. Sync NAV across chains:
     rigoblock_chat("sync NAV", ...)
```

### Architecture (Hackathon Tracks)

This project demonstrates clear separation for both hackathon tracks:

**Track: Agent Wallets**
- Agent creates its own wallet using Tether WDK (`@tetherto/wdk-wallet-evm`)
- Seed encrypted at rest using Tether WDK (`@tetherto/wdk-secret-manager`)
- Same seed phrase works interchangeably in Python via `eth_account`
- Agent signs x402 USDT0 micropayments on Plasma
- Agent signs operator auth (EIP-191) for vault access
- Agent holds and manages USDT + XAUT autonomously via vault

**Track: Autonomous DeFi Agent**
- Agent (Gumloop) decides strategy, timing, and allocation — fully autonomous
- WDK-compatible wallet handles all signing (payments, auth, transactions)
- DeFi execution via Rigoblock API (Uniswap, GMX, Across bridge)
- NAV shield (10% max loss) + slippage protection (1%) for risk management
- Agent bootstraps itself: creates wallet → deploys vaults → delegates → trades

```
┌─────────────────────────────────────────────┐
│  Agent Layer (Gumloop / any framework)      │
│  • Reads STRATEGIES.md for strategy knowledge│
│  • Decides when/what to trade               │
│  • Sequences multi-step operations          │
│  • Monitors positions, rebalances           │
└──────────────────┬──────────────────────────┘
                   │ HTTP calls
┌──────────────────▼──────────────────────────┐
│  Wallet Layer (Tether WDK)                  │
│  • wdk-wallet-evm: BIP-39 seed + signing    │
│  • wdk-secret-manager: seed encryption      │
│  • Signs x402 USDT0 micropayments           │
│  • Signs operator auth (EIP-191)            │
│  • Python: eth_account (same BIP-39 seed)   │
└──────────────────┬──────────────────────────┘
                   │ X-PAYMENT header + auth
┌──────────────────▼──────────────────────────┐
│  Execution Layer (Rigoblock API)            │
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
