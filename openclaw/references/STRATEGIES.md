# Strategy Templates — Rigoblock DeFi Operator

Three composable strategy templates. The OpenClaw agent selects and composes
these based on market conditions.

---

## Strategy 1: XAUT Carry Trade

**Goal:** Generate synthetic USDT yield by holding gold (XAUT) with hedged price
risk. Delta-neutral: long spot + short perp cancel out directional exposure.

**Chain:** Arbitrum (single-chain, simple)

**Token Flow:** USDT → XAUT (spot) + SHORT XAUT/USD (perp)

### Entry Sequence

```
1. rigoblock_vault_info()                    → check USDT balance
2. rigoblock_gmx_positions()                 → check no existing XAUT positions
3. rigoblock_quote(USDT → XAUT, Arbitrum)    → get price, calculate size
4. rigoblock_swap(USDT → XAUT, Arbitrum)     → buy gold spot
5. rigoblock_gmx_open(
     market: "XAUT/USD",
     direction: "short",
     collateral: "USDT",
     collateralAmount: <hedge_value>,
     leverage: 1
   )                                         → open delta-neutral hedge
6. rigoblock_gmx_positions()                 → verify hedge is live
```

### Monitoring Loop

```
Every 2-4 hours:
  1. rigoblock_gmx_positions()               → check funding P&L
  2. rigoblock_quote(XAUT → USDT)            → check spot price drift
  3. Calculate hedge ratio: spot_value / perp_size
  4. If |hedge_ratio - 1.0| > 0.02:
     → Rebalance: adjust perp size or spot position
  5. If funding rate < 0 for > 6 hours:
     → Exit strategy (see exit sequence)
  6. If cumulative funding P&L > threshold:
     → Claim: rigoblock_gmx_close + rigoblock_swap(XAUT → USDT)
     → Re-enter with updated sizes
```

### Exit Sequence

```
1. rigoblock_gmx_close(XAUT/USD, short)     → close perp hedge
2. rigoblock_swap(XAUT → USDT, Arbitrum)     → sell gold spot
3. rigoblock_vault_info()                      → verify USDT balance restored
```

### Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `allocation` | 50% of USDT | 10-80% | How much USDT to deploy |
| `hedgeRatio` | 1.0 | 0.9-1.1 | Target perp/spot ratio |
| `rebalanceThreshold` | 2% | 1-5% | Drift before rebalancing |
| `minFundingRate` | +0.005%/h | 0-0.05% | Minimum to stay in trade |
| `exitAfterNegativeHours` | 6 | 2-24 | Hours of negative funding before exit |

### Risk Factors

- **Funding flips negative:** Agent exits. Loss = swap fees + negative funding accrued
- **XAUT spot liquidity:** 0x aggregator routes through 150+ sources for best price
- **GMX position health:** 1x short = no leverage risk, no liquidation unless extreme move
- **NAV guard:** Blocks any single trade that drops vault unit price >10%

---

## Strategy 2: XAUT/USDT LP + Hedge

**Goal:** Earn LP fees on XAUT/USDT pair with impermanent loss hedged via GMX
perpetuals on a separate chain.

**Chains:** Ethereum (spot + LP) ↔ Arbitrum (perps + hedge)

**Token Flow:** 100% Tether products: USDT + XAUT + USDT0 for API payments.

### Entry Sequence

```
1. rigoblock_vault_info(chain: "ethereum")   → check USDT balance
2. rigoblock_swap(
     USDT → XAUT, amount: 40% of deploy,
     chain: "ethereum", dex: "0x"
   )                                         → buy gold (0x aggregator for best price)
3. rigoblock_add_liquidity(
     token0: "XAUT", token1: "USDT",
     amount0: <xaut_amount>, amount1: <usdt_amount>,
     chain: "ethereum"
   )                                         → add LP position on Uni v4
     Pool: 0x19a01cd4a3d7a1fd58ee778fcdc74fce46023adb0ac179a603e5b3234dd5610d
4. rigoblock_bridge(
     USDT, amount: 10% of deploy,
     from: "ethereum", to: "arbitrum"
   )                                         → bridge USDT for hedge collateral
5. rigoblock_swap(
     USDT → XAUT, chain: "arbitrum"
   )                                         → convert to XAUT on Arbitrum
6. rigoblock_gmx_open(
     market: "XAUT/USD", direction: "short",
     collateral: "XAUT",                     ← XAUT as collateral (100% Tether flow)
     collateralAmount: <xaut_amount>,
     leverage: 1
   )                                         → hedge LP's directional exposure
```

### Monitoring Loop

