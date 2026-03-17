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

### XAUT (Tether Gold)
- **Ethereum:** `0x68749665FF8D2d112Fa859AA293F07A622782F38`
- **Arbitrum:** `0x7624cccCc59361D583F28BEC40D37e7771def5D` (bridged)

### USDT
- Available on all supported chains via major DEX liquidity.

## Strategy-Chain Mapping

| Strategy | Primary Chain | Secondary Chain | Why |
|----------|--------------|-----------------|-----|
| XAUT Carry Trade | Arbitrum | — | GMX V2 XAUT market is on Arbitrum |
| XAUT LP + Hedge | Ethereum | Arbitrum | LP on mainnet (deep XAUT liquidity), hedge on Arbitrum (GMX) |
| Capital Optimizer | All | All | Monitors cross-chain balances and deployment ratios |

## Key Addresses

### XAUT/USDT Uniswap v4 Pool (Ethereum)
```
0x19a01cd4a3d7a1fd58ee778fcdc74fce46023adb0ac179a603e5b3234dd5610d
```

### XAUT GMX V2 Market (Arbitrum)
```
Market: XAUT.v2/USD [WBTC.b-USDC]
Index Token: 0x7624cccCc59361D583F28BEC40D37e7771def5D
```
