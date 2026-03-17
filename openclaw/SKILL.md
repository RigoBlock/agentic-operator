---
name: rigoblock-defi
description: >
  Trade DeFi on Rigoblock vaults via autonomous AI execution. Supports spot
  swaps (Uniswap, 0x), Uniswap v4 LP management, GMX V2 perpetuals,
  cross-chain bridging (Across), GRG staking, and vault management across
  7 EVM chains. Pays for API access with USDT0 via x402. Three composable
  XAUT gold strategy templates: carry trade, LP+hedge, and staking optimization.
metadata: {"openclaw":{"requires":{"env":["RIGOBLOCK_VAULT_ADDRESS","SEED_PHRASE"]},"primaryEnv":"SEED_PHRASE","emoji":"🏦","homepage":"https://trader.rigoblock.com"}}
---

# Rigoblock DeFi Operator

You have access to DeFi trading on Rigoblock smart pool vaults via two HTTP
endpoints at `https://trader.rigoblock.com`. All calls are paid with USDT0
(or USDC) via the x402 protocol — you pay by including an `X-PAYMENT` header.

This skill is **language-agnostic**: every operation is a plain HTTP request.
Use `curl`, `fetch`, `requests`, or any HTTP client your runtime provides.

## Environment Variables

- `RIGOBLOCK_VAULT_ADDRESS` — The vault contract address to operate on
- `RIGOBLOCK_CHAIN_ID` — Default chain ID (optional, default: 8453 Base)
- `SEED_PHRASE` — WDK seed phrase for x402 payments and operator auth signing

## The Two Endpoints

All DeFi operations go through just **two** HTTP endpoints:

### 1. `GET /api/quote` — Price Quotes (read-only)

Returns a DEX price quote. No vault context needed.

```
GET https://trader.rigoblock.com/api/quote?sell=ETH&buy=USDC&amount=1&chain=base
X-PAYMENT: <x402-payment-header>

→ 200: { "sell": "1 ETH", "buy": "2079.54 USDC", "price": "1 ETH = 2079.54 USDC", ... }
```

| Param | Required | Description |
|-------|----------|-------------|
| `sell` | Yes | Token to sell (symbol or address) |
| `buy` | Yes | Token to buy (symbol or address) |
| `amount` | Yes | Human-readable amount (e.g. "1" for 1 ETH) |
| `chain` | No | Chain name or ID: `base`, `arbitrum`, `ethereum`, `8453`, etc. |

Cost: **$0.002 USDC** per call.

### 2. `POST /api/chat` — All Vault Operations

Natural language → DeFi action. This single endpoint handles swaps, LP,
perps, bridging, staking, vault info — everything. You send a message
describing what you want; the API returns either transaction data or an
execution result.

```
POST https://trader.rigoblock.com/api/chat
Content-Type: application/json
X-PAYMENT: <x402-payment-header>

{
  "messages": [{"role": "user", "content": "swap 1000 USDT for XAUT on Arbitrum"}],
  "vaultAddress": "0xYourVault",
  "chainId": 42161
}
```

**Manual mode** (default) — returns unsigned transaction data:
```json
{
  "reply": "I'll prepare a swap of 1000 USDT → XAUT...",
  "transaction": {
    "to": "0xYourVault",
    "data": "0x...",
    "value": "0x0",
    "chainId": 42161,
    "description": "Swap 1000 USDT → 0.32 XAUT via Uniswap"
  }
}
```

**Delegated mode** (with operator auth) — executes the transaction:
```json
{
  "messages": [{"role": "user", "content": "swap 1000 USDT for XAUT on Arbitrum"}],
  "vaultAddress": "0xYourVault",
  "chainId": 42161,
  "operatorAddress": "0xOperatorWallet",
  "authSignature": "0x...",
  "authTimestamp": 1741700000000,
  "executionMode": "delegated",
  "confirmExecution": true
}

→ { "reply": "Executed: swapped ...", "executionResult": { "txHash": "0x...", "confirmed": true } }
```

Cost: **$0.01 USDC** per call.

### x402 Payment

Every request that hits these endpoints without a valid `X-PAYMENT` header
returns `402 Payment Required` with a payment challenge. Your x402 client
signs the payment using your WDK wallet and retries with the header.

If you're using JavaScript/TypeScript, see `{baseDir}/sdk/` for a ready-made
x402 client. For Python or other languages, implement x402 directly — it's
a signed USDC/USDT0 payment header.

### Operator Authentication

To use **delegated mode** (auto-execute), your operator wallet must sign this
EIP-191 message:

```
Welcome to Rigoblock Operator

Sign this message to verify your wallet and access your smart pool assistant.
```

Include the signature as `authSignature` in the POST body. The operator must
be the vault owner on-chain. Signature is valid for 24 hours.

## What You Can Ask the Chat Endpoint

The `/api/chat` endpoint understands natural language. Here are the categories
of operations — use your own judgment on how to phrase requests:

### Spot Trading
- Swap tokens on any supported chain via Uniswap or 0x aggregator
- Examples: "swap 1000 USDT for XAUT on Arbitrum", "swap 0.5 ETH to USDC on Base using 0x"

### Uniswap v4 Liquidity
- Add/remove LP positions, list positions, collect fees
- The XAUT/USDT pool on Ethereum: `0x19a01cd4a3d7a1fd58ee778fcdc74fce46023adb0ac179a603e5b3234dd5610d`
- Examples: "add liquidity to XAUT/USDT pool with 0.5 XAUT and 1500 USDT on Ethereum"

