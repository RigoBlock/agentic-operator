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
4. **NAV shield** — `eth_call` of `multicall([tx, updateUnitaryValue])` from the vault owner (the simulation is caller-independent: selector delegation is enforced by validation, and the owner always passes the fallback write-mode gate, so no multicall delegation exists); blocks if post-swap unit value drops > configured threshold (default 10%, temporarily configurable 1%–100% for 10 minutes). The shield is also the **kill-switch for trading**: once the vault has breached its allowed NAV drop, trading actions are rejected while NAV-neutral operations keep working so the operator can rebalance or exit. Trading paths — swaps and Hyperliquid `sendRawAction` orders alike — must NEVER be exempted. EXCEPTION (NAV-neutral only): `deposit` / `depositFor` / `sendRawAction` spot sends on chain 999 lock pool NAV for a few seconds while HyperCore settles (they touch `lastActionTimestamp`, so a trailing `updateUnitaryValue` in the same multicall always reverts `NavLocked()`), yet cannot impact NAV — deposits move USDC 1:1 into the Core perp account the NAV already counts, and a spot send is a Core → HyperEVM withdrawal. For those the shield simulates the raw transaction instead (reverts still block; a clean simulation is allowed without a threshold comparison, code `NAV_NEUTRAL`).
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
| Escalate privileges via multicall | Multicall is not delegated at all — the NAV shield simulates it from the vault owner. Even if it were, every inner call re-enters the vault fallback and is individually selector-checked, and admin methods (`setOwner`, `updateDelegation`) are core `onlyOwner` and revert for the agent even inside a multicall (proven by `MulticallDelegationSecurityFork.t.sol` in v3-contracts) |
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
- **Core→HyperEVM spot sends are charged gas from Core spot USDC**: each send costs ~0.0017 USDC-worth of gas at Core's own schedule (not the HyperEVM gas price), debited from the pool's Core spot USDC — or from Core HYPE when the pool happens to hold it (observed on pool 0xefa4…0645c's second send: HYPE 0.004 → 0.00397966, USDC deducted exactly the sent amount), but HYPE is never required. A pool's **first-ever successful** Core→EVM send additionally deducts a **one-time 1 USDC activation fee** (Circle CCTP-on-HyperCore docs; confirmed n=2 — the second send deducted exactly 0.2 for a 0.2 send, no second activation). `hyperliquid_spot_send` preflights a **≥ 0.1 USDC residual** purely as a gas buffer; the activation fee is not enforced (activation status is not queryable via any known API) — the error message tells the operator to leave ~1.1 USDC for a pool's first send, and a failed attempt charges nothing so they can just retry smaller. CoreWriter never reverts on HyperCore failures, so without the preflight an underfunded send shows as a successful HyperEVM tx. Note: HYPE can alternatively serve as the gas payer on HyperCore, but it is useless in the Rigoblock context — the USDC-only adapter can never acquire it, and it would need an external transfer from the owner.
- **Trading** = CoreWriter limit orders behind `sendRawAction`: asset ids `< 10000` (core perps) only, outcome/spot markets rejected. An order without an explicit price is a **market order**: priced at the best ask (buy) / best bid (sell) plus a 1% bound, executed as IOC (fill immediately or cancel). An explicit price creates a resting limit order — GTC by default, which has **no expiry** (stays until filled or cancelled); `tif` also supports `ioc` and `alo`. Prices MUST satisfy Hyperliquid's tick rules (≤5 significant figures, ≤ 6−szDecimals decimals) — the tool rounds automatically, off-tick prices are rejected by the engine. `reduceOnly` orders (or `close=true`) decrease/close positions. Orders can be cancelled by oid or cloid.
- **Margin is cross/global**: collateral is not pledged per position. The positions report shows declared per-position leverage; account-wide leverage = total open notional / perp account value.
- **Account value** (perp account value, Core spot USDC balance, account activation) is read from HyperEVM precompiles — the same values the vault NAV uses. **Per-position state** (entry/mark/liq prices, unrealized PnL, open orders) comes from the Hyperliquid Core info API (`api.hyperliquid.xyz/info`) and is unavailable on HyperEVM precompiles.
- **Cross-chain bridging to/from HyperEVM** (transfer/sync/rebalance via Across) is enabled for **USDC only** — mirroring the on-chain `CrosschainLib` validation where `HYPER_USDC` is the sole bridgeable token on chain 999. Uses the dedicated HyperEVM MulticallHandler and the Across HyperEVM SpokePool.
- **Gas sponsorship on HyperEVM uses the non-7702 (sma-b) route** (probed 2026-09): Alchemy's HyperEVM Wallet API has **no EIP-7702 mode** — `wallet_prepareCalls` with the owner address fails with "EIP-7702 is not enabled on HyperEVM" even with no paymaster capability, while the identical request on Base passes. The Gas Manager policy gates only the paymaster stage and is never reached in 7702 mode. The **implemented** alternative is non-7702 mode: `wallet_requestAccount({signerAddress, creationHint:{accountType:"sma-b"}})` returns a **stable, deterministic** smart-account address derived from the agent EOA (`getScaAddress` in `src/services/scaAccount.ts`), and `wallet_prepareCalls({from: <sma-b address>})` is accepted on chain 999. The **agent wallet remains the sole signer/owner** of the sma-b account — Alchemy never holds the key — and the **operator wallet only signs the one-time on-chain `updateDelegation` grant**, exactly as on every other chain. On 999, `prepareDelegation` co-delegates the chain's mapped selector set (from `getDelegableSelectors(999)`) to **both** the agent EOA (direct-broadcast fallback) and the sca address (sponsored primary) in a single `updateDelegation` call; `confirmDelegation` persists `scaAddress` in `config.chains["999"]` and writes the `agent-reverse:` KV lookup so the gas-policy webhook recognizes the sca sender. The stored tx `from` decides execution: `from == sca` → sponsored path only (no EOA fallback on failure), `from == agent EOA` → direct broadcast. Sponsored gas ON without a stored `scaAddress` (delegation not updated) falls back to the EOA/direct path. On every OTHER chain, sponsored gas via 7702 works as-is but requires the chain to be included in the Alchemy Gas Manager policy — when the paymaster rejects a sponsored tx, the `SPONSORED_FAILED` error says so. Probes: `scripts/test-hyperliquid-sponsor-policy.ts` (7702 gate), `scripts/test-hyperliquid-smab-flow.ts` (sma-b route).
- After a deposit or spot-send, NAV-sensitive vault operations are locked for a few seconds while HyperCore settles; the agent is also blocked from trading during that window on-chain.

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

## Code Discipline

Rules for every code change to this service:

1. **No fallbacks, no special-case layers.** If a method produces wrong results, fix the root cause or replace the method. Do not wrap it in cross-checks, alternate-path retries, or "best effort" branches that guess. (Example: the NAV shield uses `eth_call` of `multicall([tx, updateUnitaryValue])` from the actual executor — the same primitive real execution uses — because `eth_simulateV1` produces synthetic-block false positives on Nitro chains. There is no simulator cross-check fallback.)
2. **Deterministic validation lives in tools/services, not in the LLM.** Amounts, tolerances, routes, and safety checks are computed in code; the LLM only routes to the right tool.
3. **User-facing text uses only labels and numbers the code knows.** Never raw function selectors, snake_case tool names, or guessed causes (a raw revert selector is acceptable only when the revert cannot be decoded). If a fact is unavailable, say what is known instead of inventing it.

---

## Composability Model

`/api/chat` is an **atomic operations provider**. Each request handles one operation.

**The chat endpoint handles one per request:** spot swaps, GMX perpetuals, Hyperliquid perpetuals, Uniswap v4 LP, GRG staking, cross-chain bridge/transfer/sync, vault info, delegation setup/revoke/status, TWAP orders, strategies, chain switch.

**It does NOT handle:** multi-step orchestration, historical data, APR/APY estimates, lending protocols, arbitrary on-chain reads, or token approvals (the vault adapter handles approvals internally).

Orchestrator agents should plan externally, query our API for reads, execute one step per call, and iterate.
