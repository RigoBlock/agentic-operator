# CLAUDE.md — Project-Wide Instructions for AI Assistants

> This file defines **mandatory rules** for any AI agent (Claude, Copilot, etc.)
> modifying code in this repository. Violating these rules may cause **real
> financial loss** to users. Read this BEFORE making any change.

---

## Project Overview

**Rigoblock Agentic Operator** — a Cloudflare Worker (Hono) that gives AI agents
safe access to DeFi trading on Rigoblock smart pool vaults. Deployed at
`trader.rigoblock.com`.

Three access layers, each with distinct security boundaries:

| Layer | What it protects | Who controls it |
|-------|-----------------|-----------------|
| **Vault contract** (on-chain) | Pool assets, delegation mapping, allowed selectors | Vault owner (operator) |
| **Agent execution** (this Worker) | NAV shield, gas caps, delegation checks, auth | Cloudflare secrets + code |
| **x402 payment gate** (HTTP) | API access, pricing, settlement | CDP facilitator + our middleware |

---

## ABSOLUTE SECURITY RULES

### 1. Delegated execution REQUIRES proven vault ownership

```
RULE: No code path may allow delegated (auto-execute) mode without
      verifying the caller is the vault owner via signature + on-chain check.
```

- `operatorVerified` must be `true` before `executionMode` can be set to `"delegated"`.
- x402 payment is an **API access fee**, NOT an authorization to operate vaults.
- These are independent: a request can have x402 payment AND operator auth, OR just one.
- **NEVER** use `x402Paid` as a substitute for operator authentication.

**Why:** A malicious agent with $0.01 could trigger trades on any delegated vault,
enabling sandwich attacks that extract ~10% per day within NAV shield limits.

### 2. NAV shield must NEVER be bypassed, weakened, or skipped

```
RULE: The NAV shield (10% max drop check) runs BEFORE every transaction
      is returned or broadcast — for ALL transaction types including swaps,
      LP operations, AND cross-chain bridges. It protects ALL execution modes:
        - Manual: runs when building unsigned calldata (preCheckNavImpact in client.ts)
        - Delegated: runs BOTH when building calldata AND at broadcast time (execution.ts)
      It is outside the agent's control surface. Do NOT add code paths that skip it.
      When NAV can be measured: FAIL-CLOSED (block if drop > threshold).
      When NAV cannot be measured: graceful degradation (proceed with warning).
      When the NAV shield produces incorrect results, FIX THE ROOT CAUSE
      (correct the NAV reading method, adjust thresholds, fix edge cases).
      NEVER skip or bypass the shield to avoid errors.
```

- **Pre-check** (`preCheckNavImpact()` in `client.ts`): runs before returning unsigned
  calldata from any tool that builds vault transactions. Blocks toxic transactions
  before the user sees them.
- **Broadcast check** (`checkNavImpact()` in `execution.ts`): runs before delegated
  broadcast. Belt-and-suspenders — catches changes between building and broadcasting.
- Both call the same `checkNavImpact()` from `navGuard.ts`
- It simulates atomically via `multicall([tx, updateUnitaryValue])` on the RPC
- **Uses `updateUnitaryValue()`** (the actual contract NAV algorithm via `eth_call`),
  NOT `getNavDataView()`. The view function (ENavView) has an edge case bug where it
  returns `unitaryValue=0` when `effectiveSupply > 0` AND `totalValue <= 0`, while
  the actual contract (`_updateNav` in MixinPoolValue) preserves the stored value.
- **Simulation runs as the OPERATOR (vault owner)**, not the agent wallet.
  Reason: `multicall` is intentionally NOT in the agent's delegated selectors
  (delegating it would let the agent compose arbitrary vault calls). The operator
  is always authorized, so the multicall succeeds. This is NOT a shortcut — the
  actual trade is still broadcast by the agent using only its whitelisted selectors.
- Three distinct outcomes with separate error codes:
  1. **NAV drops > 10%** → `allowed: false, code: 'BLOCKED'` → `NAV_SHIELD_BLOCKED`
  2. **Swap itself reverts** → `allowed: false, code: 'TRADE_REVERTS'` → `SIMULATION_FAILED`
  3. **Multicall fails but swap passes** → `allowed: true, verified: false, code: 'UNVERIFIED'`
     — the trade is valid but NAV impact couldn't be measured. This should NOT be the
     normal path (investigate if it fires — likely an adapter or RPC issue).
- If the pre-swap NAV read fails → BLOCK (not skip)
- **NEVER** add `multicall` to `ALLOWED_VAULT_SELECTORS` / delegated selectors
- **NEVER** add a flag, env var, or config to disable the NAV shield entirely
- **NEVER** skip the NAV shield for any transaction type (including bridges)
- **NEVER** confuse "trade reverts" with "NAV shield blocked" — use the correct error code
- When something doesn't work, the effort must be in **fixing it**, not skipping it