```
Every 4-8 hours:
  1. rigoblock_get_lp_positions(ethereum)    → LP health + fees accrued
  2. rigoblock_gmx_positions()               → perp P&L + funding
  3. rigoblock_aggregated_nav()              → cross-chain NAV
  4. Calculate:
     - LP delta exposure (from price movement since entry)
     - Hedge coverage: perp_size / lp_delta
     - Net yield: LP_fees - hedge_funding_cost
  5. If hedge_drift > 2%:
     → Adjust perp size (increase/decrease position)
  6. If net_yield < 0 for > 24 hours:
     → Exit strategy
  7. If LP fees > threshold:
     → Collect: rigoblock_collect_lp_fees (if available)
```

### Exit Sequence

```
1. rigoblock_gmx_close(XAUT/USD, short)       → close hedge first
2. rigoblock_swap(XAUT → USDT, arbitrum)       → convert Arb XAUT back
3. rigoblock_bridge(USDT, arbitrum → ethereum)  → return funds to mainnet
4. rigoblock_remove_liquidity(positionId, ethereum) → remove LP
5. rigoblock_swap(XAUT → USDT, ethereum)         → convert remaining XAUT
6. rigoblock_vault_info()                          → verify final state
```

### Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `xautAllocation` | 40% | 20-50% | % of deployed USDT converted to XAUT |
| `bridgeAllocation` | 10% | 5-20% | % bridged to Arbitrum for hedge |
| `lpRange` | wide | wide/medium/narrow | LP tick range |
| `hedgeRatio` | 1.0 | 0.8-1.2 | Target hedge coverage |
| `rebalanceThreshold` | 2% | 1-5% | Hedge drift before rebalancing |
| `maxHedgeCost` | -0.01%/h | varies | Max acceptable negative funding |

### Risk Factors

- **Impermanent loss:** Hedged by GMX perp. Wide range LP minimizes IL.
- **Hedge cost:** If funding is deeply negative, cost may exceed LP fees
- **Cross-chain latency:** Across bridges fill in minutes. Agent waits.
- **XAUT GMX collateral:** XAUT is the index token — should be accepted
- **NAV guard:** Protects each individual trade on each chain

---

## Strategy 3: GRG Staking Optimization

**Goal:** Minimize staked GRG for best risk-adjusted yield.

**Chain:** Ethereum mainnet (staking is Ethereum-only)

See [staking-strategy.md](../staking-strategy.md) for the full simulation model.

### Entry Sequence

```
1. rigoblock_simulate_staking(
     vaultAum, grgPrice, grgLiquidity, totalPoolStake, epochReward
   )                                         → get optimal allocation
2. If optimalAllocationPct > 0:
   a. rigoblock_vault_info(ethereum)         → check GRG balance
   b. If insufficient GRG:
      rigoblock_swap(USDC → GRG, ethereum)   → purchase GRG
   c. rigoblock_stake_grg(amount)            → stake optimal amount
```

### Monitoring Loop

```
Every epoch (7 days):
  1. Check epoch rewards received
  2. Re-run simulation with updated market data
  3. If optimal allocation changed significantly:
     → Adjust stake (unstake excess or stake more)
  4. Monitor community delegation trends
```

### Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `maxAllocationPct` | 10% | 1-20% | Maximum AUM % in GRG |
| `slippageTolerance` | 2% | 1-5% | Max slippage for GRG purchase |
| `rebalanceEpochs` | 4 | 1-12 | Re-evaluate every N epochs |

---

## Strategy Compositor — Decision Framework

When asked to "run a DeFi strategy" or "optimize the vault", evaluate all three:

### Step 1: Gather Data
```
rigoblock_gmx_positions()        → existing positions?
rigoblock_get_lp_positions()     → existing LP?
rigoblock_aggregated_nav()       → AUM per chain
rigoblock_quote(USDT→XAUT)      → current gold price
# External data (from other skills or tools):
#   GMX funding rate history
#   Uni v4 pool fee APR
#   GRG price + liquidity depth
```

### Step 2: Score Strategies

| Strategy | Key Metric | Score Formula |
|----------|-----------|---------------|
| Carry Trade | Funding rate | `funding_rate_per_hour * 24 * 365` annualized |
| LP+Hedge | LP fees - hedge cost | `(lp_apr - |funding_cost|)` net yield |
| GRG Staking | Risk-adjusted yield | From `rigoblock_simulate_staking` output |

### Step 3: Compose

Select strategies that have positive expected yield. Allocate capital:
- **Primary strategy** gets 50-80% of deployable capital
- **GRG staking** gets its optimal allocation (typically 1-5%)
- **Reserve** keeps 10-30% in USDT for rebalancing and gas
- **Never** allocate 100% — always keep a USDT reserve

### Step 4: Execute and Monitor

Enter positions via the tool sequences above. Set up monitoring intervals.
Report to user: current allocation, yield metrics, risk metrics, next rebalance.
