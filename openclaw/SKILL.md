---
name: rigoblock-defi
description: >
  Trade DeFi on Rigoblock vaults via autonomous AI execution. Uses Tether WDK
  for wallet creation, signing, and x402 USDT0 payments. Supports spot swaps
  (Uniswap, 0x), Uniswap v4 LP management, GMX V2 perpetuals, cross-chain
  bridging (Across), and vault management across 7 EVM chains. Two composable
  XAUT gold strategy templates — carry trade and LP+hedge — with autonomous
  capital efficiency optimization.
metadata: {"openclaw":{"requires":{"env":[]},"optionalEnv":["RIGOBLOCK_VAULT_ADDRESS","SEED_PHRASE","RIGOBLOCK_CHAIN_ID"],"primaryEnv":"RIGOBLOCK_VAULT_ADDRESS","emoji":"🏦","homepage":"https://trader.rigoblock.com"}}
---

# Rigoblock DeFi Operator

You have access to DeFi trading on Rigoblock smart pool vaults via two HTTP
endpoints at `https://trader.rigoblock.com`. All calls are paid with USDT0
via the x402 protocol using a WDK wallet.

This skill is **language-agnostic**: every operation is a plain HTTP request.
Use `curl`, `fetch`, `requests`, or any HTTP client your runtime provides.

## Wallet Setup (WDK-Compatible)

The agent creates its own wallet autonomously on first run — no manual setup,
no env vars, no pre-generated keys. The wallet follows the **WDK standard**:
BIP-39 mnemonic (12 words) + BIP-44 derivation (`m/44'/60'/0'/0/0`).