#### Cross-chain bridges and the NAV shield

Cross-chain operations (`depositV3`) use the same NAV shield as all other transactions.
Transfer and Sync are **fundamentally different** despite using the same Across interface:

| Aspect | Transfer (`OpType.Transfer`) | Sync (`OpType.Sync`) |
|--------|------------------------------|----------------------|
| Virtual supply | Updated (burns on source, mints on destination) | NOT updated |
| Source NAV impact | Preserved (effectiveSupply decreases with value) | Drops (tokens leave, supply unchanged) |
| NAV shield behavior | `updateUnitaryValue()` returns stored value → no drop | Source-chain NAV drops → threshold applies |
| On-chain protection | NavImpactLib + EffectiveSupplyTooLow | navToleranceBps parameter |

**Do NOT conflate Transfer and Sync.** They behave completely differently based on
the `opType` parameter passed to `depositV3`. The NAV shield correctly handles both
because `updateUnitaryValue()` produces the same result as the actual contract.

### Swap Shield (Oracle Price Protection)

```
RULE: The Swap Shield compares DEX API quotes against the on-chain BackgeoOracle
      TWAP price. It runs BEFORE calldata is built (price-level check).
      It is INDEPENDENT of the NAV shield (value-level check). Both run on every swap.
      The operator can temporarily disable it (10-minute TTL) but it auto-re-enables.
      When the oracle has no price feed for a token, the shield degrades gracefully
      (allows the swap with a warning, does NOT block).
```

- **Service**: `src/services/swapShield.ts`
- **Uses**: `vault.convertTokenAmount(tokenIn, amountIn, tokenOut)` via `eth_call`
  — the vault's EOracle extension, which uses the BackgeoOracle 5-minute TWAP
- **Normalization**: ETH, WETH, address(0), and 0xEeee... all map to address(0)
- **DEX quote comparison**: The shield compares the DEX expected output directly
  against the oracle amount. It does **not** reverse `slippageBps` to derive a
  separate theoretical market price before applying thresholds.
- **Divergence calculation**: `(oracleAmount - dexOut) / oracleAmount`
  — two-sided, asymmetric rule: blocks when DEX gives >5% LESS than oracle
  (bad deal for user) AND when DEX gives >10% MORE than oracle (stale oracle
  or manipulated route that could expose the vault to sandwich attacks)
- **Default thresholds**: 5% worse than oracle → blocked; 10% better than oracle → blocked
- **Three outcomes**:
  1. `allowed: true` — divergence within threshold
  2. `allowed: false, code: 'BLOCKED'` — divergence exceeds threshold
  3. `allowed: true, code: 'NO_PRICE_FEED'` — oracle has no feed (graceful degradation)
- **Opt-out**: KV key `swap-shield-disabled:{operator}:{vault}` with 600s TTL
- **TWAP suggestion**: When blocked, the error message suggests splitting the trade
  into a TWAP order to reduce price impact

#### Configurable slippage

Slippage is no longer hardcoded. Resolution priority:
1. Per-request `slippageBps` in the body (from frontend settings)
2. Stored operator preference in KV (`slippage:{operatorAddress}`)
3. Default: 100 bps (1%)

Clamped to [10, 500] bps (0.1% to 5%). The LLM CANNOT set slippage directly —
only the operator via the `set_default_slippage` tool or frontend settings.

### 3. Auth model — three independent layers

```
x402 payment    → "can the caller afford the API fee?"   (payment)
Operator auth   → "does the caller own this vault?"      (authorization)
On-chain deleg  → "has the vault delegated to our agent?" (capability)
```

All three must pass for delegated execution. For manual mode, only the first
(x402) or second (browser auth) is needed.

**Auth matrix for POST /api/chat:**

| x402 paid | Auth credentials | Mode allowed | Result |
|-----------|-----------------|--------------|--------|
| Yes | None | Manual only | Returns unsigned tx data |
| Yes | Valid signature | Manual or Delegated | Full access |
| No (exempt) | Valid signature | Manual or Delegated | Full access (browser/Telegram) |
| No (exempt) | None | — | 401 Rejected |
| No | None | — | 402 Payment Required |

### 4. Agent wallet keys are managed by CDP Server Wallet

```
RULE: Agent wallets are managed by Coinbase Developer Platform (CDP) Server Wallet.
      Private keys are generated and stored by CDP — they never exist in our code or KV.
      CDP_WALLET_SECRET authenticates with CDP for signing operations.
      Treat CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET as critical secrets.
```

