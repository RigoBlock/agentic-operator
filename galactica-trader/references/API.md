# API Reference — Rigoblock DeFi Operator

Base URL: `https://trader.rigoblock.com`

All endpoints are gated by x402 payment (USDT0 on Plasma or USDC on Base).

---

## GET /api/quote

Stateless price quote. No vault context needed.

**Query Parameters:**

| Param | Required | Type | Description |
|-------|----------|------|-------------|
| `sell` | Yes | string | Token to sell (symbol or address) |
| `buy` | Yes | string | Token to buy (symbol or address) |
| `amount` | Yes | string | Amount to sell (human-readable) |
| `chain` | No | string | Chain name or ID (default: 8453) |

**Response:**
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

**x402 Price:** $0.002 USDC

---

## POST /api/chat

AI-powered DeFi operations. Each request accepts a single natural-language
message, invokes zero or one tool, and returns a result.

**Request Body:**
```json
{
  "messages": [{"role": "user", "content": "swap 1 ETH for USDC on Base"}],
  "vaultAddress": "0xYourVault",
  "chainId": 8453,
  "operatorAddress": "0xOperatorWallet",
  "authSignature": "0x...",
  "authTimestamp": 1741700000000,
  "executionMode": "delegated",
  "confirmExecution": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `messages` | Yes | Chat messages array |
| `vaultAddress` | Yes | Target vault address |
| `chainId` | No | Chain ID (default from session) |
| `operatorAddress` | For delegated | Vault owner address |
| `authSignature` | For delegated | EIP-191 signature of auth message |
| `authTimestamp` | For delegated | Timestamp (valid 24h) |
| `executionMode` | No | `"manual"` (default) or `"delegated"` |
| `confirmExecution` | No | Auto-execute in delegated mode |

**Manual mode response:**
```json
{
  "reply": "I'll prepare a swap of 1 ETH → USDC...",
  "transaction": {
    "to": "0xYourVault",
    "data": "0x...",
    "value": "0x0",
    "chainId": 8453,
    "description": "Swap 1 ETH → 2,079.54 USDC via Uniswap"
  }
}
```

**Delegated mode response:**
```json
{
  "reply": "Executed: swapped 1 ETH → 2,079.54 USDC",
  "executionResult": {
    "txHash": "0x...",
    "confirmed": true,
    "explorerUrl": "https://basescan.org/tx/0x..."
  }
}
```

**x402 Price:** $0.01 USDC

---

## Supported Operations via /api/chat

| Category | Natural Language Examples |
|----------|-------------------------|
| Spot swaps | "swap 1000 USDT for XAUT on Arbitrum" |
| GMX perps | "open a 1x short XAUT/USD with 500 USDT collateral" |
| Uni v4 LP | "add liquidity to XAUT/USDT pool on Ethereum" |
| Bridge | "bridge 1000 USDT from Ethereum to Arbitrum" |
| Vault info | "show vault info" / "get NAV" |
| Delegation | "setup delegation" / "check delegation status" |

---

## Settlement Policy

| Response | Settlement | Reason |
|----------|-----------|--------|
| 200 OK | Settled | Value delivered |
| 400 Bad Request | NOT settled | Malformed request |
| 401 Unauthorized | NOT settled | Auth failure |
| 500 Server Error | NOT settled | Our fault |