### GMX V2 Perpetuals (Arbitrum)
- Open, close, increase positions; get positions; cancel/update orders; claim funding
- XAUT/USD market: `XAUT.v2/USD [WBTC.b-USDC]`, index `0x7624cccCc59361D583F28BEC40D37e7771def5D`
- Examples: "open a 1x short XAUT/USD position with 500 USDT collateral on GMX"

### Cross-Chain Bridge (Across Protocol)
- Transfer tokens between any two supported chains
- Examples: "bridge 1000 USDT from Ethereum to Arbitrum"

### GRG Staking (Ethereum only)
- Stake, unstake, undelegate, claim rewards, end epoch
- Examples: "stake 5000 GRG", "claim staking rewards"

### Vault Management
- Get vault info, check token balances, aggregated NAV across chains
- Examples: "show vault info on Arbitrum", "get aggregated NAV"

### Delegation Management
- Set up or revoke delegation to agent wallet
- Examples: "check delegation status", "setup delegation"

## Strategy Knowledge

You have access to three composable strategy templates. **You decide** when to
use each one and how to combine them — these are guidelines, not rigid scripts.
Full details in `{baseDir}/references/STRATEGIES.md`.

### Strategy 1: XAUT Carry Trade (Arbitrum)

**What it is:** Delta-neutral gold carry. Buy XAUT spot + short XAUT/USD on GMX.
The long and short cancel out directional exposure. You earn from the funding
rate on the short perp when open interest is long-biased.

**Key signals:**
- Enter when GMX funding rate is positive and stable (suggests longs are paying shorts)
- Exit when funding turns negative for a sustained period (you're now paying)
- Rebalance when spot and perp sizes drift apart by more than ~2%

**Risk:** Funding rate can flip. The cost is swap fees + any negative funding accrued.
1x short has no leverage risk. NAV shield blocks any single trade ≥10% loss.

### Strategy 2: XAUT/USDT LP + Hedge (Ethereum + Arbitrum)

**What it is:** Earn LP fees on the XAUT/USDT Uniswap v4 pool on Ethereum,
hedge the directional XAUT exposure with a GMX short on Arbitrum.
100% Tether token flow: USDT + XAUT + USDT0 for payments.

**Key signals:**
- Enter when LP fee APR exceeds funding cost of the hedge
- Exit when hedge cost exceeds LP income or IL risk is unacceptable
- Monitor cross-chain NAV and hedge ratio; rebalance when drift > threshold

**Key steps (you sequence these):** get vault USDT → swap to XAUT → add LP →
bridge collateral to Arbitrum → open short hedge → monitor both legs.

**Risk:** Multi-chain complexity, bridge latency, hedge funding cost may exceed fees.

### Strategy 3: GRG Staking Optimization (Ethereum)

**What it is:** Determine the optimal GRG stake for best risk-adjusted yield.
Minimize capital allocated to GRG while capturing the staking benefit.

**Key insight:** Yield *rate* is constant regardless of stake size (it's proportional).
So the smallest positive allocation captures the same yield %. Community
delegation can multiply the effective reward 3-7×.

**Simulation model:** See `{baseDir}/staking-strategy.md` for full details.
Simulate 0–10% of AUM, enforce liquidity ceiling, find optimal allocation.

### Strategy Compositor

When asked to "optimize" or "run a strategy," gather data and score all three:

1. **Funding rate data** → carry trade yield estimate
2. **LP fee data** → LP+hedge net yield
3. **Staking simulation** → risk-adjusted staking yield
4. **Compare** and allocate: primary strategy 50-80%, staking if positive,
   always keep 10-30% USDT reserve for rebalancing and gas

You may combine strategies. You decide the allocation.

## Safety Guarantees

Every transaction broadcast by the agent wallet passes these checks:

1. **Operator auth** — EIP-191 signature proving vault ownership
2. **Delegation check** — vault must delegate to agent wallet for the function selector
3. **7-point validation** — config, target address, selector whitelist, agent identity,
   eth_call simulation, balance, gas caps
4. **NAV shield** — simulates trade impact; blocks if vault unit price drops >10%.
   **Fail-closed**: any simulation error BLOCKS the transaction.
5. **Slippage** — 1% default on all swaps

For full safety model, see `{baseDir}/references/SAFETY.md`.

## Supported Chains

| Chain | ID | Spot | Perps | LP | Bridge | Staking |
|-------|----|------|-------|----|--------|---------|
| Ethereum | 1 | ✓ | — | ✓ | ✓ | ✓ |
| Base | 8453 | ✓ | — | ✓ | ✓ | — |
| Arbitrum | 42161 | ✓ | ✓ (GMX) | ✓ | ✓ | — |
| Optimism | 10 | ✓ | — | ✓ | ✓ | — |
| Polygon | 137 | ✓ | — | — | ✓ | — |
| BNB Chain | 56 | ✓ | — | — | ✓ | — |
| Unichain | 130 | ✓ | — | ✓ | — | — |

## Reference Files

- `{baseDir}/references/STRATEGIES.md` — Detailed strategy entry/exit sequences and parameters
- `{baseDir}/references/CHAINS.md` — Chain-specific tokens, addresses, and capabilities
- `{baseDir}/references/SAFETY.md` — Full safety model and what agents cannot do
- `{baseDir}/references/API.md` — HTTP API specification with request/response examples
- `{baseDir}/staking-strategy.md` — GRG staking simulation model (optimization algorithm)
- `{baseDir}/sdk/` — Optional TypeScript SDK with x402 client (not required — any HTTP client works)