- Each vault has a unique agent EOA created via `cdp.evm.getOrCreateAccount({ name })`
- CDP manages key generation, storage, and signing — keys never leave CDP infrastructure
- KV stores only metadata: agent address, delegated chains, vault address, creation time
- Signing happens via CDP's `EvmServerAccount` wrapped with viem's `toAccount()` for compatibility
- No local encryption/decryption of private keys — CDP handles all cryptographic operations
- CDP account names use format `vault:{vaultAddress}` for deterministic lookup

### 5. Strategy execution defaults to manual, supports autonomous

```
RULE: Cron-triggered strategies default to manual mode (notify via Telegram, 
      await operator confirmation). When the operator explicitly creates a 
      strategy with autoExecute: true, the strategy auto-executes in delegated
      mode — but ALL safety layers still apply (NAV shield, delegation checks,
      7-point validation, selector whitelist, slippage protection).
```

- `runDueStrategies()` checks each strategy's `autoExecute` flag
- Manual mode (default): `executionMode: "manual"`, LLM instructed "only describe"
- Autonomous mode: `executionMode: "delegated"`, LLM instructed to execute if safe
- Autonomous transactions go through the FULL execution pipeline (NAV shield, etc.)
- The operator must explicitly opt in to autonomous mode per strategy
- Auto-pause after 3 consecutive failures (both modes)
- `lastRecommendation` carries context between runs (capped at 500 chars)

---

## CODING RULES

### Security-Critical Code Paths

These files contain security-critical logic. Changes require extra care:

| File | What it guards |
|------|---------------|
| `src/routes/chat.ts` | Auth gate, execution mode resolution |
| `src/llm/client.ts` | NAV shield pre-check + Swap Shield for all swap calldata |
| `src/services/execution.ts` | 7-point validation, NAV shield at broadcast |
| `src/services/navGuard.ts` | NAV shield simulation and threshold check |
| `src/services/swapShield.ts` | Oracle price comparison, slippage storage, opt-out |
| `src/services/auth.ts` | Signature verification, vault ownership |
| `src/services/delegation.ts` | On-chain delegation state |
| `src/services/agentWallet.ts` | CDP Server Wallet (per-vault agent EOA via Coinbase) |
| `src/middleware/x402.ts` | Payment verification, exempt origins, settlement |
| `src/services/strategy.ts` | Strategy execution controls |

### When modifying auth or execution logic:

1. **Think about the attack:** "If I remove/change this check, what can a malicious caller do?"
2. **Assume the caller is adversarial.** External agents are untrusted by default.
3. **x402 payment ≠ trust.** Anyone can pay $0.01. Payment proves ability to pay, nothing else.
4. **Manual mode is the safe default.** When in doubt, return unsigned data.
5. **Delegated mode is a privilege.** It requires provable vault ownership + on-chain delegation.

### When adding new routes:

- If the route touches vault state → it MUST go through `verifyOperatorAuth()`
- If the route is behind x402 → it gets the `x402Paid` flag but this does NOT replace auth
- If the route returns calldata for a specific vault → manual mode is safe (caller must sign)
- **NEVER** create a route that executes transactions without auth

### General coding standards:

- No module-level mutable state (Worker isolates are shared)
- Thread secrets via `env` parameter, never import from global
- Use `sanitizeError()` before returning error messages (strips API keys)
- Gas caps in `config.ts` are hard limits — never exceed them
- Token resolution is via `tokenResolver.ts` — always check return values

---

## ARCHITECTURE NOTES

### x402 Payment Flow

```
External Agent                    Our Worker                     CDP Facilitator
     │                                │                                │
     ├─── GET /api/quote ────────────►│                                │
     │◄── 402 + payment-required ─────┤                                │
     │                                │                                │
     ├─── GET /api/quote ────────────►│                                │
     │    + X-PAYMENT header          │── verify payment ─────────────►│
     │                                │◄── payment valid ──────────────┤
     │                                │                                │
     │                 [route handler runs]                             │
     │                                │                                │
     │                                │── settle (only on 2xx) ───────►│
     │◄── 200 + PAYMENT-RESPONSE ────┤◄── settlement receipt ─────────┤
```

### Delegation Execution Flow

```
                    Auth verified?  ──No──►  Manual mode (unsigned tx)
                         │
                        Yes
                         │
                    Delegation active? ──No──► Manual mode
                         │
                        Yes
                         │
                    ┌─── 7-point validation ───┐
                    │ 1. Config exists + enabled │
                    │ 2. Target == vault address │
                    │ 3. Selector in allow list  │
                    │ 4. Agent wallet matches    │
                    │ 5. eth_call simulation OK  │
                    │ 6. Balance sufficient      │
                    │ 7. Gas within caps         │
                    └───────────┬───────────────┘
                                │
                    NAV Shield check (10% max drop)
                                │
                           ──Pass──► Broadcast tx
                           ──Fail──► BLOCK + return reason
```

---

