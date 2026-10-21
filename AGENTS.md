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
4. The signature is valid for 24 hours from `authTimestamp`, and it is **redeemed once for a session token** (see Authentication below): after redemption, subsequent requests authenticate with the session token, not the signature.

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
4. **NAV shield** — `eth_call` of `multicall([tx, updateUnitaryValue])` from the vault owner (the simulation is caller-independent: selector delegation is enforced by validation, and the owner always passes the fallback write-mode gate, so no multicall delegation exists); blocks if post-swap unit value drops > configured threshold (default 10%, temporarily configurable 1%–100% for 10 minutes). The shield is also the **kill-switch for trading**: once the vault has breached its allowed NAV drop, trading actions are rejected while NAV-neutral operations keep working so the operator can rebalance or exit. Trading paths — swaps and Hyperliquid `sendRawAction` orders alike — must NEVER be exempted. EXCEPTION (NAV-neutral only): `deposit` / `depositFor` / `sendRawAction` spot sends on chain 999 lock pool NAV for a few seconds while HyperCore settles (they touch `lastActionTimestamp`, so a trailing `updateUnitaryValue` in the same multicall always reverts `NavLocked()`), yet cannot impact NAV — deposits move USDC 1:1 into the Core perp account the NAV already counts, and a spot send is a Core → HyperEVM withdrawal. For those the shield simulates the raw transaction instead (reverts still block; a clean simulation is allowed without a threshold comparison, code `NAV_NEUTRAL`). `mint` (pool funding, ALL chains) is in the same NAV-neutral class: operator-only capital movement (the agent is never delegated mint), it cannot distort NAV and must stay possible on a vault that already breached its threshold — raw-tx simulation, reverts still block.
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
- Core account activation is service-side readable ONLY from the `coreUserExists` precompile (raw eth_call to 0x810, never via the vault/simulation): the Core info API returns zeroed success for non-activated accounts (verified 2026-10-13), so it cannot discriminate. `getHyperliquidAccountActivation` (services/hyperliquid.ts) reads it directly, caches per vault 5 minutes, returns null on read failure ("unknown — never prompt/block"), and is prompt-only: the positions report and limit-order drafts warn and suggest `hyperliquid_deposit`, but never gate. Enforcement stays on-chain (`AccountNotActivated`, decoded + translated at estimation).
- **Gas estimation pins `blockTag: "latest"` on all chains** (observed 2026-10-13): viem's `estimateGas` omits the block parameter unless `blockTag` is set explicitly, and a *bare* `eth_estimateGas` on HyperEVM intermittently executes read precompiles against unattached state — any vault-adapter transaction reverts `PrecompileLib__CoreUserExistsPrecompileFailed` (selector `0xafa95720`, surfacing as "Failed to estimate gas: InvalidTransaction(Revert(RevertError { output: Some(0xafa95720) }))") — while the same call with any explicit block tag, and any `eth_call`, succeeds, and the confirmed tx lands fine (MetaMask shows the same spurious "likely to fail"). The failure is time-dependent (minute-scale phases) and sender-independent; probed 2026-10-13 during a failing phase. Real estimation is kept — it is also the early-revert detector. The same pinning applies to every `eth_call` in the transaction path (NAV shield simulations, cross-chain NAV sim, HyperEVM/Lighter precompile reads): on Lighter Devnet a bare call intermittently false-positives `TRADE_REVERTS`, which previously leaked a `gas: "0x0"` transaction to the wallet (Lighter's sequencer rejects gas-0 at submission with "gas-limit-derived pubdata budget is below intrinsic pubdata bytes"). Every manually signable transaction must carry a real server-side estimate — never `0x0`.

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

Testnets (only shown when testnet mode is on):

| Chain | ID | Short name | Notes |
|-------|----|------------|-------|
| Sepolia | 11155111 | `sepolia` | |
| Lighter Devnet | 19529 | `lighter` | Axiom/OpenVM EVM-equivalent rollup, private devnet — RPC and explorer endpoints are private devnet URLs injected via env vars (`LIGHTER_RPC_URL`, `LIGHTER_DEVNET_BROWSER_URL`), never hardcoded. No sponsored gas, oracle, or DEX support. Hosts Lighter Core perp trading through the ALighter vault adapter (USDC-only; see below). |

