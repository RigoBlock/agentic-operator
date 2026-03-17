# Agentic Operator — Rigoblock Vault Trading Agent

A Cloudflare Worker that gives AI agents and human operators safe access to DeFi trading on [Rigoblock](https://rigoblock.com) smart pool vaults. Deployed at `trader.rigoblock.com`.

Three access interfaces: **Web chat**, **Telegram bot**, and **x402-gated API** for external AI agents.

## Architecture

```
Interfaces                        Cloudflare Worker                       On-Chain
───────────                       ─────────────────                       ────────
Browser (Chat UI)  ──┐
Telegram Bot      ───┤            ┌───────────────────────────┐
                     ├──►  POST   │  Hono App                 │          Rigoblock Vault
External AI Agent ───┘   /api/… │  ├── x402 Payment Gate     │           (Smart Pool)
  (x402 payer)                    │  ├── Operator Auth (EIP-191)│             │
                                  │  ├── LLM (GPT-4o) + Tools │             │
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

### Delegation Flow

1. Operator connects wallet at `trader.rigoblock.com` and signs EIP-191 auth
2. Operator activates delegation per-chain — grants the agent wallet permission to call specific vault functions (`execute()`, `modifyLiquidities()`)
3. Agent wallet is generated per-vault, encrypted with AES-256-GCM (key derived via HKDF from `AGENT_WALLET_SECRET`)
4. On each trade: 7-point validation → NAV shield simulation → broadcast
5. Operator can revoke delegation at any time via `revokeAllDelegations()`

### Safety Guarantees

- **NAV Shield**: Simulates every trade's impact on vault Net Asset Value. Blocks any trade that would drop NAV > 10% vs the higher of pre-swap NAV or 24-hour baseline
- **Selector whitelist**: Only `execute()` and `modifyLiquidities()` — no `withdraw`, no `transferOwnership`
- **Target validation**: Transactions can only target the vault address itself
- **Gas caps**: Per-chain hard limits on gas spending
- **Slippage protection**: Default 1% (100 bps), enforced in swap calldata

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
│   └── telegram.ts          # Telegram bot webhook + commands
└── services/
    ├── agentWallet.ts       # Key gen/encrypt/decrypt (AES-256-GCM)
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