## KNOWN ATTACK VECTORS (defend against these)

1. **Vault impersonation via x402:** Attacker pays x402, passes someone else's
   vaultAddress with `executionMode: "delegated"`. **Mitigated:** delegated mode
   requires `operatorVerified === true` (signature + on-chain ownership check).

2. **Sandwich via delegated agent:** Attacker triggers swap on a vault with poor
   slippage, sandwiches it on-chain. **Mitigated:** NAV shield blocks trades that
   drop unit value > 10%. Slippage defaults to 1% (100bps).

3. **NAV shield bypass via multicall failure:** If `multicall` simulation fails
   (vault doesn't support it on a given chain), the shield tries the swap alone
   as a diagnostic. If the swap itself reverts → `SIMULATION_FAILED` (trade is
   bad). If the swap passes → execution proceeds with `verified: false` (NAV
   impact unknown). The 10% check is a safety net that only activates when
   multicall simulation is available.

4. **Agent wallet key compromise:** Attacker with CDP credentials could sign as
   agent wallets. **Mitigated:** CDP manages keys server-side; credentials are
   Cloudflare secrets (encrypted at rest). Delegation is always revocable by vault
   owner. Agent can only call whitelisted selectors on the vault.

5. **Strategy takeover:** If an attacker deploys malicious code to the Worker, they
   can modify strategies to execute harmful trades. **Mitigated:** Strategies default
   to manual mode (notify only). Even autonomous strategies go through the full
   execution pipeline (NAV shield, delegation checks, selector whitelist). The vault
   contract enforces these constraints on-chain.

6. **Prompt injection via user messages:** Attacker crafts message to trick the LLM
   into calling dangerous tool functions. **Mitigated:** Tool functions have
   deterministic implementations (no eval/exec). NAV shield catches value-destroying
   operations regardless of how they were triggered.

---

## FILE STRUCTURE (security-relevant)

```
src/
  index.ts              ← App entry, middleware chain, route mounting
  config.ts             ← Chain config, gas caps, token maps, resolveChainId
  types.ts              ← Env, AppVariables, type definitions
  middleware/
    x402.ts             ← Payment gate (MUST NOT grant auth)
  routes/
    chat.ts             ← Auth gate + execution mode (CRITICAL)
    quote.ts            ← Price quotes (safe — no vault mutation)
    delegation.ts       ← Delegation management endpoints
    gasPolicy.ts        ← Gas sponsorship policy (Alchemy)
    telegram.ts         ← Telegram webhook handler
  services/
    auth.ts             ← Signature verification + vault ownership
    execution.ts        ← 7-point validation + NAV shield + broadcast
    navGuard.ts         ← NAV shield simulation (10% threshold)
    swapShield.ts       ← Oracle price comparison, slippage storage, opt-out
    delegation.ts       ← Delegation state management
    agentWallet.ts      ← CDP Server Wallet (per-vault agent EOA via Coinbase)
    strategy.ts         ← Cron strategies (manual default, autonomous opt-in)
    uniswapTrading.ts   ← Uniswap quote/swap building
    zeroXTrading.ts     ← 0x aggregator integration
    gmxTrading.ts       ← GMX perpetuals
    crosschain.ts       ← Cross-chain bridging
    tokenResolver.ts    ← Dynamic token address resolution
    vault.ts            ← On-chain vault reads
    bundler.ts          ← ERC-4337 bundler (gas sponsorship)
  llm/
    client.ts           ← LLM provider resolution (DeepSeek R1 reasoning + Llama 3.3 fast → user key → OpenAI fallback)
    tools.ts            ← Tool definitions (55+) + system prompt
public/
  index.html            ← Chat UI + wallet connect
  openapi.json          ← OpenAPI spec
```

---

## EXTERNAL AI REFERENCES

### Uniswap AI Tools

When working on Uniswap v4 integration — especially LP positions, hooks, swap
routing, or contract addresses — consult the **Uniswap AI** repository:

- **Repo:** https://github.com/Uniswap/uniswap-ai
- **Trading plugin:** `packages/plugins/uniswap-trading` — swap integration,
  Trading API, Universal Router, supported chains
- **Hooks plugin:** `packages/plugins/uniswap-hooks` — v4 hook development,
  security foundations, threat models
- **Official deployments:** https://docs.uniswap.org/contracts/v4/deployments

**CRITICAL:** Uniswap v4 contract addresses (PoolManager, PositionManager,
Universal Router) are **different on every chain**. Never hardcode a single
address — always use per-chain lookup maps. The Ethereum address does NOT work
on Arbitrum, Base, Optimism, etc.

The `uniswapLP.ts` service maintains per-chain address maps for both
`POOL_MANAGER` and `POSITION_MANAGER`. When adding new chain support, get the
addresses from the official deployments page above.