---

## Lighter (HyperEVM-style) perps on Lighter Devnet

Smart pools trade Lighter Core perps through the `ALighter` vault adapter on chain 19529 —
USDC-only, mirroring the Hyperliquid integration. Tools (all gated to chain 19529, manual
owner-signed execution only in v1):

- `lighter_get_positions`, `lighter_get_markets`, `lighter_get_request_status` — reads (positions
  report never shows resting orders — only order counts exist on-chain).
- `lighter_deposit` / `lighter_withdraw` — `sendToCore` / `sendToEvm`. **NAV-neutral** for the
  NAV shield (raw-tx simulation, code `NAV_NEUTRAL`), like Hyperliquid deposits/spot sends.
  The first deposit auto-creates the vault's Core master account — no activation step.
- `lighter_limit_order` / `lighter_market_order` / `lighter_cancel_order` /
  `lighter_cancel_all_orders` — `createOrder`/cancels. **Trading: the standard NAV shield
  applies, never exempt.** Every order is hard-gated in the builder against the market's
  on-chain minimums (READ_CORE 0x0005 `minBaseAmount` / `minQuoteAmount`, 6-dec USDC) —
  below them Core would accept and cancel at matching. Margin adequacy is a handler WARNING
  only (notional × assumed 20% initial margin vs Core collateral): the market-default IMF
  is not readable on-chain and maker orders are not margin-rejected at placement.
- `lighter_track_market` / `lighter_untrack_market` — pool-owner market tracking. The on-chain
  `trackMarket(uint16)` resolves size/price decimals from the adapter's own LighterConstants table
  (never calldata, never user input); the pool's `getLighterTrackedMarkets()` view (0x5239dd83)
  exposes the tracked markets WITH those decimals and is the operator's only source for both.

Lighter Core writes are **asynchronous**: a successful EVM transaction only means Core accepted
the request — always surface the reqId and point to `lighter_get_request_status`; never claim an
order filled (an IOC/market order against an empty book is cancelled — the devnet ships without
market makers). All Core state reads go through the READ_CORE precompile via `LIGHTER_RPC_URL` —
no external Core REST API, no operator-side ledger: tracked markets and decimals come from the
pool's on-chain view. The position read is a raw 8-word tuple WITH the leading
int64 `lastFundingRatePrefixSum` the docs show (post-upgrade build; the
pre-upgrade build served 7 words without it — decoding that build with the
8-word table misaligns every field, and vice versa). The two order-count
fields are in docs order: word4 = currently open order count, word5 =
position-tied (SL/TP) order count. The positions report shows per-position
Entry and Mark price columns — Entry is derived by inverting `entryQuote`
(`entryPrice = entryQuote × 10^(sizeDecimals+priceDecimals) / (|size| × 1e6)`),
Mark comes from the market-info read; liquidation price is NOT available
on-chain (not part of the READ_CORE position tuple).
**Funding is NOT part of on-chain NAV.** `LighterLib.getLighterBalances`
(v3-contracts `feat/lighter-evm`) computes NAV as `collateralBaseAmount` +
Σ `_positionValueUsdc` (mark value − entry notional, + isolated margin) +
the in-flight transfer adjustment — the position tuple's
`lastFundingRatePrefixSum` is never consumed. Core itself accrues funding into
collateral continuously, so the Core REST API's collateral (e.g. 30.003768) and
the on-chain NAV read (30.000000) legitimately diverge by the funding amount;
the positions report's "Value (PnL + iso margin)" column is mark-vs-entry PnL
only and matches the on-chain figure. Adding funding to NAV is protocol work:
the prefix sum AT ENTRY is not stored anywhere readable, so it cannot be
reconstructed from READ_CORE alone — ALighter/LighterLib would have to snapshot
it at position open. Lighter has no
GTC — a resting limit order is `timeInForce = GTT` with a 5min…30d expiry; margin is always
cross (the EVM entrypoint has no margin-mode field) at the market-default initial margin
fraction, which is not readable on-chain. Resting maker orders are NOT margin-rejected at
placement (Core accepts and may cancel them at matching time instead), so unfillable orders
can sit on the book. A full open-order LIST is impossible on-chain (READ_CORE has no
order-listing query; Lighter confirmed 2026-10-21 that EVM-readable order state is a future
release). The Core REST API (private devnet URL — injected via the
`LIGHTER_CORE_API_URL` env var, never hardcoded, never written down in docs
or the repo) was probed 2026-10-21:
- `GET /api/v1/account?by=index&value=<accountIndex>` is **unauthenticated** and rich —
  collateral, available balance, `positions[]` (avg entry, position value, unrealized PnL,
  liquidation price, margin mode, allocated margin), `assets[]`, total asset value. Resolve
  the index on-chain via READ_CORE 0x0009 (EVM address → master account index) — `by=evm_address`
  is rejected, `by=l1_address` works. On-chain NAV-relevant reads stay on READ_CORE; this
  endpoint may supplement them (note: its collateral includes funding accrual, on-chain
  `collateralBaseAmount` does not — e.g. 30.003768 vs 30.000000).
