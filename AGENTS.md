# AGENTS.md — External Agent Integration Guide

> How external AI agents interact with the Rigoblock Agentic Operator via x402.
> This document covers the security model, access tiers, and what agents can
> and cannot do.

---

## Overview

The Rigoblock Agentic Operator exposes two x402-gated endpoints:

| Endpoint | Method | Price | What it returns |
|----------|--------|-------|-----------------|
| `/api/quote` | GET | $0.002 USDC | DEX price quote (no vault context needed) |
| `/api/chat` | POST | $0.01 USDC | AI-powered DeFi response (swap calldata, positions, analysis) |

Payments are in USDC on **Base mainnet** (`eip155:8453`) via the
[x402 protocol](https://x402.org). The CDP facilitator at
`api.cdp.coinbase.com` handles verification and settlement.

---

## Access Tiers

### Tier 1: Anonymous (x402 payment only)

**What:** Agent pays x402 fee. No operator credentials.
**Gets:** Unsigned transaction data, price quotes, DeFi analysis.
**Cannot:** Execute transactions on any vault.

```
GET /api/quote?sell=ETH&buy=USDC&amount=1&chain=base
X-PAYMENT: <x402-payment-header>

→ 200: { sell: "1 ETH", buy: "2079.54 USDC", price: "1 ETH = 2079.54 USDC", ... }
```

```
POST /api/chat
X-PAYMENT: <x402-payment-header>
Content-Type: application/json

{
  "messages": [{"role": "user", "content": "swap 1 ETH for USDC on Base"}],
  "vaultAddress": "0xYourVault",
  "chainId": 8453,
  "aiApiKey": "sk-or-...",
  "aiModel": "anthropic/claude-sonnet-4",
  "aiBaseUrl": "https://openrouter.ai/api/v1"
}

→ 200: {
    "reply": "I'll prepare a swap of 1 ETH → USDC on Base via Uniswap...",
    "transaction": {
      "to": "0xYourVault",
      "data": "0x...",           ← unsigned calldata
      "value": "0x0",
      "chainId": 8453,
      "description": "Swap 1 ETH → 2,079.54 USDC via Uniswap"
    }
  }
```

The agent receives unsigned calldata. To execute it, the agent (or its operator)
must sign and broadcast the transaction themselves. The calling agent's wallet is
**never** used to operate the vault — the vault contract requires the transaction
to come from its owner.

**Use cases:**
- Price discovery across 7 chains
- Natural language → structured DeFi calldata
- Portfolio analysis and position queries (read-only)
- Strategy recommendations (analysis only)

### Tier 2: Authenticated (x402 payment + operator signature)

**What:** Agent pays x402 fee AND provides operator auth credentials.
**Gets:** Everything in Tier 1, plus delegated (auto-execute) mode.
**Can:** Trigger our agent wallet to execute trades on the authenticated vault.

```
POST /api/chat
X-PAYMENT: <x402-payment-header>
Content-Type: application/json

{
  "messages": [{"role": "user", "content": "swap 1 ETH for USDC on Base"}],
  "vaultAddress": "0xYourVault",
  "chainId": 8453,
  "operatorAddress": "0xOperatorWallet",
  "authSignature": "0x...",
  "authTimestamp": 1741700000000,
  "executionMode": "delegated",
  "confirmExecution": true
}

→ 200: {
    "reply": "Executed: swapped 1 ETH → 2,079.54 USDC",
    "executionResult": {
      "txHash": "0x...",
      "confirmed": true,
      "explorerUrl": "https://basescan.org/tx/0x..."
    }
  }
```

**The `confirmExecution` field:**
When `confirmExecution` is `true`, the system executes transactions immediately
and returns the result (tx hash, confirmation status, explorer URL). When omitted
or `false`, the system returns unsigned transaction data for the caller to sign
and broadcast.

This enables **fully autonomous agent operation**: the calling agent sends
`confirmExecution: true` and receives execution results — no human in the loop.
The NAV shield, delegation checks, and 7-point validation still run on every
transaction. See [Safety Guarantees](#safety-guarantees) below.

**Requirements for Tier 2:**
1. The `operatorAddress` must be the vault owner on at least one supported chain
2. The `authSignature` must be a valid EIP-191 signature of the auth message,
   signed by `operatorAddress`
3. The vault must have active delegation to our agent wallet on the target chain
4. The agent wallet must be authorized for the required function selector

**Auth message format:**
```
Welcome to Rigoblock Operator

Sign this message to verify your wallet and access your smart pool assistant.
```

The signature is valid for 24 hours from `authTimestamp`.

---

## AI Model Selection

By default, the service uses **Workers AI (DeepSeek R1 + Llama 3.3 70B)** — zero-config,
no API key needed, included in the x402 price. DeepSeek R1 handles reasoning and
decision-making; Llama 3.3 70B handles fast follow-up responses after tool execution.
Agents can bring their own LLM
provider by including these optional fields in the `/api/chat` request body:

| Field | Type | Description |
|-------|------|-------------|
| `aiApiKey` | string | API key for the LLM provider (OpenRouter, Anthropic, OpenAI, etc.) |
| `aiModel` | string | Model identifier (e.g. `"anthropic/claude-sonnet-4"`, `"gpt-5-mini"`) |
| `aiBaseUrl` | string | Provider base URL (e.g. `"https://openrouter.ai/api/v1"`) |

**Resolution priority:**
1. **User-provided key** (`aiApiKey` + `aiModel` + `aiBaseUrl`) — agent's own provider
2. **Workers AI binding** — DeepSeek R1 reasoning + Llama 3.3 70B fast (default)
3. **Server OpenAI key** — server fallback

This is like MetaMask's default RPC: it works out of the box, but you can bring
your own. The tool definitions, safety layers, and system prompt are the same
regardless of which LLM processes the request.

---

## Extensibility — Building on Top

The `/api/chat` endpoint is an **atomic operations provider**. External developers
can build their own agents, skills, or plugins that compose on top of it:

- **Your agent calls our x402 API** for DeFi primitives (swaps, LP, bridges,
  staking, positions, NAV queries)
- **Your agent adds its own logic** — custom strategies, yield optimization,
  risk models, portfolio rebalancing, cross-protocol workflows
- **Your code runs on your infrastructure** — it never executes inside our
  Cloudflare environment

**Why this is safe:** Every operation that touches the vault — regardless of
which agent originated it — passes through our full safety stack: NAV shield
(10% max loss), delegation checks, selector whitelist, slippage protection.
The vault contract enforces these constraints on-chain, independently of the
calling agent's code.

**Example — external yield optimizer:**
```
External Agent                    Rigoblock x402 API
     │                                │
     ├─ "get aggregated NAV" ────────►│ ← atomic read
     │◄─ NAV per chain ──────────────┤
     │                                │
     │  [agent's own yield logic]     │
     │  [decides: move USDC to Base]  │
     │                                │
     ├─ "bridge 5000 USDC to Base" ──►│ ← atomic action
     │◄─ bridge tx ──────────────────┤
     │                                │
     ├─ "add 5000 USDC/ETH LP" ─────►│ ← atomic action
     │◄─ LP tx ─────────────────────┤
```

Each call is atomic. The external agent owns the orchestration plan. Our API
provides the safe DeFi execution layer.

---

## Security Model

### What the x402 payment wallet CAN do:
- Pay for API access ($0.002–$0.01 per call)
- Receive unsigned transaction data
- Query prices, positions, and vault info
- Get natural language DeFi analysis

### What the x402 payment wallet CANNOT do:
- Execute transactions on any vault
- Trigger delegated execution (even if the vault has delegation active)
- Access operator-only endpoints without a valid operator signature
- Bypass the NAV shield or any on-chain safety check

### What the operator signature unlocks:
- Delegated execution mode (our agent wallet executes on the vault)
- Access to vault-specific operations that modify state
- The operator signature proves: "I own this vault and authorize this action"

### Why these are separate:
The x402 payer and the operator are typically different wallets:
- **x402 payer:** The agent's operational wallet (holds USDC on Base for API fees)
- **Operator:** The vault owner's wallet (controls on-chain vault permissions)

An agent builder might have one x402 payment wallet but interact with multiple
vaults owned by different operators. The operator must independently authorize
the agent by providing a signed auth credential.

---

## Safety Guarantees

Every transaction that our agent wallet executes passes through these checks
**before broadcast:**

### 1. Operator Authentication
The caller must provide a valid signature proving they own the target vault.
No signature, no execution. This prevents any agent from operating vaults
they don't control.

### 2. Delegation Verification
The vault must have active on-chain delegation to our specific agent wallet
for the required function selector. The vault owner controls which functions
are delegated and can revoke at any time.

### 3. Seven-Point Execution Validation
1. Delegation config exists and is enabled in our KV store
2. Transaction target is the vault address (prevents cross-contract attacks)
3. Function selector is in the allowed set (whitelist, not blacklist)
4. Agent wallet identity matches stored config
5. Transaction simulation passes via `eth_call` (catches reverts pre-broadcast)
6. Agent wallet has sufficient balance for gas
7. Gas fees within hard caps per chain

### 4. NAV Shield (10% Maximum Loss)
Before every transaction broadcast, the system simulates the trade's impact
on the vault's Net Asset Value per unit:

- Atomically simulates: `multicall([swap, getNavDataView])`
- Compares post-swap NAV against the **higher of:** pre-swap NAV or 24-hour baseline
- If NAV drops > 10% → **transaction BLOCKED**, reason returned to caller
- This check runs outside the agent's control surface — it cannot be disabled,
  bypassed, or circumvented by any API caller

### 5. Slippage Protection
Default slippage tolerance: 1% (100 basis points), configurable by the operator
(0.1%–5%). Combined with the NAV shield, this provides two layers of price
protection.

### 6. Swap Shield (Oracle Price Protection)
Before every swap calldata is built, the system compares the DEX API quote
against the on-chain BackgeoOracle TWAP price:

- Uses the vault's `convertTokenAmount()` — a 5-minute TWAP oracle
- If the DEX quote is >5% worse than the oracle price → **swap BLOCKED**
- If the DEX quote is >10% better than the oracle price → **swap BLOCKED**
- Catches bad routes, stale liquidity, excessive price impact, API compromise,
  stale oracle conditions, and manipulated routes
- Graceful degradation: when the oracle has no price feed, the swap proceeds
  with a warning (does NOT block)
- The operator can temporarily disable it (10-minute TTL) for known high-impact trades
- The shield auto-re-enables after the timeout expires
- Independent of the NAV shield — both run on every swap

---

## What Agents CANNOT Do (Even with Full Authentication)

Even a fully authenticated agent with delegation access CANNOT:

| Action | Why not |
|--------|---------|
| Drain vault assets to external address | `withdraw` and `transferOwnership` selectors are never delegated |
| Execute trades that lose > 10% NAV | NAV shield blocks pre-broadcast |
| Execute swaps with >5% oracle divergence | Swap Shield compares DEX quote vs TWAP oracle |
| Bypass slippage protection | Slippage is enforced in swap calldata building |
| Call arbitrary contract functions | Selector whitelist — only approved vault functions |
| Send transactions to non-vault contracts | Target address must equal vault address |
| Spend more gas than the per-chain cap | Gas caps are hard-coded, not configurable |
| Modify delegation settings | Only vault owner can call `updateDelegation` from their wallet |

---

## Settlement Policy

x402 settlement (USDC transfer) only occurs when the API returns a **2xx response:**

| Response | Settlement | Reason |
|----------|-----------|--------|
| 200 OK | Settled | Agent received value — charge applies |
| 400 Bad Request | NOT settled | Malformed request — agent not charged |
| 401 Unauthorized | NOT settled | Auth failure — agent not charged |
| 500 Server Error | NOT settled | Our fault — agent not charged |

If settlement fails or is skipped, the CDP facilitator releases the held funds
back to the paying wallet after `maxTimeoutSeconds` (300s).

The `PAYMENT-RESPONSE` header on the response contains the settlement receipt
(base64-encoded JSON) when settlement succeeds.

---

## The `/api/quote` Endpoint

Stateless price quotes. No vault context needed. No operator auth.

```
GET /api/quote?sell=ETH&buy=USDC&amount=1&chain=base
```

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `sell` | Yes | Token to sell (symbol or contract address) |
| `buy` | Yes | Token to buy (symbol or contract address) |
| `amount` | Yes | Amount to sell (human-readable, e.g. "1" for 1 ETH) |
| `chain` | No (default: 8453) | Chain name or ID: `base`, `arbitrum`, `8453`, `42161`, etc. |

**Response:**
```json
{
  "sell": "1 ETH",
  "buy": "2079.548076 USDC",
  "price": "1 ETH = 2079.5481 USDC",
  "routing": "CLASSIC",
  "gasFeeUSD": "0.002423",
  "gasLimit": "394000",
  "chainId": 8453
}
```

---

## x402 Client Setup (TypeScript)

```typescript
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { publicActions } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

// 1. Create a signer with USDC on Base (for x402 payments)
const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(),
}).extend(publicActions);

// IMPORTANT: pass account as first arg (has .address), walletClient as second
const signer = toClientEvmSigner(account, walletClient);

// 2. Register the EVM exact scheme for Base mainnet
const client = new x402Client();
client.register("eip155:8453", new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(client);

// 3. Make a paid request
const res = await fetch("https://trader.rigoblock.com/api/quote?sell=ETH&buy=USDC&amount=1&chain=base");

if (res.status === 402) {
  const body = await res.json();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => res.headers.get(name),
    body,
  );
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paidRes = await fetch(
    "https://trader.rigoblock.com/api/quote?sell=ETH&buy=USDC&amount=1&chain=base",
    { headers },
  );
  console.log(await paidRes.json());
}
```

---

## Supported Chains

| Chain | ID | Name | Short |
|-------|----|------|-------|
| Ethereum | 1 | Ethereum | `ethereum` |
| Base | 8453 | Base | `base` |
| Arbitrum | 42161 | Arbitrum | `arbitrum` |
| Optimism | 10 | Optimism | `optimism` |
| Polygon | 137 | Polygon | `polygon` |
| BNB Chain | 56 | BNB Chain | `bsc` |
| Unichain | 130 | Unichain | `unichain` |

---

## Composability Model — For Orchestrator Agents

The `/api/chat` endpoint is an **atomic operations provider**. Each request
accepts a single natural-language message, internally invokes zero or one tool,
and returns a result (quote, unsigned transaction, analytics summary, etc.).

### What the chat endpoint handles (one per request):

| Category | Operations |
|----------|-----------|
| **Spot swaps** | Build swap tx (Uniswap / 0x), get quote |
| **GMX perpetuals** | Open, close, increase positions; get positions; cancel/update orders; claim funding fees; list markets |
| **Uniswap v4 LP** | Add/remove liquidity, list positions, collect fees |
| **GRG staking** | Stake, undelegate, unstake, claim rewards (via vault adapter); end epoch (via staking proxy — manual only) |
| **Cross-chain bridge** | Transfer tokens (Across Protocol), sync NAV, get bridge quote, aggregated NAV, rebalance plan |
| **Vault management** | Get info, check token balance, deploy pool, fund pool (mint) |
| **Delegation** | Setup, revoke all, revoke specific selectors, check status |
| **Strategies** | Create (manual or autonomous), remove, list automated strategies |
| **Chain** | Switch active chain |

### What the chat endpoint does NOT do:

- **Multi-step orchestration** — It won't plan a sequence of operations.
  "Rebalance to Base then LP the USDC" is two operations; the caller must
  decompose and sequence them.
- **Historical data** — No trade history, past performance, or historical prices.
  Source this externally (CoinGecko, DeFi Llama, etc.).
- **Yield estimation** — No APR/APY calculations. The caller must gather
  yield data from protocol-specific sources.
- **Lending protocols** — No Aave, Compound, or other lending interaction.
- **Arbitrary on-chain reads** — Only the views exposed by tools (NAV, balances,
  positions, delegation status).
- **Token approvals** — The vault adapter handles these internally.

### How orchestrator agents should use this API:

An orchestrator agent should:

1. **Plan** — Use its own reasoning to decompose complex strategies into
   atomic operations our API supports.
2. **Query** — Call our API for read operations (quotes, balances, positions,
   aggregated NAV) to gather decision-making data.
3. **Execute** — Call our API for each action step (one chat message per action).
4. **Handle results** — In manual mode, sign and broadcast the unsigned tx.
   In delegated mode, check the execution result.
5. **Iterate** — Check outcomes and decide the next step.

**Example — Multi-step rebalance + stake:**
```
Agent: POST /api/chat "get aggregated NAV"
  ← { reply: "NAV per chain...", ... }

Agent: [decides: bridge USDC from Arbitrum to Ethereum]
Agent: POST /api/chat "bridge 1000 USDC from Arbitrum to Ethereum"
  ← { transaction: { ... }, reply: "Bridge ready..." }

Agent: [signs/broadcasts, waits for bridge completion]

Agent: POST /api/chat "swap 500 USDC for GRG on Ethereum"
  ← { transaction: { ... }, reply: "Swap ready..." }

Agent: [signs/broadcasts]

Agent: POST /api/chat "stake 500 GRG"
  ← { transaction: { ... }, reply: "Stake ready..." }
```

Each call is atomic. The orchestrator owns the plan.

---

## Bazaar Discovery

This service is registered in the [x402 Bazaar](https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources),
Coinbase's discovery API for x402-enabled services. AI agents using the Bazaar
can discover and call our endpoints automatically.

---

## FAQ

**Q: Does the x402 paying wallet need to be the vault operator?**
No. The x402 payer and the vault operator are independent. The x402 payer pays
for API access. The operator proves vault ownership via signature. They can be
different wallets.

**Q: Can an agent execute trades without the operator's private key?**
No. Delegated execution requires a valid operator signature. Without it, the
agent only gets unsigned transaction data (manual mode).

**Q: What happens if an agent provides a wrong vault address?**
In manual mode: they get calldata they can't execute (they don't own the vault).
In authenticated mode: `verifyOperatorAuth` checks on-chain that the signer owns
the vault — if they don't, the request is rejected with 403.

**Q: Can an agent drain a vault through repeated small trades?**
The NAV shield checks against a 24-hour baseline. Each trade is checked
independently against the higher of the pre-swap NAV or the 24h baseline.
A series of 1% losses would be individually allowed but would shift the
baseline down over 24 hours. The 10% per-trade limit is the hard cap.

**Q: What if the agent wallet private key is compromised?**
The vault owner can revoke delegation at any time via `revokeAllDelegations()`.
The agent wallet can only call whitelisted selectors on the vault — cannot
withdraw funds or transfer ownership.

**Q: Is fully autonomous execution safe?**
Yes, when delegation is active. Every auto-executed transaction still passes
through the full safety stack: operator authentication, delegation verification,
7-point validation, NAV shield (10% max loss), and slippage protection. The
vault contract enforces selector-level permissions on-chain. The operator can
revoke delegation at any time to stop all autonomous execution instantly.

---

## Autonomous Strategies

Strategies are cron-triggered automated evaluations that run on a configurable
interval (minimum 5 minutes). Each strategy stores a natural-language instruction
that the LLM evaluates against live market data.

### Two Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| **Manual** (default) | LLM analyzes, sends recommendation via Telegram. Operator confirms to execute. | Low-frequency, high-conviction trades |
| **Autonomous** | LLM analyzes and executes immediately. Operator notified after execution. | Frequent rebalancing, time-sensitive hedging |

### Why Autonomous Mode is Safe

Autonomous strategies execute through the same safety stack as any delegated
transaction:

1. **NAV Shield** — every trade is simulated pre-broadcast; >10% NAV drop is blocked
2. **Selector whitelist** — only approved vault functions can be called
3. **Target enforcement** — transactions can only target the vault address
4. **Slippage protection** — 1% default tolerance on all swaps
5. **Auto-pause** — strategy pauses after 3 consecutive failures
6. **Instant revocation** — operator can revoke delegation on-chain at any time

The vault contract enforces these constraints independently of the agent. Even
if the agent's LLM produces a harmful recommendation, the on-chain safety layers
block it.

### Context Continuity

Each strategy run carries forward the previous recommendation (capped at 500
characters) so the LLM can assess whether market conditions have changed since
the last evaluation. This prevents stale recommendations and enables the agent
to track evolving positions.

### Creating an Autonomous Strategy

Via the chat interface (browser or API):

```
"Create a 15-minute autonomous strategy to rebalance my ETH/USDC LP
 position when it drifts more than 2% from the target range"
```

The `autoExecute` parameter controls the mode:
- `autoExecute: true` → autonomous (execute immediately)
- `autoExecute: false` (default) → manual (notify and wait for confirmation)
