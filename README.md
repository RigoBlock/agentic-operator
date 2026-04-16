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
                                  │  ├── Workers AI (default LLM) + Tools │             │
                                  │  │   ├── get_swap_quote    │             │
                                  │  │   ├── build_vault_swap  │             │
                                  │  │   ├── get_positions     │             │
                                  │  │   └── … (55+ tools)     │             │
                                  │  ├── 0x Aggregator (default)│             │
                                  │  ├── Uniswap Trading API   │───execute()─►│
                                  │  ├── GMX V2 (Arbitrum)     │             │
                                  │  ├── NAV Shield (10% max)  │             │
                                  │  └── Agent Wallet (CDP)    │             │
                                  └───────────────────────────┘
```

## How It Works

### Two Execution Modes

**Manual mode** — The agent builds unsigned transaction calldata. The operator signs and broadcasts from their wallet (browser or any external agent).

**Delegated mode** — The vault owner sets up on-chain delegation to a CDP-managed agent wallet. The agent executes trades directly, gated by a 7-point validation and NAV shield.

### Delegation Flow

1. Operator connects wallet at `trader.rigoblock.com` and signs EIP-191 auth
2. Operator activates delegation per-chain — grants the agent wallet permission to call specific vault functions (`execute()`, `modifyLiquidities()`)
3. Agent wallet is generated per-vault using **CDP Server Wallet** (Coinbase Developer Platform) — keys are generated and stored by CDP in a TEE, never exist in our code or KV
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

1. **Connect a wallet** — Open [trader.rigoblock.com](https://trader.rigoblock.com) and connect an existing wallet (MetaMask / WalletConnect).

2. **Fund your wallet with native currency** — Send a small amount of the chain's native token to cover gas.

3. **Create a Rigoblock smart pool** — Ask the agent to help you deploy one. You only need to provide a name, symbol, and base token. Example: _"Create a smart pool called MyFund with symbol MF using USDT as the base token on Arbitrum."_

4. **Mint smart pool tokens** — Fund the pool by minting tokens from your wallet against the base token balance. Example: _"Mint 1000 pool tokens by depositing 100 USDT into my vault."_ The agent will build and return the transaction for you to sign.

5. **Get an agent wallet** — Ask the agent: _"get yourself an agentic wallet"_. This provisions a dedicated CDP Server Wallet EOA for your vault — keys are stored in a hardware enclave by Coinbase and never leave CDP's infrastructure.

6. **Configure delegation** — In the app settings, enable delegation on each chain where you want the agent to act. Delegation is **per-chain** — enabling it on BSC does not enable it on Arbitrum. You choose which vault functions to delegate (e.g. swaps, LP, staking).

7. **Start operating** — The agent is now ready. Ask it to trade, provide liquidity, stake, bridge, or analyse your positions. By default the agent **asks for your confirmation** before executing any transaction.

8. **Optional — automated strategies** — You can create cron-based strategies (minimum 5-minute intervals) that run automatically. Strategies are **autonomous by default** (the agent executes immediately and notifies you via Telegram afterwards). You can set `autoExecute=false` per strategy if you want Telegram confirmation before each execution. All safety layers (NAV shield, delegation checks, selector whitelist) always apply.

> **Gas sponsorship note:** Agent wallets use Alchemy EIP-7702 gas sponsorship by default. You do not need to fund the agent wallet with ETH. If sponsorship is not configured for your deployment, the agent wallet address shown in the delegation setup screen will need a small ETH balance for gas.

---

## Supported Chains

| Chain | ID | DEX Sources |
|-------|----|-------------|
| Ethereum | 1 | 0x, Uniswap V2/V3/V4 |
| Base | 8453 | 0x, Uniswap V2/V3/V4 |
| Arbitrum | 42161 | 0x, Uniswap V2/V3/V4, GMX V2 |
| Optimism | 10 | 0x, Uniswap V2/V3/V4 |
| Polygon | 137 | 0x, Uniswap V2/V3/V4 |
| BNB Chain | 56 | 0x, Uniswap V2/V3/V4 |
| Unichain | 130 | Uniswap V2/V3/V4 |

## DEX Integrations

### 0x Aggregator (Default)

Uses the [0x Swap API v2](https://0x.org) as the default DEX — aggregates 150+ liquidity sources for best price across all supported chains.

### Uniswap

Two-step flow via the [Uniswap Trading API](https://trade-api.gateway.uniswap.org/v1):

1. **Quote**: `POST /quote` — returns pricing with routing across V2, V3, and V4 pools
2. **Swap**: `POST /swap` — returns Universal Router v2 calldata

Features:
- Routing types: CLASSIC, DUTCH_V2, PRIORITY, WRAP/UNWRAP, CHAINED
- Both exact-input and exact-output supported
- Native ETH pools (V4-native, distinct from WETH)
- Uses `x-universal-router-version: 2.0` header

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
│   ├── client.ts            # LLM provider routing + tool execution loop
│   └── tools.ts             # Tool definitions (55+) + system prompt
├── middleware/
│   └── x402.ts              # x402 payment gate + settlement
├── routes/
│   ├── chat.ts              # POST /api/chat (auth + execution mode)
│   ├── quote.ts             # GET  /api/quote (stateless pricing)
│   ├── delegation.ts        # Delegation management + execute
│   ├── gasPolicy.ts         # Gas sponsorship policy (Alchemy)
│   └── telegram.ts          # Telegram bot webhook + commands
└── services/
    ├── agentWallet.ts       # CDP Server Wallet (per-vault agent EOA via Coinbase)
    ├── auth.ts              # EIP-191 signature + vault ownership
    ├── bundler.ts           # ERC-4337 bundler (gas sponsorship)
    ├── crosschain.ts        # Cross-chain bridging
    ├── delegation.ts        # Delegation state (KV-backed)
    ├── execution.ts         # 7-point validation + NAV shield + broadcast
    ├── gmxTrading.ts        # GMX V2 perpetuals
    ├── gmxPositions.ts      # GMX position queries
    ├── navGuard.ts          # NAV shield simulation (10% threshold)
    ├── strategy.ts          # Cron strategies (autonomous by default)
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
| `GET` | `/api/health` | — | Health check + x402 pricing |
| `GET` | `/api/strategy-events` | — | Strategy run events (web polling) |
| `POST` | `/api/delegation/setup` | operator auth | Initialize delegation + provision CDP wallet |
| `GET` | `/api/delegation/status` | — | Delegation status |
| `POST` | `/api/delegation/execute` | operator auth | Execute via agent wallet |
| `GET` | `/api/gas-policy` | webhook | Gas sponsorship policy (Alchemy) |
| `POST` | `/api/telegram/webhook` | webhook secret | Telegram updates |
| `POST` | `/api/telegram/pair` | — | Generate Telegram pairing code |
| `POST` | `/api/telegram/setup` | — | Register Telegram webhook |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account
- [Uniswap API key](https://developers.uniswap.org)
- [Alchemy API key](https://www.alchemy.com/)
- [CDP API credentials](https://portal.cdp.coinbase.com/) — for agent wallet generation

### Install & Run

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # → http://localhost:8787
```