- `GET /api/v1/accountOrders?account_index=…` requires an auth token signed by a **per-account**
  registered Schnorr API key (indices 4–254 per account; 0–3 reserved, 255 = all). There is
  **no generic key** that reads any account, and keys can only be registered through
  `EvmToCoreEntrypoint.changePubKey(accountIndex, apiKeyIndex, pubKey)` — which routes via
  `writeToCore(msg.sender, …)`, so only the account's controlling address (for a pool: the
  vault, via a whitelisted adapter method) can register one. Do not add a server-held key
  dependency; order-list UI stays on order counts + client order indexes until the protocol
  exposes key registration (ALighter `changePubKey` + Schnorr signing in the worker) or Lighter
  ships EVM-readable order state.
- **The devnet RPC has hang phases (observed 2026-10-20):** it intermittently accepts
  connections and never responds (no HTTP status, no reset — same time-dependent failure
  family as HyperEVM's unattached-state phases, but a full hang instead of a revert). viem's
  10s transport timeout fires and rejects the caller, but the abandoned fetch stays dangling;
  when it eventually errors it surfaced as an unhandled rejection that KILLED the production
  isolate — every subsequent request on it returned Cloudflare error 1101 ("Worker hung")
  while fresh isolates served 200, i.e. an intermittent 1101 cascade. Hardening in
  `services/rpcClient.ts`: `instrumentedFetch` attaches a no-op `.catch` to every RPC fetch
  (a late rejection from an abandoned fetch can never kill an isolate again) and non-Alchemy
  transports (Lighter) use `retryCount: 0` so a hang phase fails in one bounded 10s attempt
  instead of stacking retries. Poisoned isolates do not self-heal promptly — recovery is a
  fresh deployment (new isolate pool) or forcing new isolates via concurrent load.

---

## Authentication & Sessions

**Why:** a captured `(address, signature, timestamp)` triple used to be a replayable
bearer token — anyone holding it could skip x402 payment on every protected route for
24h from any IP. Signatures are now **single-use redemptions** (KV-gated; without KV the
legacy behavior remains, dev/test only):

1. First presentation of a valid signature → the middleware redeems it (KV record
   `sess-redeem:<sha256(sig)>`, TTL = the signature's remaining validity) and mints an
   opaque 256-bit **session token** (KV `sess:<sha256(token)>`, 24h TTL), returned as the
   `X-Session-Token` response header. Only the session token skips payment afterwards; a
   redeemed signature is worthless to an eavesdropper.
2. Sessions are **bound to a salted hash of (IP, User-Agent)** (`computeNetworkHash` —
   only the hash is stored, never raw IPs/UA). A token presented from a different network
   gets 401; the client re-signs (one wallet prompt when roaming) and receives a fresh
   session bound to the new network.
3. Redemption is **idempotent per network**: re-presenting the same signature from the
   same network re-issues the SAME session (concurrent page-load requests share one
   signature). The same signature from a different network is rejected (401) — this is
   the remaining bounded exposure: a signature captured AND redeemed before the victim's
   own redemption, from the victim's exact IP+UA, yields a working session until TTL.
4. Routes consume the session via `c.get("operatorAuth")` with `viaSession: true` and
   must call `verifyOperatorOwnership` (ownership only, no signature) instead of
   `verifyOperatorAuth`. Body-signature auth remains as a fallback for legacy clients but
   is ignored when a session auth is present.
5. Rate limiting is unchanged: 100 requests / 4h per operator address on non-paid
   requests. Expired/invalid credentials return 401 (never 402) so clients re-sign
   instead of paying.

**Frontend contract:** `apiHeaders()` sends `X-Session-Token` when one is cached
(localStorage `rigoblock_session_<address>`) and omits the signature headers; any
response carrying `X-Session-Token` is captured (`captureSessionToken`), and a 401
clears the session + cached signature and runs the existing re-sign flow.

**Why not longer-lived signatures or device trust:** browsers expose no trustworthy
device signal (fingerprints are spoofable/unstable). The 24h signature stays the root
proof; UX continuity comes from the session token, not from "trusting" a device.

**Telegram pairing hardening** (`services/telegramPairing.ts`): the 6-char (30-bit)
code is single-use with a 5-minute TTL, and verification is now throttled per Telegram
user ID — 5 failed attempts lock pairing for that user for 15 minutes (KV
`tg-pairatt:<userId>`), so online brute force needs ~10⁷ requests per code with each
guess costing a real Telegram message. Telegram routes (`/api/telegram/*`) are excluded
from x402 and authenticate via the webhook secret + Telegram's `from.id`; paired users
keep working across this upgrade with no re-pair (no storage format changed). The
execution confirm buttons in Telegram remain the last line of defence for delegated
execution; the webhook secret is the security boundary — rotate it if it may have leaked.

---

## Code Discipline

Rules for every code change to this service:

1. **No fallbacks, no special-case layers.** If a method produces wrong results, fix the root cause or replace the method. Do not wrap it in cross-checks, alternate-path retries, or "best effort" branches that guess. (Example: the NAV shield uses `eth_call` of `multicall([tx, updateUnitaryValue])` from the actual executor — the same primitive real execution uses — because `eth_simulateV1` produces synthetic-block false positives on Nitro chains. There is no simulator cross-check fallback.)
2. **Deterministic validation lives in tools/services, not in the LLM.** Amounts, tolerances, routes, and safety checks are computed in code; the LLM only routes to the right tool.
3. **User-facing text uses only labels and numbers the code knows.** Never raw function selectors, snake_case tool names, or guessed causes (a raw revert selector is acceptable only when the revert cannot be decoded). If a fact is unavailable, say what is known instead of inventing it.

---

## Composability Model

`/api/chat` is an **atomic operations provider**. Each request handles one operation.

**The chat endpoint handles one per request:** spot swaps, GMX perpetuals, Hyperliquid perpetuals, Lighter perpetuals, Uniswap v4 LP, GRG staking, cross-chain bridge/transfer/sync, vault info, pool creation/funding/NAV update, delegation setup/revoke/status, TWAP orders, strategies, chain switch.

**It does NOT handle:** multi-step orchestration, historical data, APR/APY estimates, lending protocols, arbitrary on-chain reads, or token approvals (the vault adapter handles approvals internally).

Orchestrator agents should plan externally, query our API for reads, execute one step per call, and iterate.

---

## Vault Management Tools

`deploy_smart_pool`, `fund_pool` (allowance-aware two-step approve→mint; mint is NAV-neutral), `upgrade_pool`, and `update_nav` — an owner-signed `updateUnitaryValue()` that recomputes and stores the pool's unitary value on-chain (the chat's `get_vault_info` NAV display reads the same `eth_call`, so the two reconcile). The `update_nav` preview shows the exact value the on-chain log will record (unitary value, 18 decimals; net total value on pool-token decimals). It is the kill-switch counterpart for operators: run it after rebalances to persist a fresh reference NAV before trading.
