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

### 2. NAV shield must NEVER be bypassed or weakened

```
RULE: The NAV shield (10% max drop check) runs BEFORE every swap transaction
      is returned or broadcast. It protects ALL execution modes:
        - Manual: runs when building unsigned calldata (preCheckNavImpact in client.ts)
        - Delegated: runs BOTH when building calldata AND at broadcast time (execution.ts)
      It is outside the agent's control surface. Do NOT add code paths that skip it.
      When NAV can be measured: FAIL-CLOSED (block if drop > threshold).
      When NAV cannot be measured: graceful degradation (proceed with warning).
```

- **Pre-check** (`preCheckNavImpact()` in `client.ts`): runs before returning unsigned
  calldata from `build_vault_swap`. Blocks toxic swaps before the user sees them.
- **Broadcast check** (`checkNavImpact()` in `execution.ts`): runs before delegated
  broadcast. Belt-and-suspenders — catches changes between building and broadcasting.
- Both call the same `checkNavImpact()` from `navGuard.ts`
- It simulates atomically via `multicall([swap, getNavDataView])` on the RPC
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
- **NEVER** confuse "trade reverts" with "NAV shield blocked" — use the correct error code

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

- Each vault has a unique agent EOA, encrypted with WdkSecretManager (XSalsa20-Poly1305, v3+)
- Passkey = `${AGENT_WALLET_SECRET}:${vaultAddress.toLowerCase()}` — per-vault key isolation
- Salt = 16-byte random (stored alongside ciphertext in KV); seed stored as 16-byte BIP-39 entropy
- Legacy wallets (v0–v2) decryptable via AES-256-GCM fallback; new wallets always use v3
- Compromising AGENT_WALLET_SECRET + KV = all agent wallets compromised
- Rotation via `rotateAgentWalletKey()` — decrypt old (any version), re-encrypt new (v3)

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

### 6. User wallet is self-custodial — server never stores seed or password

```
RULE: The self-custodial wallet (browser UI) uses an encrypted keystore model.
      The server generates the seed (via WDK) but NEVER stores it. The password
      NEVER leaves the browser. Do NOT add code that persists plaintext seed
      phrases or passwords on the server side.
```

- **Creation**: Done entirely in the browser — `wdkSaltGenerator.generate()` creates a
  16-byte random salt → Web Crypto PBKDF2-SHA256 (100k iterations) derives a 32-byte key →
  `WdkSecretManager.generateAndEncrypt(null, derivedKey)` generates random entropy and
  encrypts it with XSalsa20-Poly1305 (libsodium) → address derived via
  `WalletAccountEvm.fromSeed()` → v2 keystore `{ version: 2, address, salt (hex),
  encryptedEntropy (hex) }` stored in `localStorage` → seed shown once for backup → cleared.
  **No server call. Seed never leaves the browser tab.**
- **Import**: Done entirely client-side — `sm.mnemonicToEntropy(seedPhrase)` converts
  user's 12-word phrase to entropy → `generateAndEncrypt(entropy, derivedKey)` re-encrypts
  with the user's new password. NEVER touches the server.
- **Storage**: Encrypted keystore (v2) in browser `localStorage` — server has no copy.
  v1 keystores (AES-256-GCM) are still decryptable for backward compat.
- **Key derivation**: Uses Web Crypto `SubtleCrypto.deriveBits()` (PBKDF2-SHA256, 100k
  iterations) in the browser to produce a 32-byte key, then passes it directly as `derivedKey`
  to `WdkSecretManager`. This bypasses `bare-crypto.pbkdf2Sync` (unavailable in browser).
- **Signing**: Browser decrypts with password → entropy → mnemonic → creates WDK
  `WalletAccountEvm` (cached for session) → signs locally → private key never leaves browser.
  Unlock once per session (like MetaMask).
