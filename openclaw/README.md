# OpenClaw Skill — Rigoblock DeFi Operator

> An [OpenClaw](https://openclaw.ai) skill that gives **any AI agent** safe,
> delegated access to DeFi operations on Rigoblock smart pool vaults.
> Three composable XAUT strategies: carry trade, LP + hedge, and GRG staking.

**Language-agnostic.** The skill is pure knowledge + HTTP API. The agent calls
two endpoints (`GET /api/quote`, `POST /api/chat`) via any HTTP client —
`curl`, `fetch`, `requests`, whatever the agent runtime provides. No Node.js
or TypeScript required. An optional TypeScript SDK is included in `sdk/` for
agents with a JS/TS runtime.

---

## Architecture

```
OpenClaw Agent (reasoning — evaluates markets, selects strategy, sequences calls)
    ↓ reads SKILL.md + references/ (pure knowledge, no code dependency)
    ↓ makes HTTP calls to the API (x402 payment in header)
Rigoblock Agentic Operator API (https://trader.rigoblock.com)
    ↓ NAV guard (10% max loss) + 7-point validation + delegation check
Rigoblock Vault (on-chain: Ethereum + Arbitrum + 5 more chains)
    ↓ DEX spot + Uni v4 LP + GMX perps + Across bridge + GRG staking
```

### What the Skill IS

The skill is a **SKILL.md** file + reference docs. OpenClaw loads SKILL.md
into the agent's context. The agent reads it and gains:

1. **Knowledge** — what DeFi strategies exist, when to enter/exit, risk factors
2. **Primitives** — the HTTP API (two endpoints) and what natural-language
   messages to send for each operation
3. **Safety rules** — what the NAV guard does, what's fail-closed, what to watch for

The agent then **reasons autonomously** — it picks strategies, sequences API
calls, monitors positions, and decides when to rebalance. We don't encode
rigid step-by-step scripts. The agent owns the plan.

### What the Skill is NOT

- Not a Node.js/Python library (the agent calls HTTP directly)
- Not a rigid orchestration engine (the agent decides the sequence)
- Not tied to any programming language or runtime

### Directory Structure

```
openclaw/                       ← This is the skill
├── SKILL.md                    ← The skill manifest — loaded by OpenClaw
├── README.md                   ← You're reading this (human docs)
├── staking-strategy.md         ← GRG staking optimization model
├── references/
│   ├── API.md                  ← HTTP API spec with request/response examples
│   ├── CHAINS.md               ← Chain-specific tokens, addresses, capabilities
│   ├── STRATEGIES.md           ← Strategy entry/exit/monitoring templates
│   └── SAFETY.md               ← NAV guard + delegation security model
└── sdk/                        ← OPTIONAL TypeScript SDK (not required)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts            ← Entry point
        ├── client.ts           ← x402 HTTP client wrapper
        ├── tools.ts            ← Typed tool functions
        ├── strategies.ts       ← Strategy orchestration helpers
        ├── staking.ts          ← Staking simulation engine
        └── types.ts            ← Type definitions
```

---

## Installation

### Step 1: Copy or symlink into OpenClaw skills

```bash
# Option A: symlink (development — hot reload on SKILL.md changes)
ln -s /path/to/agentic-operator/openclaw ~/.openclaw/skills/rigoblock-defi

# Option B: copy (production)
cp -r /path/to/agentic-operator/openclaw ~/.openclaw/skills/rigoblock-defi
```

OpenClaw discovers the skill via `~/.openclaw/skills/rigoblock-defi/SKILL.md`.

### Step 2: Configure environment variables

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "skills": {
    "entries": {
      "rigoblock-defi": {
        "enabled": true,
        "env": {
          "RIGOBLOCK_VAULT_ADDRESS": "0xYourVault",
          "RIGOBLOCK_CHAIN_ID": "8453",
          "SEED_PHRASE": "your twelve word seed phrase ..."
        }
      }
    }
  }
}
```

| Variable | Required | Description |
|----------|----------|-------------|
| `RIGOBLOCK_VAULT_ADDRESS` | Yes | Your Rigoblock vault contract address |
| `RIGOBLOCK_CHAIN_ID` | No | Default chain (8453 = Base). Overridable per call. |
| `SEED_PHRASE` | Yes | WDK seed phrase for x402 payments + operator auth |

### Step 3: Fund the WDK wallet

The seed phrase derives a WDK wallet. Fund it with:
- **USDT0** on Plasma (for x402 payments to the API)
- Or **USDC** on Base (legacy x402 payment)

### Step 4: Set up vault delegation (for delegated execution)

If you want the API to execute trades on your behalf (not just return unsigned
transaction data), delegate your vault to the agent wallet. Ask the agent:
*"setup delegation for my vault"* — it will guide you through it.

### That's it

Ask OpenClaw: *"Use the rigoblock-defi skill to set up an XAUT carry trade
on Arbitrum"* — the agent reads SKILL.md, calls the API, and executes. No
additional installation, no `npm install`, no compilation needed.

---

## How It Works (for agent developers)

The skill is deliberately simple. Every DeFi operation maps to one HTTP call:

| Operation | HTTP Call |
|-----------|----------|
| Get a price quote | `GET /api/quote?sell=ETH&buy=USDC&amount=1&chain=base` |
| Swap tokens | `POST /api/chat` with message: `"swap 1000 USDT for XAUT on Arbitrum"` |
| Add LP | `POST /api/chat` with message: `"add liquidity to XAUT/USDT pool..."` |
| Open GMX position | `POST /api/chat` with message: `"open a 1x short XAUT/USD..."` |
| Bridge tokens | `POST /api/chat` with message: `"bridge 1000 USDT from Ethereum to Arbitrum"` |
| Stake GRG | `POST /api/chat` with message: `"stake 5000 GRG"` |
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

The agent composes strategies from API primitives. SKILL.md provides the
knowledge; the agent provides the reasoning. See
[references/STRATEGIES.md](./references/STRATEGIES.md) for detailed templates.

| Strategy | Chain(s) | What | When |
|----------|----------|------|------|
| Carry Trade | Arbitrum | Buy XAUT spot + short XAUT/USD on GMX | Funding rate positive |
| LP + Hedge | Ethereum + Arbitrum | XAUT/USDT LP + GMX short hedge | LP fees > hedge cost |
| GRG Staking | Ethereum | Optimized GRG stake allocation | Positive risk-adj yield |
| Compositor | All | Score and combine strategies | Always evaluate all three |

---

## Safety Guarantees

Every transaction passes five checks before broadcast:

1. **Operator auth** — EIP-191 signature proving vault ownership
2. **Delegation** — vault must delegate to agent wallet for the function selector
3. **7-point validation** — config, target, selector whitelist, agent ID,
   simulation, balance, gas caps
4. **NAV guard** — blocks if vault unit price drops >10%. **Fail-closed**.
5. **Slippage** — 1% default tolerance on all swaps

See [references/SAFETY.md](./references/SAFETY.md) for the full model.

---

## Supported Chains

| Chain | ID | Swap | LP | Perps | Bridge | Staking |
|-------|----|------|----|-------|--------|---------|
| Ethereum | 1 | Uniswap, 0x | Uni v4 | — | Across | GRG |
| Base | 8453 | Uniswap, 0x | Uni v4 | — | Across | — |
| Arbitrum | 42161 | Uniswap, 0x | Uni v4 | GMX V2 | Across | — |
| Optimism | 10 | Uniswap, 0x | Uni v4 | — | Across | — |
| Polygon | 137 | Uniswap, 0x | — | — | Across | — |
| BNB Chain | 56 | Uniswap, 0x | — | — | Across | — |
| Unichain | 130 | Uniswap | Uni v4 | — | — | — |

---

## Do I Need to Publish This?

**No.** OpenClaw skills are local directories with a SKILL.md file. There's no
mandatory registry or package manager. For the hackathon, the skill lives in
this repo. Optionally it can be published to:

- **ClawHub** (`clawhub.com`) — OpenClaw's public skills registry
- **npm** (`@rigoblock/openclaw-defi`) — for the TypeScript SDK only
- **GitHub** — the skill is already in this repo

---

## Development

```bash
# Run the Worker locally
cd /path/to/agentic-operator
npm run dev

# Build the optional SDK
cd openclaw/sdk && npm install && npm run build

# Symlink for OpenClaw development
ln -s $(pwd)/openclaw ~/.openclaw/skills/rigoblock-defi
```
