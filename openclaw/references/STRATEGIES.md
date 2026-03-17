# Strategy Templates — Rigoblock DeFi Operator

Two composable strategy templates plus a capital efficiency optimizer.
The OpenClaw agent selects and composes these based on market conditions.

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
- **NAV shield:** Blocks any single trade that drops vault unit price >10%

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
- **NAV shield:** Protects each individual trade on each chain

---

## Capital Efficiency Optimizer

**Goal:** Minimize idle cash across both strategies to maximize productive
capital, while maintaining sufficient liquidity for rebalancing and exits.

**Default Allocation:** 80% AMM (LP), 10% GMX collateral, 10% cash reserve

### Optimization Logic

The agent continuously monitors on-chain conditions and adjusts the
cash/deployed ratio:

```
Every 2-4 hours:
  1. rigoblock_vault_info()                  → current token balances
  2. rigoblock_get_lp_positions()            → LP position size vs pool depth
  3. rigoblock_gmx_positions()               → collateral utilization
  4. rigoblock_aggregated_nav()              → total cross-chain NAV
  5. Calculate:
     - pool_depth_ratio: vault_lp_size / total_pool_tvl
     - cash_ratio: idle_usdt / total_nav
     - utilization: (lp_value + gmx_collateral) / total_nav
  6. Decision:
     IF pool_depth_ratio < 2% AND cash_ratio > 2%:
       → Deploy excess cash: add LP or increase GMX collateral
       → Target cash_ratio = 2%
     IF pool_depth_ratio > 10% (vault is large vs pool):
       → Increase cash buffer to 10-15% (exit liquidity protection)
     IF available_pool_liquidity < 0.1% of vault_position:
       → URGENT: reduce LP exposure, increase cash to 15-20%
       → Thin liquidity = high slippage on exit
     IF cash_ratio < 1%:
       → WARNING: rebalance impossible. Reduce positions to restore 2%.
```

### Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `minCashPct` | 2% | 1-5% | Minimum idle USDT reserve |
| `maxCashPct` | 10% | 5-20% | Default upper bound for cash |
| `liquidityWarningPct` | 0.1% | 0.05-0.5% | Pool depth alarm threshold |
| `deployTriggerPct` | 2% | 1-5% | Pool depth ratio below which surplus cash is deployed |
| `ammAllocationPct` | 80% | 60-90% | Target % of NAV in LP |
| `gmxAllocationPct` | 10% | 5-20% | Target % of NAV in GMX collateral |

### Why This Matters

A naive allocation (fixed 80/10/10) leaves capital idle. The optimizer creates
a **thinking loop**: the agent constantly evaluates whether the vault has too
much or too little cash. Deploying excess cash to LP earns fees; but keeping
too little cash means the agent can't rebalance or exit if conditions change.
This tension is the core optimization problem the agent solves autonomously.

---

## Strategy Compositor — Decision Framework

When asked to "run a DeFi strategy" or "optimize the vault", evaluate both
strategies and apply the capital efficiency optimizer:

### Step 1: Gather Data
```
rigoblock_gmx_positions()        → existing positions?
rigoblock_get_lp_positions()     → existing LP?
rigoblock_aggregated_nav()       → AUM per chain
rigoblock_quote(USDT→XAUT)      → current gold price
# External data (from other skills or tools):
#   GMX funding rate history
#   Uni v4 pool fee APR
```

### Step 2: Score Strategies

| Strategy | Key Metric | Score Formula |
|----------|-----------|---------------|
| Carry Trade | Funding rate | `funding_rate_per_hour * 24 * 365` annualized |
| LP+Hedge | LP fees - hedge cost | `(lp_apr - |funding_cost|)` net yield |

### Step 3: Compose

Select the higher-yielding strategy as primary. Allocate capital:
- **Primary strategy** gets 80-90% of deployable capital
- **Secondary strategy** gets 0-10% if both have positive yield
- **Cash reserve** starts at 10%, then the capital efficiency optimizer
  reduces it toward 2% as conditions stabilize
- **Never** go below 2% cash — always keep reserves for rebalancing and gas

### Step 4: Execute, Monitor, and Optimize

Enter positions via the tool sequences above. Then continuously:
1. **Monitor yields** — compare carry vs LP+hedge every 2-4 hours
2. **Rebalance** — shift capital if primary/secondary yield ranking changes
3. **Optimize cash** — run the capital efficiency loop: deploy surplus when
   liquidity is healthy, increase reserves when liquidity thins
4. **Report** — current allocation, yield metrics, cash utilization, next action
