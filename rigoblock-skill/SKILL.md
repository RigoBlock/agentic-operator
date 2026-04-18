---
name: rigoblock-trader
description: Trade DeFi on Rigoblock vaults via autonomous AI execution. Supports spot swaps (Uniswap, 0x), Uniswap v4 LP, GMX V2 perpetuals, cross-chain bridging (Across), and vault management across 7 EVM chains. x402 USDC payments on Base. STAR automated safety layer protects every transaction.
metadata: {"homepage":"https://trader.rigoblock.com"}
---

# Rigoblock DeFi Operator

You have access to DeFi trading on Rigoblock smart pool vaults via two HTTP
endpoints at `https://trader.rigoblock.com`. All calls are paid with USDC
on Base via the x402 protocol.

This skill is **language-agnostic**: every operation is a plain HTTP request.
Use `curl`, `fetch`, `requests`, or any HTTP client your runtime provides.

## Wallet Requirements

You need **your own wallet** — any EVM wallet that can:
1. Hold USDC on Base (for x402 API payments — $0.002–$0.01 per call)
2. Sign EIP-191 messages (for operator authentication in delegated mode)

Use whatever wallet SDK you prefer: viem, ethers.js, CDP, web3.py, etc.
The Rigoblock API does NOT create wallets for you.

### Agent Wallet vs Operator Wallet

| Wallet | Purpose | Who creates it |
|--------|---------|----------------|
| **Your wallet** (x402 payer) | Pays API fees in USDC on Base | You (the agent) |
| **Operator wallet** (vault owner) | Signs auth messages, owns the vault on-chain | You or a human operator |
| **Server-side agent wallet** | Executes delegated trades on the vault | Created automatically by CDP Server Wallet |

Your wallet and the operator wallet can be the same address.
The server-side agent wallet is created automatically when delegation is set up.

## Agent Bootstrap Flow (No Vault Yet)

If `RIGOBLOCK_VAULT_ADDRESS` is not set, the agent must bootstrap itself.

### Single-Chain Bootstrap

1. **Use your wallet** — any EVM wallet with USDC on Base (for x402 payments).
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

### Multi-Chain Bootstrap (BSC + Optimism + Arbitrum)

For the LP + Hedge strategy (LP + hedge both on Arbitrum, capital raised on BSC/Optimism):

1. **Use your wallet** — the same address is the operator everywhere.
2. **Fund wallet** — USDC on Base (x402 payments) + ETH on Arbitrum (~$1 for gas) + BNB on BSC (~$1).
3. **Deploy vault on BSC** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on BSC"`
   → sign and broadcast → save vault address.
4. **Deploy vault on Optimism** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Optimism"`
   (optional second capital chain) → sign and broadcast.
5. **Deploy vault on Arbitrum** — `"deploy a smart pool named 'AgentVault' with symbol 'AV' on Arbitrum"`
   → sign and broadcast.
6. **Set up delegation on all chains** —
   - `"setup delegation on BSC"` / `"setup delegation on Optimism"` / `"setup delegation on Arbitrum"`
7. **Fund vault** — investors mint pool tokens on BSC or Optimism (USDT as base token).
8. **Bridge to Arbitrum** — `"bridge USDT from BSC to Arbitrum"`
   (via Across Protocol — delegated mode, vault-to-vault transfer).
9. **Verify NAV** — `"get aggregated NAV"` shows balances on all chains.

**Important:** Vault addresses are different on each chain (separate deployments).
Track per-chain: `{chainId: vaultAddress}`.

**Cross-chain operations:**
- `crosschain_transfer` — bridge tokens between vaults via Across Protocol
- `crosschain_sync` — sync NAV data across chains (sends small msg + amount)
- `get_aggregated_nav` — shows vault NAV and balances on ALL chains at once
- `get_rebalance_plan` — computes optimal bridge ops to rebalance across chains

Using the TypeScript SDK (optional — typed API client):
```typescript
import { RigoblockClient } from "@rigoblock/defi-sdk";

const client = new RigoblockClient({
  baseUrl: "https://trader.rigoblock.com",
  vaultAddress: "0xYourVault",
  chainId: 42161,
  executionMode: "delegated",
  operatorAddress: "0xYourWallet",
  authSignature: "0x...",         // sign AUTH_MESSAGE with your wallet
  authTimestamp: Date.now(),
}, fetchWithX402Payment);           // your x402-wrapped fetch

const result = await client.swap("USDT", "XAUT", "1000", "arbitrum");
```