**How it works:**
1. Agent generates a 12-word BIP-39 seed phrase (same as WDK's `getRandomSeedPhrase()`)
2. Agent derives the private key via BIP-44 path `m/44'/60'/0'/0/0`
3. The resulting address becomes the vault operator
4. Agent stores seed phrase + private key for future sessions
5. The same seed phrase works in WDK (`@tetherto/wdk-wallet-evm`) or any
   BIP-39/BIP-44 compatible library (Python `eth_account`, ethers.js, etc.)

**Funding (before the agent can operate):**
- USDT0 on Plasma → x402 API payment ($0.01/call)
- ETH on Arbitrum (~$1) → gas for vault deploy + delegation tx
- ETH on Optimism (~$1) → gas for second vault deploy + delegation tx

**Returning agent:**
- Load the saved seed phrase → derive the same wallet deterministically

## Agent Bootstrap Flow (No Vault Yet)

If `RIGOBLOCK_VAULT_ADDRESS` is not set, the agent must bootstrap itself.

### Single-Chain Bootstrap

1. **Generate wallet** — create a BIP-39 seed phrase and derive the key:
   - Python: `Account.create()` or `Account.from_mnemonic(mnemonic)`
   - TypeScript: `WalletManagerEvm.getRandomSeedPhrase()` → `SeedSignerEvm`
   - Store the seed phrase and private key for future sessions.
2. **Deploy vault** — send: `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Arbitrum"`
   The API returns an unsigned `createPool()` transaction. Sign and broadcast it.
   The new vault address is in the transaction receipt logs.
3. **Store vault address** — persist the deployed vault address for future calls.
   Use it as the `vaultAddress` parameter in all subsequent `/api/chat` requests.
4. **Set up delegation** — send: `"setup delegation on Arbitrum"` to authorize the
   agent wallet. Sign and broadcast the returned `updateDelegation()` transaction.
5. **Fund the vault** — to provide trading capital, a separate wallet can mint
   pool tokens: send `"fund pool with 0.1 ETH"` from the operator wallet.
6. **Start trading** — the vault is now funded and delegated. Use delegated mode.

### Cross-Chain Bootstrap (Arbitrum + Optimism)

For multi-chain strategies (e.g., LP on one chain + hedge on another, or bridging
between chains for gas efficiency), deploy a vault on **each** operating chain:

1. **Generate ONE wallet** — the same address is the operator everywhere.
2. **Fund wallet** — ETH on Arbitrum (~$1) + ETH on Optimism (~$1) + USDT0 on Plasma.
3. **Deploy vault on Optimism** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Optimism"`
   → sign and broadcast → save `VAULT_ADDRESS_OPTIMISM`.
4. **Deploy vault on Arbitrum** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Arbitrum"`
   → sign and broadcast → save `VAULT_ADDRESS_ARBITRUM`.
5. **Set up delegation on both** —
   - `"setup delegation on Optimism"` (with `vaultAddress: VAULT_ADDRESS_OPTIMISM, chainId: 10`)
   - `"setup delegation on Arbitrum"` (with `vaultAddress: VAULT_ADDRESS_ARBITRUM, chainId: 42161`)
6. **Fund vault on Optimism** — `"fund pool with 0.1 ETH"` (Optimism has lower gas).
7. **Bridge to Arbitrum** — `"bridge 500 USDT from Optimism to Arbitrum"`
   (via Across Protocol — delegated mode, vault-to-vault transfer).
8. **Verify NAV** — `"get aggregated NAV"` shows balances on both chains.

**Important:** Vault addresses are different on each chain (separate deployments).
Track per-chain: `{chainId: vaultAddress}`.

**Cross-chain operations:**
- `crosschain_transfer` — bridge tokens between vaults via Across Protocol
- `crosschain_sync` — sync NAV data across chains (sends small msg + amount)
- `get_aggregated_nav` — shows vault NAV and balances on ALL chains at once
- `get_rebalance_plan` — computes optimal bridge ops to rebalance across chains

Using the TypeScript SDK:
```typescript
import { setupRigoblockClient } from "@rigoblock/openclaw-defi";

// New wallet (seed phrase generated automatically)
const { client, wallet, walletInfo } = await setupRigoblockClient({
  vaultAddress: "0xYourVault",
  chainId: 42161,
  executionMode: "delegated",
});
console.log("Save this seed phrase:", walletInfo.seedPhrase);

// Or load existing wallet
const { client } = await setupRigoblockClient({
  seedPhrase: "word1 word2 word3 ... word24",
  vaultAddress: "0xYourVault",
  chainId: 42161,
  executionMode: "delegated",
});
```

Using plain HTTP (no SDK):
```typescript
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { SeedSignerEvm } from "@tetherto/wdk-wallet-evm/signers";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

// 1. Create or load WDK wallet
const seedPhrase = WalletManagerEvm.getRandomSeedPhrase();
const signer = new SeedSignerEvm(seedPhrase, {
  provider: "https://rpc.plasma.to",
});
const account = await new WalletManagerEvm(signer, {
  provider: "https://rpc.plasma.to",
}).getAccount();

// 2. Wire up x402 payment (USDT0 on Plasma)
const x402 = new x402Client();
registerExactEvmScheme(x402, { signer: account });
const fetchWithPayment = wrapFetchWithPayment(fetch, x402);

// 3. Call the API — x402 handles payment automatically
const res = await fetchWithPayment("https://trader.rigoblock.com/api/quote?sell=ETH&buy=USDC&amount=1");
```

Using Python (Gumloop, LangChain, or any Python agent):
```python
from eth_account import Account
from eth_account.messages import encode_defunct
import requests, json, time

# 1. Agent creates its own wallet (WDK-compatible BIP-39/BIP-44)
account, mnemonic = Account.create_with_mnemonic(num_words=12)
# SAVE mnemonic — same seed works in WDK (@tetherto/wdk-wallet-evm)
print(f"Address: {account.address}")
print(f"Seed phrase: {mnemonic}")  # save securely for future sessions

# To restore in a future session:
# account = Account.from_mnemonic(mnemonic)

# 2. Sign operator auth for delegated mode
AUTH_MESSAGE = (
    "Welcome to Rigoblock Operator\n\n"
    "Sign this message to verify your wallet and access your smart pool assistant."
)
sig = account.sign_message(encode_defunct(text=AUTH_MESSAGE))

# 3. Call the API (x402 payment handled by your x402 client/skill)
response = requests.post(
    "https://trader.rigoblock.com/api/chat",
    headers={"X-PAYMENT": x402_payment_header, "Content-Type": "application/json"},
    json={
        "messages": [{"role": "user", "content": "swap 100 USDT for XAUT on Arbitrum"}],
        "vaultAddress": "0xYourVault",
        "chainId": 42161,
        "operatorAddress": account.address,
        "authSignature": sig.signature.hex(),
        "authTimestamp": int(time.time() * 1000),
        "executionMode": "delegated",
        "confirmExecution": True,
    },
)
result = response.json()
# result["executionResult"]["txHash"] → the on-chain tx hash
```

## Architecture Separation

The system enforces a clean separation between three layers:

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| **Agent reasoning** | Strategy selection, market analysis, sequencing | OpenClaw / Gumloop / any LLM agent |
| **Wallet execution** | Key creation, signing, x402 payment, auth | WDK-compatible BIP-39/BIP-44 (Tether WDK or `eth_account`) |
| **DeFi execution** | Trading, NAV shield, delegation, on-chain ops | Rigoblock API (`trader.rigoblock.com`) |

The agent decides *what* to do. WDK manages *who* signs. The API ensures *safe execution*.

- The agent **never** touches private keys directly — WDK creates and manages them
- The API **never** has the operator's private key — it verifies signatures
- The NAV shield **cannot** be bypassed by the agent — it runs server-side

## Environment Variables

- `RIGOBLOCK_VAULT_ADDRESS` — *(optional)* The vault contract address. If not set,
  the agent should deploy a new vault using the bootstrap flow above.
- `RIGOBLOCK_CHAIN_ID` — Default chain ID (optional, default: 42161 Arbitrum).
  This is the DeFi operations chain, not the payment chain.
- `SEED_PHRASE` — *(optional)* Existing WDK seed phrase. If not provided,
  a new wallet is created in-app on first use.

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
perps, bridging, vault info — everything. You send a message
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

### x402 Payment (USDT0 via WDK)

Every request that hits these endpoints without a valid `X-PAYMENT` header
returns `402 Payment Required` with a payment challenge. Your WDK wallet
signs a USDT0 payment on Plasma (or USDC on Base) and the x402 client
retries with the signed header automatically.

The WDK `WalletAccountEvm` satisfies the x402 `ClientEvmSigner` interface
directly — no adapter needed. See the Wallet Setup section above for code.

If you're using JavaScript/TypeScript, see `{baseDir}/sdk/` for a ready-made
client with WDK wallet + x402 already wired together.

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

### Vault Management
- Get vault info, check token balances, aggregated NAV across chains
- Examples: "show vault info on Arbitrum", "get aggregated NAV"

### Delegation Management
- Set up or revoke delegation to agent wallet
- Examples: "check delegation status", "setup delegation"

## Strategy Knowledge

You have access to two composable strategy templates plus a capital efficiency
optimizer. **You decide** when to use each one and how to combine them — these
are guidelines, not rigid scripts.
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

### Capital Efficiency Optimizer

**What it is:** Minimize idle cash across both strategies to maximize yield.

**Default allocation:** 80% AMM (LP), 10% GMX collateral, 10% cash reserve.
But you should optimize this continuously:

- **Monitor on-chain liquidity depth.** If LP pool depth is healthy (>2% of
  vault position), reduce cash reserve to ~2% and deploy the freed capital
  into LP or collateral for higher yield.
- **Divest when liquidity thins.** If available pool liquidity drops below
  0.1% of your position, pull back to a larger cash buffer to avoid slippage
  on exit.
- **Rebalance between strategies.** Compare carry trade funding yield vs
  LP+hedge net yield. Shift capital toward the higher-yielding strategy.
- **Never go to 0% cash.** Always keep at minimum 2% for rebalancing gas
  and emergency exits.

This creates a thinking loop: the agent constantly evaluates market conditions
and adjusts the split, maximizing productive capital while maintaining safety.

### Strategy Compositor

When asked to "optimize" or "run a DeFi strategy," gather data and score both:

1. **Funding rate data** → carry trade yield estimate
2. **LP fee data** → LP+hedge net yield
3. **Compare** and allocate: primary strategy gets 80-90% of deployable capital,
   secondary strategy gets the remainder, always keep ≥2% USDT reserve
4. **Optimize idle cash** — reduce reserves to 2% when conditions are stable,
   increase when liquidity drops. This is the agent's ongoing decision.

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

| Chain | ID | Spot | Perps | LP | Bridge |
|-------|----|------|-------|----|--------|
| Ethereum | 1 | ✓ | — | ✓ | ✓ |
| Base | 8453 | ✓ | — | ✓ | ✓ |
| Arbitrum | 42161 | ✓ | ✓ (GMX) | ✓ | ✓ |
| Optimism | 10 | ✓ | — | ✓ | ✓ |
| Polygon | 137 | ✓ | — | — | ✓ |
| BNB Chain | 56 | ✓ | — | — | ✓ |
| Unichain | 130 | ✓ | — | ✓ | — |

## Web Chat Alternative

The same API powers a **web chat** at `https://trader.rigoblock.com` with
additional UX benefits:

- **No local install** — works from any browser
- **Agent always on** — no need to keep a terminal open
- **Telegram integration** — receive strategy notifications and confirmations
- **Operator auth built-in** — sign once via MetaMask/WalletConnect

For hackathon evaluation, the web chat provides the fastest path to see the
system in action without installing anything locally.

## Reference Files

- `{baseDir}/references/STRATEGIES.md` — Detailed strategy entry/exit sequences and parameters
- `{baseDir}/references/CHAINS.md` — Chain-specific tokens, addresses, and capabilities
- `{baseDir}/references/SAFETY.md` — Full safety model and what agents cannot do
- `{baseDir}/references/API.md` — HTTP API specification with request/response examples
- `{baseDir}/sdk/` — TypeScript SDK with WDK wallet integration + x402 client + strategies