- **Browser WDK bundles**:
  - `public/wdk-evm.js` — `@tetherto/wdk-wallet-evm` (wallet + signer). `npm run build:wdk-browser`.
  - `public/wdk-secret-manager.js` — `@tetherto/wdk-secret-manager` (encryption).
    `npm run build:wdk-secret-manager`. Uses `scripts/bare-crypto-browser-shim.cjs` as
    a stub (never called — derivedKey is always passed pre-computed).
  Both loaded lazily via dynamic `import()`.
- **Gas sponsorship**: EIP-7702 split-signing — server calls `prepareCalls()` (no key needed)
  → browser signs → server calls `sendPreparedCalls()` (no key needed)
- **NEVER** add server-side storage of plaintext seeds, passwords, or decrypted keystores
- **NEVER** add a code path where the server decrypts a user's keystore
- **NEVER** add `pbkdf2Sync` to the browser environment — always use Web Crypto + pass
  `derivedKey` to WdkSecretManager methods that accept it

---

## CODING RULES

### Security-Critical Code Paths

These files contain security-critical logic. Changes require extra care:

| File | What it guards |
|------|---------------|
| `src/routes/chat.ts` | Auth gate, execution mode resolution |
| `src/llm/client.ts` | NAV shield pre-check for all swap calldata |
| `src/services/execution.ts` | 7-point validation, NAV shield at broadcast |
| `src/services/navGuard.ts` | NAV shield simulation and threshold check |
| `src/services/auth.ts` | Signature verification, vault ownership |
| `src/services/delegation.ts` | On-chain delegation state |
| `src/services/agentWallet.ts` | WDK wallet gen (BIP-39/BIP-44), encryption, decryption |
| `src/services/userWallet.ts` | Self-custodial wallet gen + encrypted keystore |
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

4. **Agent wallet key extraction:** Attacker with `AGENT_WALLET_SECRET` + KV read
   can decrypt all agent keys. **Mitigated:** Cloudflare secrets encryption at rest,
   KV access control. Key rotation available. Delegation is always revocable by
   vault owner.

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
    wallet.ts           ← Self-custodial wallet (create, prepare-tx, submit-signed)
    gasPolicy.ts        ← Gas sponsorship policy (Alchemy)
    telegram.ts         ← Telegram webhook handler
  services/
    auth.ts             ← Signature verification + vault ownership
    execution.ts        ← 7-point validation + NAV shield + broadcast
    navGuard.ts         ← NAV shield simulation (10% threshold)
    delegation.ts       ← Delegation state management
    agentWallet.ts      ← WDK wallet gen (BIP-39/BIP-44), encrypt/decrypt
    userWallet.ts       ← Self-custodial wallet gen + encrypted keystore (PBKDF2+AES-256-GCM)
    strategy.ts         ← Cron strategies (manual default, autonomous opt-in)
    uniswapTrading.ts   ← Uniswap quote/swap building
    zeroXTrading.ts     ← 0x aggregator integration
    gmxTrading.ts       ← GMX perpetuals
    crosschain.ts       ← Cross-chain bridging
    tokenResolver.ts    ← Dynamic token address resolution
    vault.ts            ← On-chain vault reads
    bundler.ts          ← ERC-4337 bundler (gas sponsorship)
  llm/
    client.ts           ← LLM provider resolution (AI binding default → user key → OpenAI fallback)
    tools.ts            ← Tool definitions (55+) + system prompt
public/
  index.html            ← Chat UI + wallet connect (self-custodial WDK wallet)
  wdk-evm.js            ← esbuild bundle of @tetherto/wdk-wallet-evm for browser
  wdk-secret-manager.js ← esbuild bundle of @tetherto/wdk-secret-manager for browser
scripts/
  patch-wdk-for-worker.cjs      ← Postinstall: patches WDK deps for Cloudflare Workers
  wdk-buffer-shim.js            ← Buffer polyfill for WDK browser bundles
  bare-crypto-browser-shim.cjs  ← bare-crypto stub (pbkdf2Sync never called when derivedKey passed)
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