### Secrets (production)

```bash
npx wrangler secret put UNISWAP_API_KEY
npx wrangler secret put ALCHEMY_API_KEY
npx wrangler secret put ZEROX_API_KEY             # optional
npx wrangler secret put ALCHEMY_GAS_POLICY_ID     # optional, for gas sponsorship
npx wrangler secret put TELEGRAM_BOT_TOKEN        # optional, for Telegram bot
npx wrangler secret put CDP_API_KEY_ID            # CDP Server Wallet
npx wrangler secret put CDP_API_KEY_SECRET        # CDP Server Wallet
npx wrangler secret put CDP_WALLET_SECRET         # CDP Server Wallet signing
```

> **Note:** `OPENAI_API_KEY` is optional — the default LLM is Workers AI (Llama 4 Scout / DeepSeek R1). Set `aiApiKey` + `aiModel` per-request to use OpenAI, Anthropic, or any OpenAI-compatible provider.

### Deploy

```bash
npm run deploy
```

## Known Limitations

> **Alpha software — use with caution.** This project is in early development. The following limitations are known and will be addressed in future releases.

### AI / LLM Behaviour
- **The agent can hallucinate.** Like any LLM-based system, the agent may produce incorrect token addresses, amounts, or transaction descriptions.
- **Different AI models give different results.** The default model is Workers AI (Llama 4 Scout fast path, DeepSeek R1 for reasoning). Switching to GPT-4, Claude Sonnet, or other models via `aiApiKey` / `aiModel` in the API request will change the agent's behaviour, tool-calling accuracy, and output quality.
- **No multi-step orchestration in a single message.** The `/api/chat` endpoint handles one atomic operation per request. Complex strategies (bridge + swap + LP) require separate messages or an orchestrator agent on your side.

### Execution & Safety
- **Autonomous strategies are experimental.** Autonomous mode executes trades without manual confirmation. The on-chain safety layers (NAV shield, selector whitelist) still apply, but strategy logic is LLM-generated and may misfire on unusual market conditions. Monitor your first few autonomous runs.
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
