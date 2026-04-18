# Supported Chains — Rigoblock DeFi Operator

## Chain Reference

| Chain | ID | Short Name | Swap | LP (Uni v4) | Perps (GMX) | Bridge |
|-------|----|-----------|------|-------------|-------------|--------|
| Ethereum | 1 | `ethereum` | Uniswap, 0x | Yes | — | Across |
| Base | 8453 | `base` | Uniswap, 0x | Yes | — | Across |
| Arbitrum | 42161 | `arbitrum` | Uniswap, 0x | Yes | GMX V2 | Across |
| Optimism | 10 | `optimism` | Uniswap, 0x | Yes | — | Across |
| Polygon | 137 | `polygon` | Uniswap, 0x | — | — | Across |
| BNB Chain | 56 | `bsc` | Uniswap, 0x | — | — | Across |
| Unichain | 130 | `unichain` | Uniswap | Yes | — | — |

## Key Tokens by Chain

### ETH (Ethereum)
- **Ethereum:** `0x68749665FF8D2d112Fa859AA293F07A622782F38`
- **Arbitrum:** `0x40461291347e1eCbb09499F3371D3f17f10d7159` (bridged)

### USDT
- Available on all supported chains via major DEX liquidity.

## Strategy-Chain Mapping

| Strategy | Primary Chain | Secondary Chain | Why |
|----------|--------------|-----------------|-----|
| ETH LP + IL Hedge | Arbitrum | BSC + Optimism (capital) | LP + hedge both on Arbitrum (GMX perps + Uni v4 LP on same chain) |

## Key Addresses

### ETH/USDC Uniswap v4 Pool (Ethereum — legacy)
```
0x19a01cd4a3d7a1fd58ee778fcdc74fce46023adb0ac179a603e5b3234dd5610d
```

Note: The current strategy deploys the ETH/USDC LP on **Arbitrum** (same chain as the GMX hedge).
The Arbitrum pool uses a Rigoblock oracle hook — the operator provides the hook address at LP creation.

### ETH GMX V2 Market (Arbitrum)
```
Market: ETH/USD [WBTC.b-USDC]
Index Token: 0x40461291347e1eCbb09499F3371D3f17f10d7159
```
