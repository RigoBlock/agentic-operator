# OpenClaw Skill — Galactica Trader

> An [OpenClaw](https://openclaw.ai) skill that gives **any AI agent** safe,
> delegated access to DeFi operations on Rigoblock smart pool vaults.
> Uses Tether WDK for wallet creation, signing, and x402 USDT0 payments.
> Primary strategy: XAUT/USDT LP on Ethereum with impermanent loss hedge
> via GMX perps on Arbitrum, plus cross-chain NAV sync.

**Built on Tether WDK.** The agent creates and manages its own wallet using
three Tether technologies:
- **`@tetherto/wdk-wallet-evm`** — BIP-39 seed generation, BIP-44 key derivation, transaction signing
- **`@tetherto/wdk-secret-manager`** — seed encryption at rest (PBKDF2 + XSalsa20-Poly1305)
- **USDT0** — x402 micropayments on Plasma for API access

The same seed phrase works interchangeably in Python via `eth_account`. The
wallet pays for API access with USDT0 on Plasma via x402 and signs operator
auth for delegated execution.

**Language-agnostic.** The skill is pure knowledge + HTTP API. The agent calls
two endpoints (`GET /api/quote`, `POST /api/chat`) via any HTTP client —
`curl`, `fetch`, `requests`, whatever the agent runtime provides. A TypeScript
SDK with WDK wallet integration is included in `sdk/`.

---

## Architecture

```
OpenClaw Agent (reasoning — evaluates markets, selects strategy, sequences calls)
    ↓ reads SKILL.md + references/ (pure knowledge, no code dependency)
    ↓ Tether WDK creates wallet, encrypts seed, signs transactions
    ↓ USDT0 x402 micropayments on Plasma ($0.01/call)
Rigoblock Agentic Operator API (https://trader.rigoblock.com)
    ↓ NAV shield (10% max loss) + 7-point validation + delegation check
Rigoblock Vault (on-chain: Ethereum + Arbitrum + 5 more chains)
    ↓ DEX spot + Uni v4 LP + GMX perps + Across bridge
```

### What the Skill IS

The skill is a **SKILL.md** file + reference docs. OpenClaw loads SKILL.md
into the agent's context. The agent reads it and gains:

1. **Knowledge** — what DeFi strategies exist, when to enter/exit, risk factors
2. **Primitives** — the HTTP API (two endpoints) and what natural-language
   messages to send for each operation
3. **Safety rules** — what the NAV shield does, what's fail-closed, what to watch for

The agent then **reasons autonomously** — it picks strategies, sequences API
calls, monitors positions, and decides when to rebalance. We don't encode
rigid step-by-step scripts. The agent owns the plan.

### What the Skill is NOT

- Not a Node.js/Python library (the agent calls HTTP directly)
- Not a rigid orchestration engine (the agent decides the sequence)
- Not tied to any programming language or runtime

### Directory Structure

```
agentic-operator/
├── galactica-trader/           ← The skill (this folder — publishable to ClawHub)
│   ├── SKILL.md                ← Skill manifest — loaded by OpenClaw
│   ├── README.md               ← You're reading this
│   ├── install.sh              ← One-command local install
│   └── references/
│       ├── API.md              ← HTTP API spec with request/response examples
│       ├── CHAINS.md           ← Chain-specific tokens, addresses, capabilities
│       ├── STRATEGIES.md       ← Strategy entry/exit/monitoring templates
│       └── SAFETY.md           ← NAV shield + delegation security model
└── sdk/                        ← Optional TypeScript SDK (separate from skill)
    ├── package.json            ← Deps: wdk-wallet-evm, wdk-secret-manager, viem
    ├── patches/
    │   └── patch-bare-crypto.cjs  ← Postinstall: makes wdk-secret-manager work in Node.js
    ├── test/
    │   └── test-secure-wallet.ts   ← E2E test: create → encrypt → unlock → sign
    └── src/
        ├── wallet.ts           ← WDK wallet: SecureWalletSession, encryption, x402
        ├── client.ts           ← x402 HTTP client wrapper
        └── ...                 ← tools, strategies, types
```

The skill folder (`galactica-trader/`) is what gets published to ClawHub and
loaded by OpenClaw. The `sdk/` folder is a separate developer tool — not
required for the skill to work.

---

## Installation

### From ClawHub (recommended)

```bash
clawhub install galactica-trader
```

This installs the skill (SKILL.md + references/) into your workspace's
`skills/` folder. The skill works immediately — the agent calls
`trader.rigoblock.com` over HTTP, no local npm dependencies needed.

### From source (includes TypeScript SDK)

```bash
cd galactica-trader && ./install.sh
```

This symlinks the skill into `~/.openclaw/skills/galactica-trader/`, AND
installs the optional TypeScript SDK with WDK wallet integration (npm deps
+ bare-crypto patch + E2E test). The SDK is for developers who want
programmatic wallet creation — the skill itself works without it.

### Manual install

#### Step 1: Copy or symlink into OpenClaw skills

```bash
# Option A: symlink (development — hot reload on SKILL.md changes)
ln -s /path/to/agentic-operator/galactica-trader ~/.openclaw/skills/galactica-trader

# Option B: copy (production)
cp -r /path/to/agentic-operator/galactica-trader ~/.openclaw/skills/galactica-trader
```

OpenClaw discovers the skill via `~/.openclaw/skills/galactica-trader/SKILL.md`.

### Step 2: Configure environment variables (optional)

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "skills": {
    "entries": {
      "galactica-trader": {
        "enabled": true,
        "env": {
          "RIGOBLOCK_VAULT_ADDRESS": "0xVaultAddress"
        }
      }
    }
  }
}
```

| Variable | Required | Description |
|----------|----------|-------------|
| `RIGOBLOCK_VAULT_ADDRESS` | No | A Rigoblock vault contract address on any supported chain. If not set, the agent deploys a new vault autonomously (see SKILL.md bootstrap flow). For multi-chain, the agent tracks per-chain vault addresses itself. |
| `SEED_PHRASE` | No | Existing WDK seed phrase. If not set, a new WDK wallet is created on first run. |

The agent specifies `chainId` per API request — the system is multi-chain
by design (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Unichain).
No default chain configuration is needed.

### Step 3: Fund the WDK wallet

If you provided a `SEED_PHRASE`, WDK derives the wallet. If not, the SDK
creates a new wallet and shows the seed phrase ONCE — save it securely.
Fund the wallet with:
- **USDT0** on Plasma (for x402 payments to the API — recommended)
- Or **USDC** on Base (legacy x402 payment)

The wallet address is also the vault operator. It signs auth messages and
can delegate to the agent system.

> **Note:** Delegation setup requires an on-chain transaction on the vault's
> chain, so the operator wallet also needs a small amount of ETH for gas on
> that chain (e.g. ETH on Arbitrum).

### Step 4: Set up vault delegation (for delegated execution)

If you want the API to execute trades on your behalf (not just return unsigned
transaction data), delegate your vault to the agent wallet. Ask the agent:
*"setup delegation for my vault"* — it will guide you through it.

### That's it

Ask OpenClaw: *"Use the galactica-trader skill to set up the XAUT/USDT LP + hedge strategy"*
— the agent reads SKILL.md, calls the API, and executes. No
additional compilation needed.

---

## Quick Start for Judges

```bash
# 1. Clone and install
git clone https://github.com/RigoBlock/agentic-operator
cd agentic-operator/galactica-trader
./install.sh    # symlinks skill + installs SDK (sibling folder) + runs WDK E2E test
```

The install script runs the full Tether WDK integration test automatically:
- **`@tetherto/wdk-wallet-evm`** generates a BIP-39 seed and derives an EVM account
- **`@tetherto/wdk-secret-manager`** encrypts the seed with a passkey (PBKDF2 + XSalsa20-Poly1305)
- Encrypted store saved to disk, reloaded, and decrypted — proving round-trip key management
- Operator auth signature (EIP-191) produced and verified

Then open OpenClaw and ask:
```
Use the galactica-trader skill to show vault info on Arbitrum
```

To try the full agent flow with the live API, fund the wallet address with
USDT0 on Plasma and follow the bootstrap steps in SKILL.md.

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

## Web Chat — Zero-Install Alternative

The same API powers a **web chat** at
[trader.rigoblock.com](https://trader.rigoblock.com) with additional
UX benefits over a local OpenClaw installation:

| Feature | OpenClaw (local) | Web Chat |
|---------|------------------|----------|
| Installation | Requires OpenClaw + skill setup | None — open in browser |
| Wallet setup | Generate or import seed | Sign with MetaMask/WalletConnect |
| Agent uptime | Must keep terminal open | Always on (Cloudflare Workers) |
| Strategy alerts | Poll manually | Telegram notifications + confirmations |
| x402 payment | Agent wallet pays per call | Built-in — no separate wallet needed |

**For hackathon evaluators:** The web chat is the fastest way to see the full
system in action without installing anything. Visit
[trader.rigoblock.com](https://trader.rigoblock.com) and connect your wallet.

---

## Gumloop Integration (Python Agent)

For agents running in **Gumloop** or any Python sandbox — fully autonomous,
no manual setup, no Node.js needed.

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
│  Agent Layer (Gumloop / OpenClaw)           │
│  • Reads SKILL.md for strategy knowledge    │
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

## Publishing to ClawHub

From the repo root:

```bash
cd galactica-trader
clawhub publish . --slug galactica-trader --name "Galactica Trader" --version 1.0.0
```

Then anyone can install with:

```bash
clawhub install galactica-trader
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

# Symlink skill for OpenClaw development
ln -s $(pwd)/galactica-trader ~/.openclaw/skills/galactica-trader
```
