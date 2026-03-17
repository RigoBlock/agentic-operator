---
name: galactica-trader
description: Trade DeFi on Rigoblock vaults via autonomous AI execution. Uses Tether WDK for wallet creation, signing, and x402 USDT0 payments. Supports spot swaps (Uniswap, 0x), Uniswap v4 LP, GMX V2 perpetuals, cross-chain bridging (Across), and vault management across 7 EVM chains. Primary strategy: XAUT/USDT LP with impermanent loss hedge via GMX perps and cross-chain NAV sync.
metadata: {"openclaw":{"requires":{"env":[]},"optionalEnv":["RIGOBLOCK_VAULT_ADDRESS","SEED_PHRASE"],"primaryEnv":"RIGOBLOCK_VAULT_ADDRESS","emoji":"🏦","homepage":"https://trader.rigoblock.com"}}
---

# Rigoblock DeFi Operator

You have access to DeFi trading on Rigoblock smart pool vaults via two HTTP
endpoints at `https://trader.rigoblock.com`. All calls are paid with USDT0
via the x402 protocol using a WDK wallet.

This skill is **language-agnostic**: every operation is a plain HTTP request.
Use `curl`, `fetch`, `requests`, or any HTTP client your runtime provides.

## Wallet Setup (WDK)

The wallet is created, encrypted, and managed entirely by Tether's **WDK**:
- **`@tetherto/wdk-wallet-evm`** — wallet creation, BIP-39 seed, BIP-44 key derivation, signing
- **`@tetherto/wdk-secret-manager`** — seed encryption at rest (PBKDF2-SHA256 + XSalsa20-Poly1305)

### How It Works

**First run (agent auto-creates wallet):**
1. WDK generates a 12-word BIP-39 seed phrase (`getRandomSeedPhrase()`)
2. WDK Secret Manager encrypts the seed with a human-set passkey
3. Encrypted blob saved to `~/.openclaw/rigoblock-wallet.enc.json` (mode 0600)
4. Seed phrase shown ONCE for offline backup — then discarded from memory
5. Wallet loaded in memory via `SecureWalletSession` (ES private field `#wallet`)
6. The agent can sign (x402, auth, transactions) but **cannot read the private key**

**Subsequent runs (auto-unlock):**
1. `WALLET_PASSKEY` env var → WDK Secret Manager decrypts → wallet loaded
2. Agent runs 24/7 autonomously — no human interaction needed
3. If passkey is removed from env → agent can't start (human kill switch)

**Returning agent (restore from seed backup):**
- Provide the saved seed phrase → WDK recreates the same wallet deterministically

### Security Model

| Layer | Protection |
|-------|------------|
| At rest | WDK Secret Manager: PBKDF2 (100k iterations) + XSalsa20-Poly1305 |
| In memory | ES private class field (`#wallet`) — inaccessible from outside `SecureWalletSession` |
| LLM boundary | Tool functions return only signatures/addresses — never keys or seeds |
| Human control | Remove `WALLET_PASSKEY` env var, or revoke on-chain delegation |

### TypeScript SDK (Recommended)

```typescript
import { setupSecureClient } from "@rigoblock/openclaw-defi";
import path from "path";
import os from "os";

const result = await setupSecureClient({
  passkey: process.env.WALLET_PASSKEY!,  // human sets this once
  walletStorePath: path.join(os.homedir(), ".openclaw", "rigoblock-wallet.enc.json"),
  vaultAddress: process.env.RIGOBLOCK_VAULT_ADDRESS || "0x",
  chainId: 42161,
  executionMode: "delegated",
});

if (result.isNewWallet) {
  console.log("⚠️  BACKUP THIS SEED PHRASE:", result.seedPhraseBackup);
  console.log("Fund this address:", result.session.address);
}

// result.session.signOperatorAuth() → {signature, address, timestamp}
// result.client.chat(...) → x402 payment + API call, all automatic
```

**Funding (before the agent can operate):**
- USDT0 on Plasma → x402 API payment ($0.01/call)
- ETH on Ethereum (~$5) → gas for vault deploy + delegation tx + LP operations
- ETH on Arbitrum (~$1) → gas for hedge vault deploy + delegation tx

