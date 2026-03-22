# Agentic Operator — Rigoblock Vault Trading Agent

A Cloudflare Worker that gives AI agents and human operators safe access to DeFi trading on [Rigoblock](https://rigoblock.com) smart pool vaults. Deployed at `trader.rigoblock.com`.

Three access interfaces: **Web chat**, **Telegram bot**, and **x402-gated API** for external AI agents.

**Built-in self-custodial wallet** with encrypted keystore (PBKDF2 + AES-256-GCM) and EIP-7702 gas sponsorship — users can trade without MetaMask or ETH for gas.

## Architecture

```
Interfaces                        Cloudflare Worker                       On-Chain
───────────                       ─────────────────                       ────────
Browser (Chat UI)  ──┐
Telegram Bot      ───┤            ┌───────────────────────────┐
                     ├──►  POST   │  Hono App                 │          Rigoblock Vault
External AI Agent ───┘   /api/… │  ├── x402 Payment Gate     │           (Smart Pool)
  (x402 payer)                    │  ├── Operator Auth (EIP-191)│             │
                                  │  ├── Workers AI (default LLM) + Tools │             │
                                  │  │   ├── get_swap_quote    │             │
                                  │  │   ├── build_vault_swap  │             │
                                  │  │   ├── get_positions     │             │
                                  │  │   └── … (15+ tools)     │             │
                                  │  ├── Uniswap Trading API   │───execute()─►│
                                  │  ├── 0x Aggregator         │             │
                                  │  ├── GMX V2 (Arbitrum)     │             │
                                  │  ├── NAV Shield (10% max)  │             │
                                  │  └── Agent Wallet (AES-256)│             │
                                  └───────────────────────────┘
```

## How It Works

### Two Execution Modes

**Manual mode** — The agent builds unsigned transaction calldata. The operator signs and broadcasts from their wallet (browser or any external agent).

**Delegated mode** — The vault owner sets up on-chain delegation to an encrypted agent wallet. The agent executes trades directly, gated by a 7-point validation and NAV shield.

### Self-Custodial Wallet (Built-in)

The web UI includes a zero-dependency encrypted wallet:

1. User chooses a password → server generates BIP-39 seed via Tether WDK
2. Seed is encrypted with PBKDF2-SHA256 (310k iterations) + AES-256-GCM
3. Encrypted keystore stored in browser localStorage — server never stores seed or password
4. User enters password to unlock → browser decrypts → signs transactions locally
5. Import flow uses client-side Web Crypto — imported seed phrases never touch the server
6. Transactions gas-sponsored via EIP-7702 (Alchemy) — no ETH needed

This enables judges, evaluators, and new users to start trading immediately with zero on-chain setup.

### Delegation Flow

1. Operator connects wallet at `trader.rigoblock.com` and signs EIP-191 auth
2. Operator activates delegation per-chain — grants the agent wallet permission to call specific vault functions (`execute()`, `modifyLiquidities()`)
3. Agent wallet is generated per-vault using Tether WDK (`@tetherto/wdk-wallet-evm`) — BIP-39 seed phrase, BIP-44 HD derivation, encrypted with AES-256-GCM (key derived via HKDF from `AGENT_WALLET_SECRET`)
4. On each trade: 7-point validation → NAV shield simulation → broadcast
5. Operator can revoke delegation at any time via `revokeAllDelegations()`

### Safety Guarantees

- **NAV Shield**: Simulates every trade's impact on vault Net Asset Value. Blocks any trade that would drop NAV > 10% vs the higher of pre-swap NAV or 24-hour baseline
- **Selector whitelist**: Only `execute()` and `modifyLiquidities()` — no `withdraw`, no `transferOwnership`
- **Target validation**: Transactions can only target the vault address itself
- **Gas caps**: Per-chain hard limits on gas spending
- **Slippage protection**: Default 1% (100 bps), enforced in swap calldata

## Getting Started — User Journey

The typical flow for a new operator using the web interface:

1. **Connect or create a wallet** — Open [trader.rigoblock.com](https://trader.rigoblock.com) and either create a built-in WDK wallet directly in the browser or connect an existing wallet (MetaMask / WalletConnect). No seed phrase is stored on the server; the encrypted keystore lives in your browser's localStorage.

2. **Fund your wallet with native currency** — If you are using a wallet without AA, send a small amount of the chain's native token to cover gas.

3. **Create a Rigoblock smart pool** — Ask the agent to help you deploy one. You only need to provide a name, symbol, and base token. Example: _"Create a smart pool called MyFund with symbol MF using USDT as the base token on Arbitrum."_

4. **Mint smart pool tokens** — Fund the pool by minting tokens from your wallet (or any wallet) against the base token balance. Example: _"Mint 1000 pool tokens by depositing 100 USDT into my vault."_ The agent will build and return the transaction for you to sign.

5. **Get an agent wallet** — Ask the agent: _"get yourself an agentic wallet"_ This generates a dedicated encrypted EOA for your vault that the system uses to execute delegated trades.

6. **Configure delegation** — In the app settings, enable delegation on each chain where you want the agent to act. Delegation is **per-chain** — enabling it on Bsc does not enable it on Arbitrum. You choose which vault functions to delegate (e.g. swaps, LP, staking).

7. **Start operating** — The agent is now ready. Ask it to trade, provide liquidity, stake, bridge, or analyse your positions. By default the agent **asks for your confirmation** before executing any transaction.

8. **Optional — automated strategies** — You can create cron-based strategies (minimum 5-minute intervals) that run automatically. By default these are **manual** (the agent sends a Telegram message and waits for your approval). You can explicitly opt into **autonomous mode** per strategy, which lets the agent execute immediately — all safety layers (NAV shield, delegation checks, selector whitelist) still apply.

> **Gas sponsorship note:** The default agent wallet uses Alchemy EIP-7702 gas sponsorship. You do not need to fund the agent wallet with ETH. If sponsorship is not configured for your deployment, the agent wallet address shown in the delegation setup screen will need a small ETH balance for gas.

---

## Supported Chains

| Chain | ID | DEX Sources |
|-------|----|-------------|
| Ethereum | 1 | Uniswap V2/V3/V4, 0x |
| Base | 8453 | Uniswap V2/V3/V4, 0x |
| Arbitrum | 42161 | Uniswap V2/V3/V4, 0x, GMX V2 |
| Optimism | 10 | Uniswap V2/V3/V4, 0x |
| Polygon | 137 | Uniswap V2/V3/V4, 0x |
| BNB Chain | 56 | Uniswap V2/V3/V4, 0x |
| Unichain | 130 | Uniswap V2/V3/V4 |

## DEX Integrations

### Uniswap (Primary)

Two-step flow via the [Uniswap Trading API](https://trade-api.gateway.uniswap.org/v1):

1. **Quote**: `POST /quote` — returns pricing with routing across V2, V3, and V4 pools
2. **Swap**: `POST /swap` — returns Universal Router v2 calldata

Features:
- Routing types: CLASSIC, DUTCH_V2, PRIORITY, WRAP/UNWRAP, CHAINED
- Both exact-input and exact-output supported
- Native ETH pools (V4-native, distinct from WETH)
- Vault adapter adds ~200k gas overhead for execute() wrapping
- Uses `x-universal-router-version: 2.0` header

### 0x Aggregator (Alternative)

Uses the [0x Swap API v2](https://0x.org) for additional liquidity sources and cross-DEX aggregation.

### GMX V2 (Perpetuals)

Arbitrum-only perpetual futures via GMX V2. Supports opening/closing long/short positions with leverage.

## x402 Payment Protocol

External AI agents pay for API access via [x402](https://x402.org) — USDC micropayments on Base (chain 8453).

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| `/api/quote` | GET | $0.002 | DEX price quote (no vault context) |
| `/api/chat` | POST | $0.01 | AI-powered DeFi response |

Browser and Telegram requests are exempt from x402 (same-origin / webhook).

See [AGENTS.md](AGENTS.md) for the full external agent integration guide.

## Project Structure

```
src/
├── index.ts                 # Worker entry (Hono), cron handler
├── config.ts                # Chain config, gas caps, token maps
├── types.ts                 # Shared TypeScript types
├── abi/                     # Contract ABIs
│   ├── rigoblockVault.ts    #   Vault (IAUniswapRouter interface)
│   ├── erc20.ts             #   ERC-20
│   ├── gmx.ts               #   GMX V2
│   ├── poolFactory.ts       #   RigoblockPoolProxyFactory
│   └── aIntents.ts          #   AIntents adapter
├── llm/
│   ├── client.ts            # OpenAI chat + tool execution loop
│   └── tools.ts             # Tool definitions + system prompt
├── middleware/
│   └── x402.ts              # x402 payment gate + settlement
├── routes/
│   ├── chat.ts              # POST /api/chat (auth + execution mode)
│   ├── quote.ts             # GET  /api/quote (stateless pricing)
│   ├── delegation.ts        # Delegation management + execute
│   ├── gasPolicy.ts         # Gas sponsorship policy (Alchemy)
│   ├── wallet.ts            # Self-custodial wallet (create, prepare-tx, submit-signed)
│   └── telegram.ts          # Telegram bot webhook + commands
└── services/
    ├── agentWallet.ts       # Agent wallet gen (BIP-39/BIP-44) + encrypt (AES-256-GCM)
    ├── userWallet.ts        # User wallet gen + encrypted keystore (PBKDF2+AES-256-GCM)
    ├── auth.ts              # EIP-191 signature + vault ownership
    ├── bundler.ts           # ERC-4337 bundler (gas sponsorship)
    ├── crosschain.ts        # Cross-chain bridging
    ├── delegation.ts        # Delegation state (KV-backed)
    ├── execution.ts         # 7-point validation + NAV shield + broadcast
    ├── gmxTrading.ts        # GMX V2 perpetuals
    ├── gmxPositions.ts      # GMX position queries
    ├── navGuard.ts          # NAV shield simulation (10% threshold)
    ├── strategy.ts          # Cron strategies (manual-only)
    ├── telegram.ts          # Telegram Bot API helpers
    ├── telegramPairing.ts   # Telegram ↔ wallet pairing
    ├── tokenResolver.ts     # Dynamic token address resolution
    ├── uniswapTrading.ts    # Uniswap quote/swap (Trading API v1)
    ├── vault.ts             # On-chain vault reads
    └── zeroXTrading.ts      # 0x aggregator integration
public/
└── index.html               # Chat UI with wallet connect
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | — | Chat UI |
| `POST` | `/api/chat` | x402 or operator auth | LLM chat with tool calling |
| `GET` | `/api/quote` | x402 | DEX price quote |
| `GET` | `/api/vault` | — | Vault info (on-chain read) |
| `GET` | `/api/chains` | — | Supported chains list |
| `GET` | `/api/health` | — | Health check |
| `POST` | `/api/delegation/setup` | operator auth | Initialize delegation |
| `GET` | `/api/delegation/status` | — | Delegation status |
| `POST` | `/api/delegation/execute` | operator auth | Execute via agent wallet |
| `POST` | `/api/wallet/create` | — | Create encrypted WDK wallet |
| `POST` | `/api/wallet/derive-address` | — | Derive address from seed |
| `POST` | `/api/wallet/prepare-tx` | — | Prepare gas-sponsored UserOp (EIP-7702) |
| `POST` | `/api/wallet/submit-signed` | — | Submit client-signed UserOp |
| `POST` | `/api/wallet/rpc` | — | Alchemy RPC proxy (whitelisted methods) |
| `POST` | `/api/telegram/webhook` | webhook secret | Telegram updates |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account
- OpenAI API key
- [Uniswap API key](https://developers.uniswap.org)
- [Alchemy API key](https://www.alchemy.com/)

### Install & Run

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # → http://localhost:8787
```

### Secrets (production)

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put UNISWAP_API_KEY
npx wrangler secret put ALCHEMY_API_KEY
npx wrangler secret put AGENT_WALLET_SECRET      # 32+ char random string
npx wrangler secret put ZEROX_API_KEY             # optional
npx wrangler secret put ALCHEMY_GAS_POLICY_ID     # optional, for gas sponsorship
npx wrangler secret put TELEGRAM_BOT_TOKEN         # optional, for Telegram bot
npx wrangler secret put CDP_API_KEY_ID             # for x402 facilitator
npx wrangler secret put CDP_API_KEY_SECRET         # for x402 facilitator
```

### Deploy

```bash
npm run deploy
```

## Known Limitations

> **Alpha software — use with caution.** This project is in early development. The following limitations are known and will be addressed in future releases.

### AI / LLM Behaviour
- **The agent can hallucinate.** Like any LLM-based system, the agent may produce incorrect token addresses, amounts, or transaction descriptions.
- **Different AI models give different results.** The default model is Meta Llama 4 Scout (Workers AI). Switching to GPT-5, Claude Sonnet, or other models via `aiApiKey` / `aiModel` in the API request will change the agent's behaviour, tool-calling accuracy, and output quality. Some models are more reliable than others for structured DeFi workflows.
- **No multi-step orchestration in a single message.** The `/api/chat` endpoint handles one atomic operation per request. Complex strategies (bridge + swap + LP) require separate messages or an orchestrator agent on your side.

### Execution & Safety
- **Autonomous strategies are experimental.** Autonomous mode executes trades without manual confirmation. The on-chain safety layers (NAV shield, selector whitelist) still apply, but strategy logic is LLM-generated and may misfire on unusual market conditions. Start with manual mode.
- **Delegation is per-chain and per-selector.** Enabling delegation on one chain has no effect on other chains. Each chain requires its own on-chain setup transaction.

---

## Links

- **App**: [trader.rigoblock.com](https://trader.rigoblock.com)
- **Protocol docs**: [docs.rigoblock.com](https://docs.rigoblock.com)
- **Website**: [rigoblock.com](https://rigoblock.com)
- **Agent guide**: [AGENTS.md](AGENTS.md) — x402 integration for external AI agents
- **Security model**: [CLAUDE.md](CLAUDE.md) — mandatory rules for code contributors
- **Blog**: [mirror.xyz/rigoblock.eth](https://mirror.xyz/rigoblock.eth)
- **GitHub**: [github.com/rigoblock](https://github.com/rigoblock)

## License

MIT
