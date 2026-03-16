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
| **Agent execution** (this Worker) | NAV guard, gas caps, delegation checks, auth | Cloudflare secrets + code |
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
enabling sandwich attacks that extract ~10% per day within NAV guard limits.

### 2. NAV guard must NEVER be bypassed or weakened

```
RULE: The NAV guard (10% max drop check) runs BEFORE every transaction broadcast.
      It is outside the agent's control surface. Do NOT add code paths that skip it.
      It is FAIL-CLOSED: if ANY step fails (RPC, simulation, decode), block the tx.
```

- `checkNavGuard()` in `execution.ts` calls `simulateNavImpact()` from `navGuard.ts`
- It simulates atomically via `multicall([swap, getNavDataView])` on the RPC
- If NAV drops > 10% vs the higher of pre-swap or 24h baseline → BLOCK
- If the pre-swap NAV read fails → BLOCK (not skip)
- If the multicall simulation fails → BLOCK (not skip)
- If ANY error occurs in the guard or its caller → BLOCK (no try/catch swallow)
- **NEVER** add a flag, env var, or config to skip the NAV guard
- **NEVER** add a catch block that allows execution to continue when the guard errors

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

### 4. Agent wallet secrets are the nuclear key

```
RULE: AGENT_WALLET_SECRET + KV read access = can decrypt ALL agent private keys.
      Treat AGENT_WALLET_SECRET with the same gravity as a root CA private key.
```

- Each vault has a unique agent EOA, encrypted with AES-256-GCM
- Encryption key = `HKDF(AGENT_WALLET_SECRET, salt=vaultAddress)`
- Compromising the secret + KV = all agent wallets compromised
- Rotation via `rotateAgentWalletKey()` — decrypt old, re-encrypt new

### 5. Strategy execution is observe-only by default

```
RULE: Cron-triggered strategies NEVER auto-execute transactions.
      They run in manual mode and notify the operator via Telegram.
```

- `runDueStrategies()` forces `executionMode: "manual"` regardless of delegation state
- The LLM is instructed: "Do NOT execute any transactions — only describe"
- Operator must explicitly reply in Telegram to trigger execution
- Auto-pause after 3 consecutive failures

---

## CODING RULES

### Security-Critical Code Paths

These files contain security-critical logic. Changes require extra care:

| File | What it guards |
|------|---------------|
| `src/routes/chat.ts` | Auth gate, execution mode resolution |
| `src/services/execution.ts` | 7-point validation, NAV guard call |
| `src/services/navGuard.ts` | NAV simulation and threshold check |
| `src/services/auth.ts` | Signature verification, vault ownership |
| `src/services/delegation.ts` | On-chain delegation state |
| `src/services/agentWallet.ts` | Key generation, encryption, decryption |
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
                    NAV Guard check (10% max drop)
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
   slippage, sandwiches it on-chain. **Mitigated:** NAV guard blocks trades that
   drop unit value > 10%. Slippage defaults to 1% (100bps).

3. **NAV guard bypass via multicall failure:** If `multicall` simulation fails
   (vault doesn't support it), the guard is permissive. **Mitigated:** normal
   `eth_call` simulation still catches reverts. The 10% check is a safety net on
   top of standard simulation.

4. **Agent wallet key extraction:** Attacker with `AGENT_WALLET_SECRET` + KV read
   can decrypt all agent keys. **Mitigated:** Cloudflare secrets encryption at rest,
   KV access control. Key rotation available. Delegation is always revocable by
   vault owner.

5. **Strategy takeover:** If an attacker deploys malicious code to the Worker, they
   can modify strategies to execute harmful trades. **Mitigated:** Strategies run in
   manual mode (notify only). Execution requires operator confirmation via Telegram.

6. **Prompt injection via user messages:** Attacker crafts message to trick the LLM
   into calling dangerous tool functions. **Mitigated:** Tool functions have
   deterministic implementations (no eval/exec). NAV guard catches value-destroying
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
    telegram.ts         ← Telegram webhook handler
  services/
    auth.ts             ← Signature verification + vault ownership
    execution.ts        ← 7-point validation + NAV guard + broadcast
    navGuard.ts         ← NAV simulation (10% threshold)
    delegation.ts       ← Delegation state management
    agentWallet.ts      ← Key gen/encrypt/decrypt/rotate
    strategy.ts         ← Cron strategies (manual-only)
    uniswapTrading.ts   ← Uniswap quote/swap building
    zeroXTrading.ts     ← 0x aggregator integration
    gmxTrading.ts       ← GMX perpetuals
    crosschain.ts       ← Cross-chain bridging
    tokenResolver.ts    ← Dynamic token address resolution
    vault.ts            ← On-chain vault reads
    bundler.ts          ← ERC-4337 bundler (gas sponsorship)
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