## Agent Bootstrap Flow (No Vault Yet)

If `RIGOBLOCK_VAULT_ADDRESS` is not set, the agent must bootstrap itself.

### Single-Chain Bootstrap

1. **Generate wallet** — WDK creates the wallet automatically on first run:
   - TypeScript: `setupSecureClient({ passkey, walletStorePath, ... })` creates + encrypts
   - Python: `Account.create_with_mnemonic(num_words=12)` (WDK-compatible BIP-39/BIP-44)
   - Store the seed phrase securely — WDK Secret Manager encrypts it at rest.
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

### Cross-Chain Bootstrap (Ethereum + Arbitrum)

For the LP + Hedge strategy (LP on Ethereum, hedge on Arbitrum), deploy a
vault on **each** operating chain:

1. **Generate ONE wallet** — the same address is the operator everywhere.
2. **Fund wallet** — ETH on Ethereum (~$5 for gas) + ETH on Arbitrum (~$1) + USDT0 on Plasma.
3. **Deploy vault on Ethereum** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Ethereum"`
   → sign and broadcast → save `VAULT_ADDRESS_ETHEREUM`.
4. **Deploy vault on Arbitrum** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Arbitrum"`
   → sign and broadcast → save `VAULT_ADDRESS_ARBITRUM`.
5. **Set up delegation on both** —
   - `"setup delegation on Ethereum"` (with `vaultAddress: VAULT_ADDRESS_ETHEREUM, chainId: 1`)
   - `"setup delegation on Arbitrum"` (with `vaultAddress: VAULT_ADDRESS_ARBITRUM, chainId: 42161`)
6. **Fund vault on Ethereum** — `"fund pool with 1 ETH"` (investors mint pool tokens here).
7. **Bridge to Arbitrum** — `"bridge 500 USDT from Ethereum to Arbitrum"`
   (via Across Protocol — delegated mode, vault-to-vault transfer for hedge collateral).
8. **Verify NAV** — `"get aggregated NAV"` shows balances on both chains.

**Important:** Vault addresses are different on each chain (separate deployments).
Track per-chain: `{chainId: vaultAddress}`.

**Cross-chain operations:**
- `crosschain_transfer` — bridge tokens between vaults via Across Protocol
- `crosschain_sync` — sync NAV data across chains (sends small msg + amount)
- `get_aggregated_nav` — shows vault NAV and balances on ALL chains at once
- `get_rebalance_plan` — computes optimal bridge ops to rebalance across chains

Using the TypeScript SDK (secure encrypted wallet):
```typescript
import { setupSecureClient } from "@rigoblock/openclaw-defi";
import path from "path";
import os from "os";

// Auto-creates on first run, auto-unlocks on subsequent runs
const { client, session, isNewWallet, seedPhraseBackup } = await setupSecureClient({
  passkey: process.env.WALLET_PASSKEY!,
  walletStorePath: path.join(os.homedir(), ".openclaw", "rigoblock-wallet.enc.json"),
  vaultAddress: "0xYourVault",
  chainId: 42161,
  executionMode: "delegated",
});
if (isNewWallet) console.log("BACKUP:", seedPhraseBackup);
```

