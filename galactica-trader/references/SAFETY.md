# Safety — Rigoblock DeFi Operator

## Defense in Depth

Every transaction executed by the Rigoblock Agentic Operator passes through
multiple independent safety layers before broadcast. These protections apply
regardless of how the transaction was triggered — whether from the web UI,
Telegram, or an external agent via x402.

## Layer 1: Operator Authentication

The caller must provide a valid EIP-191 signature proving they own the target
vault. No signature → no execution in delegated mode.

**Auth message:**
```
Welcome to Rigoblock Operator

Sign this message to verify your wallet and access your smart pool assistant.
```

Signature is valid for 24 hours. x402 payment is NOT a substitute for auth.

## Layer 2: Delegation Verification

The vault must have active on-chain delegation to the specific agent wallet
for the required function selector. The vault owner controls:
- Which functions are delegated (selector whitelist)
- To which agent wallet
- Can revoke at any time via `revokeAllDelegations()`

## Layer 3: Seven-Point Execution Validation

Before broadcast, every transaction is checked:

1. **Config exists** — delegation config enabled in KV store
2. **Target = vault** — transaction target must be the vault address
3. **Selector allowed** — function selector in the whitelist
4. **Agent wallet matches** — agent identity matches stored config
5. **Simulation passes** — `eth_call` simulation succeeds (catches reverts)
6. **Balance sufficient** — agent wallet has enough ETH for gas
7. **Gas within caps** — per-chain gas fee hard limits

## Layer 4: NAV Shield (10% Maximum Loss)

Before every transaction broadcast, the system simulates the trade's impact
on the vault's Net Asset Value per unit:

- Atomically simulates: `multicall([swap, getNavDataView])`
- Compares post-swap NAV against the **higher of**: pre-swap NAV or 24h baseline
- **If NAV drops > 10% → BLOCKED**
- **FAIL-CLOSED**: if any step fails (RPC, simulation, decode) → BLOCKED

The NAV shield cannot be disabled, bypassed, or circumvented by any API caller.

## Layer 5: Slippage Protection

Default slippage tolerance: 1% (100 basis points). Enforced in swap calldata
building. Combined with the NAV shield, provides two layers of price protection.

## What Agents CANNOT Do (Even with Full Authentication)

| Action | Why Not |
|--------|---------|
| Drain vault assets to external address | `withdraw` and `transferOwnership` never delegated |
| Execute trades that lose > 10% NAV | NAV shield blocks pre-broadcast |
| Bypass slippage protection | Enforced in calldata building |
| Call arbitrary contract functions | Selector whitelist (not blacklist) |
| Send transactions to non-vault contracts | Target must equal vault address |
| Spend more gas than chain cap | Hard-coded, not configurable |
| Modify delegation settings | Only vault owner can call `updateDelegation` |

## For AI Agents

The safety model means you can call tools freely — the system will block any
dangerous operation before it reaches the blockchain. However:

- **Always check tool results** for error messages before proceeding
- **Respect "BLOCKED" responses** — they mean the NAV shield caught something
- **Don't retry blocked transactions** — the market conditions need to change
- **Manual mode is always safe** — unsigned tx data can't harm the vault
