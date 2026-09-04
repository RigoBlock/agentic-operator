# AGENTS.md — External Agent Integration Guide

> How external AI agents interact with the Rigoblock Agentic Operator via x402.

---

## Overview

The service exposes x402-gated endpoints on `https://trader.rigoblock.com`. Every operation is an atomic HTTP request.

| Endpoint | Method | Price | What it returns |
|----------|--------|-------|-----------------|
| `/api/quote` | GET | $0.0020 USDC | DEX price quote |
| `/api/quote/uniswap` | POST | $0.0021 USDC | Uniswap Trading API quote + oracle enrichment |
| `/api/quote/0x` | GET | $0.0022 USDC | 0x API quote + oracle enrichment |
| `/api/oracle/refresh` | POST | $0.0023 USDC | Oracle refresh transaction builder |
| `/api/tools` | GET | $0.0024 USDC | Tool catalog with JSON schemas |
| `/api/tools?toolName={name}` | POST | $0.0025 USDC | Direct tool execution |
| `/api/chat` | POST | up to $0.10 USDC (billed by actual usage) | Natural-language DeFi response |

Payments are in USDC on **Base mainnet** (`eip155:8453`) via the [x402 protocol](https://x402.org). `/api/chat` uses the `upto` scheme; all quote/tool endpoints use the `exact` scheme.

---

## Access Tiers

### Tier 1 — x402 payment only

- Gets unsigned transaction data, quotes, balances, positions, analysis.
- Cannot execute transactions on any vault.

### Tier 2 — x402 payment + operator signature

Required for delegated (auto-execute) mode.

Auth message to sign:

```
Welcome to Rigoblock Operator

Sign this message to verify your wallet and access your smart pool assistant.

Timestamp: 1741700000000
```

Requirements:

1. `operatorAddress` must be the vault owner on at least one supported chain.
2. `authSignature` is a valid EIP-191 signature of the message above, including the timestamp line.
3. The vault has active on-chain delegation to the agent wallet for the required function selector.
4. The signature is valid for 24 hours from `authTimestamp`.

Set `executionMode: "delegated"` and `confirmExecution: true` to auto-execute. Delegated mode without `confirmExecution` returns unsigned calldata.

Optional LLM overrides for `/api/chat`:

| Field | Description |
|-------|-------------|
| `aiApiKey` | Provider API key (OpenRouter, Anthropic, OpenAI, etc.) |
| `aiModel` | Model identifier, e.g. `"anthropic/claude-sonnet-4"` |
| `aiBaseUrl` | Provider base URL, e.g. `"https://openrouter.ai/api/v1"` |

Resolution priority: Workers AI binding (default) → user-provided key → server OpenAI fallback.

---

## Safety Guarantees

Every delegated transaction passes:

1. **Operator auth** — signature + on-chain ownership.
2. **Delegation check** — active on-chain delegation for the exact selector.
3. **7-point validation** — config enabled, target == vault, selector whitelisted, agent wallet matches, `eth_call` simulation succeeds, gas balance sufficient, gas within per-chain caps.
4. **NAV shield** — simulates `multicall([tx, updateUnitaryValue])`; blocks if post-swap unit value drops > configured threshold (default 10%, temporarily configurable 1%–100% for 10 minutes).
5. **Slippage protection** — default 1% (100 bps), clamped to 0.1%–5%.
6. **Swap shield** — compares DEX quote vs BackgeoOracle 5-minute TWAP; blocks if divergence exceeds 5% (or operator's temporary tolerance).

External agents cannot change slippage, swap-shield tolerance, or NAV-shield threshold.

---

## What Agents Cannot Do

| Action | Why not |
|--------|---------|
| Drain vault assets to external address | `withdraw` / `transferOwnership` are never delegated |
| Lose more than the configured NAV threshold per trade | NAV shield blocks it |
| Execute swaps with >5% oracle divergence | Swap shield blocks it (unless operator raised tolerance) |
| Bypass slippage protection | Enforced in calldata building |
| Call arbitrary contracts / functions | Target must be the vault; selector whitelist |
| Spend more than per-chain gas caps | Hard-coded caps |
| Modify delegation or safety settings | Only the vault owner can |

---

## Settlement Policy

Settlement (USDC transfer) only occurs on **2xx** responses. 400/401/500 are not settled. The `PAYMENT-RESPONSE` header contains the settlement receipt when settlement succeeds.

---

## Endpoints

### `GET /api/quote`

Stateless price quote.

Query params: `sell`, `buy`, `amount`, `chain` (default `8453`).

Response:

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

### `POST /api/quote/uniswap`

Forwards the request to the Uniswap Trading API `/quote` and appends:

```json
{
  "priceFeedExists": true,
  "deltaBps": 12,
  "oracleAmount": "2079548076"
}
```

### `GET /api/quote/0x`

Forwards to the 0x Swap API `/swap/allowance-holder/quote` and appends the same three oracle fields.

Supports `sellAmount` (exact-input) and `buyAmount` (exact-output).

### `GET /api/tools`

Returns the tool catalog: name, description, JSON-Schema parameters, category, `requiresOperatorAuth`, `readOnly`.

### `POST /api/tools?toolName={name}`

Direct tool invocation. Body:

```json
{
  "arguments": { ... },
  "chainId": 8453,
  "vaultAddress": "0x...",
  "operatorAddress": "0x...",
  "authSignature": "0x...",
  "authTimestamp": 1741700000000,
  "executionMode": "delegated",
  "confirmExecution": true
}
```

`executionMode: "delegated"` alone returns unsigned calldata. Add `confirmExecution: true` to auto-execute.

### `POST /api/chat`

Natural-language interface. Returns `reply`, optional `transaction`/`transactions`, and `executionResult`/`executionResults` when `confirmExecution: true` is used in delegated mode.

---

## Hyperliquid (HyperEVM, USDC-Only)

Smart pools trade on Hyperliquid Core through the `AHyperliquid` vault adapter (`deposit` / `depositFor` / `sendRawAction`). The integration is **USDC-only**: on HyperEVM the pool base token must be USDC and only USDC can be deposited or withdrawn. Tools: `hyperliquid_get_positions`, `hyperliquid_get_markets`, `hyperliquid_deposit`, `hyperliquid_limit_order`, `hyperliquid_cancel_order`, `hyperliquid_usd_class_transfer`, `hyperliquid_spot_send`.

Semantics you must know:

- **Deposit** (`hyperliquid_deposit`) bridges EVM USDC (6 decimals) into the Core perp account (`destinationDex = 0`) and **activates the Core account** if it doesn't exist yet.
- **Withdrawal is always two steps**: `hyperliquid_usd_class_transfer` moves USDC perp margin → Core spot (perp USDC, 6 decimals), then `hyperliquid_spot_send` bridges Core spot USDC (8-decimal core wei) back to HyperEVM. Spot→perp transfers are rejected by the adapter (perps-only).
- **Trading** = CoreWriter limit orders behind `sendRawAction`: asset ids `< 10000` (core perps) only, outcome/spot markets rejected. An order without an explicit price is a **market order**: priced at the best ask (buy) / best bid (sell) plus a 1% bound, executed as IOC (fill immediately or cancel). An explicit price creates a resting limit order — GTC by default, which has **no expiry** (stays until filled or cancelled); `tif` also supports `ioc` and `alo`. Prices MUST satisfy Hyperliquid's tick rules (≤5 significant figures, ≤ 6−szDecimals decimals) — the tool rounds automatically, off-tick prices are rejected by the engine. `reduceOnly` orders (or `close=true`) decrease/close positions. Orders can be cancelled by oid or cloid.
- **Margin is cross/global**: collateral is not pledged per position. The positions report shows declared per-position leverage; account-wide leverage = total open notional / perp account value.
- **Account value** (perp account value, Core spot USDC balance, account activation) is read from HyperEVM precompiles — the same values the vault NAV uses. **Per-position state** (entry/mark/liq prices, unrealized PnL, open orders) comes from the Hyperliquid Core info API (`api.hyperliquid.xyz/info`) and is unavailable on HyperEVM precompiles.
- **Cross-chain bridging to/from HyperEVM** (transfer/sync/rebalance via Across) is enabled for **USDC only** — mirroring the on-chain `CrosschainLib` validation where `HYPER_USDC` is the sole bridgeable token on chain 999. Uses the dedicated HyperEVM MulticallHandler and the Across HyperEVM SpokePool.
- After a deposit or spot-send, NAV-sensitive vault operations are locked for the ~128s HyperCore settlement window; the agent is also blocked from trading during that window on-chain.

## Supported Chains

| Chain | ID | Short name |
|-------|----|------------|
| Ethereum | 1 | `ethereum` |
| Base | 8453 | `base` |
| Arbitrum | 42161 | `arbitrum` |
| Optimism | 10 | `optimism` |
| Polygon | 137 | `polygon` |
| BNB Chain | 56 | `bsc` |
| Unichain | 130 | `unichain` |
| HyperEVM | 999 | `hyperevm` |

---

## Composability Model

`/api/chat` is an **atomic operations provider**. Each request handles one operation.

**The chat endpoint handles one per request:** spot swaps, GMX perpetuals, Hyperliquid perpetuals, Uniswap v4 LP, GRG staking, cross-chain bridge/transfer/sync, vault info, delegation setup/revoke/status, TWAP orders, strategies, chain switch.

**It does NOT handle:** multi-step orchestration, historical data, APR/APY estimates, lending protocols, arbitrary on-chain reads, or token approvals (the vault adapter handles approvals internally).

Orchestrator agents should plan externally, query our API for reads, execute one step per call, and iterate.