Using the TypeScript SDK (plaintext seed — less secure, simpler):
```typescript
import { setupRigoblockClient } from "@rigoblock/openclaw-defi";

const { client, wallet, walletInfo } = await setupRigoblockClient({
  vaultAddress: "0xYourVault",
  chainId: 42161,
  executionMode: "delegated",
});
if (walletInfo) console.log("Save seed:", walletInfo.seedPhrase);
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
| **Wallet execution** | Key creation, seed encryption, signing, x402 payment | Tether WDK (`wdk-wallet-evm` + `wdk-secret-manager`) |
| **DeFi execution** | Trading, NAV shield, delegation, on-chain ops | Rigoblock API (`trader.rigoblock.com`) |

The agent decides *what* to do. WDK manages *who* signs. The API ensures *safe execution*.

- The agent **never** touches private keys directly — WDK creates and manages them
- The API **never** has the operator's private key — it verifies signatures
- The NAV shield **cannot** be bypassed by the agent — it runs server-side

## Environment Variables

- `RIGOBLOCK_VAULT_ADDRESS` — *(optional)* The vault contract address. If not set,
  the agent should deploy a new vault using the bootstrap flow above. For
  multi-chain, the agent tracks a separate vault address per chain.
- `SEED_PHRASE` — *(optional)* Existing WDK seed phrase. If not provided,
  a new wallet is created in-app on first use.

The agent specifies `chainId` per request — there is no default chain. Every
`/api/chat` call includes the target chain explicitly.

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

If you're using JavaScript/TypeScript, the
[GitHub repo](https://github.com/RigoBlock/agentic-operator) includes an `sdk/`
folder with a ready-made client (WDK wallet + x402 already wired together).

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

One strategy: XAUT/USDT LP + permanent hedge. **You decide** how to size
positions and when to rebalance — these are guidelines, not rigid scripts.
Full details in `{baseDir}/references/STRATEGIES.md`.

### XAUT/USDT LP + Permanent Hedge (Ethereum + Arbitrum)

**What it is:** Earn LP fees on the XAUT/USDT Uniswap v4 pool on Ethereum,
hedge all directional XAUT exposure with a 1x GMX short on Arbitrum.
The hedge is **always on** — it is not removed when funding costs money.
Yield = LP fees minus hedge cost.

**How it works:**
- **Ethereum vault (raise + LP):** Investors fund the vault on Ethereum
  (where the XAUT/USDT Uni v4 pool lives). Swap USDT → XAUT (0x aggregator
  for best price), add XAUT/USDT LP on Uni v4. Earn trading fees.
- **Arbitrum vault (hedge):** Bridge USDT collateral from Ethereum via Across
  (fills in seconds), convert to XAUT on Arbitrum, open 1x short XAUT/USD
  on GMX with XAUT as collateral. This offsets the LP's directional gold
  exposure permanently.
- **Cross-chain NAV sync:** Call `crosschain_sync` every ~8 hours AND on
  significant price deviations (>1% move). Sync more frequently if NAV
  deviation is large.

**Core principle:** The GMX short is the hedge for XAUT LP exposure.
Even when funding costs money, the hedge stays on. Removing it would
create unhedged directional XAUT exposure — that is speculation.

**Allocation:** You decide all amounts autonomously — maximize LP
allocation while maintaining sufficient GMX margin and a liquidity buffer.

**Monitoring:**
- Check positions every **5 minutes** (perp collateral can deteriorate fast)
- Rebalance hedge when coverage drifts > 2% from target
- Top up GMX margin if collateral is getting thin
- Sync NAV every ~8 hours (more often on significant deviation)

**Key steps (you sequence these):** get vault USDT → swap to XAUT → add LP →
bridge collateral to Arbitrum → swap to XAUT → open short hedge → monitor
both legs → sync NAV regularly.

**Risk:** Hedge cost reduces net yield when GMX funding is negative.
This is expected — the cost of maintaining hedged exposure.

### Cross-Chain NAV Sync

**Critical.** When the vault operates across Ethereum and Arbitrum,
NAV must be kept in sync:

- **Regular sync:** Call `crosschain_sync` every ~8 hours during normal
  conditions. More frequently if NAV deviation is significant.
- **Price deviation sync:** If XAUT price moves >1% since last sync,
  trigger an immediate sync. Stale NAV = inaccurate accounting.
- **Before rebalancing:** Always sync NAV before making allocation decisions
  across chains. Use `get_aggregated_nav` to see the full picture first.
- **After bridging:** Sync NAV after any cross-chain bridge operation
  completes (Across fills in seconds).

**Why this matters:** Investors can mint/burn vault tokens at any time.
If NAV is stale on one chain, the unit price is wrong — this could let
someone arbitrage the vault (mint cheap, burn expensive). Regular sync
prevents this.

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

For the optional TypeScript SDK with WDK wallet integration, see the `sdk/`
directory in the [GitHub repo](https://github.com/RigoBlock/agentic-operator).