Using plain HTTP (no SDK required — recommended for external agents):
```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// 1. Create your wallet (any method — private key, seed, CDP, etc.)
const account = privateKeyToAccount("0x...");

// 2. Wire up x402 payment (USDC on Base)
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const walletClient = createWalletClient({ account, chain: base, transport: http() });
const x402 = new x402Client();
registerExactEvmScheme(x402, { signer: walletClient });
const fetchWithPayment = wrapFetchWithPayment(fetch, x402);

// 3. Call the API — x402 handles payment automatically
const res = await fetchWithPayment("https://trader.rigoblock.com/api/quote?sell=ETH&buy=USDC&amount=1");
```

Using Python (Gumloop, LangChain, or any Python agent):
```python
from eth_account import Account
from eth_account.messages import encode_defunct
import requests, json, time

# 1. Create your own wallet (any method you prefer)
account = Account.create()
# Or from existing: account = Account.from_key("0x...")
print(f"Address: {account.address}")

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
| **Agent reasoning** | Strategy selection, market analysis, sequencing | Browser chat / Gumloop / any LLM agent |
| **Wallet execution** | Key management, signing, x402 payment | Agent's own wallet (viem, ethers, CDP, web3.py, etc.) |
| **DeFi execution** | Trading, NAV shield, delegation, on-chain ops | Rigoblock API (`trader.rigoblock.com`) |

The agent decides *what* to do. Your wallet manages *who* signs. The API ensures *safe execution*.

- The agent **never** touches the server-side agent wallet keys — CDP manages them
- The API **never** has the operator's private key — it verifies signatures
- The NAV shield **cannot** be bypassed by the agent — it runs server-side

## Environment Variables

- `RIGOBLOCK_VAULT_ADDRESS` — *(optional)* The vault contract address. If not set,
  the agent should deploy a new vault using the bootstrap flow above. For
  multi-chain, the agent tracks a separate vault address per chain.

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

Cost: **$0.002** per call (USDC on Base).

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

Cost: **$0.01** per call (USDC on Base).

### x402 Payment (USDC on Base)

Every request that hits these endpoints without a valid `X-PAYMENT` header
returns `402 Payment Required` with a payment challenge. Your wallet
signs a USDC payment on Base and the x402 client retries with the signed
header automatically.

If you're using JavaScript/TypeScript, the
[GitHub repo](https://github.com/RigoBlock/agentic-operator) includes an `sdk/`
folder with a typed HTTP client (x402 payment wiring is your responsibility).

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
- XAUT/USDT pool on Arbitrum (reference pool):
  - Pool ID: `0xb896675bfb20eed4b90d83f64cf137a860a99a86604f7fac201a822f2b4abc34`
  - fee: `6000` (0.60%), tickSpacing: `120`, hooks: `0x0000000000000000000000000000000000000000`
  - currency0: XAUT `0x40461291347e1eCbb09499F3371D3f17f10d7159`, currency1: USDT `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`
- For unknown pools: call `get_pool_info` with the pool ID to discover fee, tickSpacing, and hooks before adding liquidity
- Examples: "add liquidity to XAUT/USDT pool with 0.5 XAUT and 1500 USDT on Arbitrum"

### GMX V2 Perpetuals (Arbitrum)
- Open, close, increase positions; get positions; cancel/update orders; claim funding
- XAUT/USD market: `XAUT.v2/USD [WBTC.b-USDC]`, index `0x40461291347e1eCbb09499F3371D3f17f10d7159`
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

Only deterministic TWAP automation is supported.

Use these tools:

1. `create_twap_order`
2. `list_twap_orders`
3. `cancel_twap_order`

Notes:

- `list_strategies` is a compatibility alias and returns TWAP orders only.
- Generic free-form LLM strategies are not part of the supported surface.
- Each TWAP slice still goes through the same swap safety path (including NAV shield checks).

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
- **Connect any wallet** — MetaMask, WalletConnect, or any EIP-6963 wallet
- **Gas-sponsored** — EIP-7702 via Alchemy, no ETH needed for agent wallet
- **Agent always on** — no need to keep a terminal open
- **Telegram integration** — receive strategy notifications and confirmations
- **Operator auth built-in** — sign once (browser-local)

The web chat provides the fastest path to see the
system in action without installing anything locally.

## Reference Files

- `{baseDir}/references/STRATEGIES.md` — Detailed strategy entry/exit sequences and parameters
- `{baseDir}/references/CHAINS.md` — Chain-specific tokens, addresses, and capabilities
- `{baseDir}/references/SAFETY.md` — Full safety model and what agents cannot do
- `{baseDir}/references/API.md` — HTTP API specification with request/response examples

For the optional TypeScript SDK, see the `sdk/`
directory in the [GitHub repo](https://github.com/RigoBlock/agentic-operator).
