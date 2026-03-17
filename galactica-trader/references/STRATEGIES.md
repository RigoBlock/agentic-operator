# Strategy — XAUT/USDT LP + Hedged Exposure

One strategy: provide XAUT/USDT liquidity on Uniswap v4 (Ethereum) and
hedge all XAUT price exposure with a 1x short on GMX (Arbitrum). The hedge
is **always on** — it is not removed when funding costs money. The strategy
produces synthetic USDT yield: LP fees minus hedge cost. The agent decides
all allocation amounts autonomously.

---

## XAUT/USDT LP + Permanent Hedge

**Goal:** Generate USDT yield from XAUT/USDT LP fees while maintaining
zero net directional XAUT exposure at all times.

**Chains:** Ethereum (raise funds + LP) <> Arbitrum (hedge via GMX perps)

**Core principle:** The GMX short is the hedge for the LP's XAUT exposure.
Even when the perp funding rate is negative (costing the vault), the hedge
stays on. Removing the hedge would create unhedged directional XAUT
exposure — that is speculation, not yield generation. The strategy's yield
is: `LP_fees - hedge_cost`. If this is negative, that is the cost of
maintaining the hedged position. The agent does NOT exit the hedge to
"save" on funding.

### How Capital Flows

The vault raises funds on **Ethereum** — investors mint pool tokens there.
The XAUT/USDT Uni v4 pool is on Ethereum, so the bulk of capital stays
on-chain without bridging. Only the hedge collateral is bridged to
Arbitrum.

The agent decides all allocation sizes autonomously:
- How much USDT to convert to XAUT for LP
- How much USDT to bridge to Arbitrum for hedge collateral (converted to
  XAUT on Arbitrum as GMX collateral)
- How much to keep as a liquidity buffer (for rebalancing, gas, exits)
- The agent should maximize LP allocation while maintaining sufficient
  GMX margin and an adequate liquidity buffer

### Entry Sequence

```
1. rigoblock_vault_info(chain: "ethereum")   -> check USDT balance
2. rigoblock_swap(
     USDT -> XAUT, chain: "ethereum", dex: "0x"
   )                                         -> buy gold (0x aggregator for best price)
3. rigoblock_add_liquidity(
     token0: "XAUT", token1: "USDT",
     amount0: <xaut_amount>, amount1: <usdt_amount>,
     chain: "ethereum"
   )                                         -> add LP position on Uni v4
     Pool: 0x19a01cd4a3d7a1fd58ee778fcdc74fce46023adb0ac179a603e5b3234dd5610d
4. rigoblock_bridge(
     USDT, from: "ethereum", to: "arbitrum"
   )                                         -> bridge USDT for hedge collateral
5. rigoblock_swap(
     USDT -> XAUT, chain: "arbitrum"
   )                                         -> convert to XAUT on Arbitrum
6. rigoblock_gmx_open(
     market: "XAUT/USD", direction: "short",
     collateral: "XAUT",
     collateralAmount: <xaut_amount>,
     leverage: 1
   )                                         -> hedge LP's directional exposure
7. rigoblock_sync_nav(
     from: "ethereum", to: "arbitrum"
   )                                         -> sync NAV across chains after entry
```

### Position Monitoring (every 5 minutes)

Perp collateral value can deteriorate quickly. Check positions frequently.

```
Every 5 minutes:
  1. rigoblock_get_lp_positions(ethereum)    -> LP health + fees accrued
  2. rigoblock_gmx_positions()               -> perp P&L, funding, margin health
  3. Calculate:
     - Hedge coverage: perp_size vs LP's XAUT exposure
     - GMX margin ratio (is collateral getting thin?)
     - LP fees accrued since last check
  4. If hedge coverage drifts > 2% from target:
     -> Adjust perp size (increase/decrease position)
  5. If GMX margin is deteriorating:
     -> Add collateral or reduce position size
  6. If LP fees > collection threshold:
     -> Collect: rigoblock_collect_lp_fees (if available)
```

### Cross-Chain NAV Sync (every ~8 hours)

NAV sync has a cost (bridge message fee), so run it less frequently than
position monitoring. Sync more often if NAV deviation is significant.

```
Regular schedule (~8 hours):
  rigoblock_sync_nav(from: "ethereum", to: "arbitrum")
  rigoblock_sync_nav(from: "arbitrum", to: "ethereum")

On XAUT price move > 1% since last sync:
  Immediate sync — stale NAV = wrong unit price for investors

After any bridge operation completes:
  Sync both chains — balances have changed

Before any rebalance decision:
  rigoblock_aggregated_nav() to get accurate cross-chain picture
```

**Why NAV sync matters:** Investors can mint/burn vault tokens at any time
based on the on-chain NAV. If NAV is stale on one chain, the unit price
is wrong — this lets arbitrageurs exploit the pricing mismatch. Regular
sync prevents this.

### Exit Sequence

Only used when the operator decides to wind down the strategy entirely
(not triggered by funding cost).

```
1. rigoblock_gmx_close(XAUT/USD, short)       -> close hedge
2. rigoblock_swap(XAUT -> USDT, arbitrum)       -> convert Arb XAUT back
3. rigoblock_bridge(USDT, arbitrum -> ethereum)  -> return funds to mainnet
4. rigoblock_remove_liquidity(positionId, ethereum) -> remove LP
5. rigoblock_swap(XAUT -> USDT, ethereum)         -> convert remaining XAUT
6. rigoblock_sync_nav() on both chains            -> final NAV sync
7. rigoblock_vault_info()                          -> verify final state
```

### Key Parameters

| Parameter | Description |
|-----------|-------------|
| `hedgeRatio` | Target hedge coverage — 1.0 (fully hedged). Rebalance when drift > 2% |
| `lpRange` | LP tick range — wide range minimizes IL and rebalancing frequency |

The agent decides all allocation sizes, buffer amounts, and rebalancing
triggers autonomously based on current market conditions and vault state.

### Risk Factors

- **Hedge cost:** When GMX funding is negative, the hedge costs money.
  This is expected — it reduces net yield but maintains the hedge.
  The hedge is NOT removed to save on funding.
- **Impermanent loss:** Hedged by the GMX perp. Wide range LP minimizes IL.
- **Cross-chain latency:** Across bridge fills in seconds. Agent should
  verify fill before proceeding.
- **GMX margin:** If XAUT price moves sharply, collateral value changes.
  Monitor every 5 minutes and top up margin if needed.
- **NAV shield:** Protects each individual trade on each chain (10% max
  NAV drop per trade, fail-closed).

---

## Rebalancing Guidelines

The agent continuously monitors and rebalances:

1. **Hedge coverage** — If the LP's XAUT exposure drifts more than 2%
   from the perp hedge size, adjust the perp (increase or decrease).
2. **GMX margin health** — If collateral is getting thin, bridge more
   USDT -> convert to XAUT -> add as collateral. Don't wait for liquidation.
3. **LP range** — If price moves outside the LP range, the agent should
   evaluate whether to remove and re-add liquidity with an updated range.
4. **Liquidity buffer** — Keep enough idle USDT on Ethereum for
   rebalancing operations and gas. The agent decides the appropriate amount
   based on position sizes and market volatility.
5. **NAV deviation** — If cross-chain NAV differs significantly, sync
   immediately rather than waiting for the regular 8-hour schedule.
