# Agentic Operator — Rigoblock Vault Trading Agent

A Cloudflare Worker that lets Rigoblock vault (smart pool) operators execute token swaps through a conversational AI agent. The agent uses a Coinbase CDP wallet with **EIP-7702 privilege de-escalation** for secure, scoped delegation — **no Rigoblock protocol modifications required**.

## Architecture

```
Pool Operator (Browser + Wallet)
  └─► Chat UI  ──►  Cloudflare Worker
                       ├─► LLM (GPT-4o) — intent parsing + tool calling
                       ├─► CDP SDK     — agent wallet + swap pricing
                       └─► EIP-7702   — scoped delegation
                             └─► Operator EOA (vault owner)
                                   └─► Rigoblock Vault.execute()
```

## How Delegation Works (EIP-7702)

The operator stays in full control of their EOA at all times. EIP-7702 enables
"privilege de-escalation": the operator signs a type-4 authorization that
temporarily sets delegation contract code on their EOA, granting the agent
scoped permission to call specific vault functions.

1. **Operator connects wallet** in the chat UI (MetaMask, Rabby, Coinbase Wallet)
2. **Operator signs EIP-712 authorization** scoped to:
   - Target: vault address only
   - Selectors: `execute()` and `modifyLiquidities()` only
   - Time window: operator-defined expiry (e.g. 24 hours)
3. **Agent executes trades** by calling the vault's IAUniswapRouter interface
4. **Operator can revoke** at any time, or simply let the authorization expire

The vault uses the **IAUniswapRouter** interface (identical to Uniswap's Universal Router):
- `execute(bytes commands, bytes[] inputs, uint256 deadline)`
- `execute(bytes commands, bytes[] inputs)`
- `modifyLiquidities(bytes unlockData, uint256 deadline)`

## Project Structure

```
src/
├── index.ts                 # Worker entry (Hono app)
├── types.ts                 # Shared TypeScript types
├── config.ts                # Chain config, token maps
├── abi/
│   ├── rigoblockVault.ts    # Vault ABI (IAUniswapRouter interface)
│   └── erc20.ts             # ERC-20 ABI
├── llm/
│   ├── client.ts            # OpenAI chat + tool execution loop
│   └── tools.ts             # Tool definitions + system prompt
├── routes/
│   ├── chat.ts              # POST /api/chat
│   ├── wallet.ts            # GET  /api/wallet
│   └── delegation.ts        # EIP-7702 delegation endpoints
└── services/
    ├── agentWallet.ts        # CDP SDK wallet (CdpClient)
    ├── vault.ts              # Vault reads + calldata encoding
    ├── quotes.ts             # Swap price formatting
    └── delegation.ts         # EIP-7702 delegation management
public/
└── index.html               # Chat UI with wallet connect
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Chat UI |
| `POST` | `/api/chat` | Send messages, get agent response |
| `GET`  | `/api/wallet` | Agent wallet address + network |
| `GET`  | `/api/health` | Health check |
| `GET`  | `/api/delegation/setup` | Authorization payload for operator to sign |
| `GET`  | `/api/delegation/status` | Current delegation status |
| `POST` | `/api/delegation/register` | Register signed EIP-7702 authorization |
| `POST` | `/api/delegation/revoke` | Revoke delegation |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included as dev dep)
- Cloudflare account
- OpenAI API key
- [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) API key (API key ID, secret, wallet secret)

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .dev.vars.example .dev.vars
# Fill in your API keys in .dev.vars
```

### 3. Create KV Namespace

```bash
npx wrangler kv namespace create KV
# Copy the id into wrangler.toml [[kv_namespaces]]
```

### 4. Set Secrets (for production)

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
npx wrangler secret put CDP_WALLET_SECRET
```

### 5. Configure Vault

Set `VAULT_ADDRESS` in `wrangler.toml` to your Rigoblock vault address.

### 6. Run Locally

```bash
npm run dev
# → http://localhost:8787
```

### 7. Deploy

```bash
npm run deploy
```

## Delegation Setup (by Pool Operator)

1. Open the chat UI and click **Connect Wallet**
2. Click **Delegation** → set duration → **Sign & Activate**
3. Sign the EIP-712 authorization in your wallet
4. The agent can now execute scoped trades on your vault
5. To revoke: click **Revoke** or let the authorization expire

## Development

```bash
# Type check
npm run build

# Local dev server
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## License

MIT
