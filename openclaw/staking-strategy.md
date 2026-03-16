# GRG Staking Simulation — Optimization Strategy

> How the OpenClaw skill determines the **optimal GRG stake amount** for a
> Rigoblock vault, minimizing capital allocation while maximizing risk-adjusted
> yield.

## Problem Statement

A vault operator wants to know: **"Should I stake GRG, and if so, how much?"**

GRG staking provides:
1. **Operator rewards** — 30% minimum of the pool's pro-rata staking reward
2. **Community attraction** — a staked pool can receive delegated stake from
   third parties, increasing total rewards proportionally
3. **Diversification** — GRG exposure as a portfolio component

But it costs:
1. **Capital allocation** — GRG must be purchased and locked
2. **Price risk** — GRG has token price volatility
3. **Liquidity risk** — unstaking requires undelegation + epoch wait
4. **Opportunity cost** — capital could be deployed elsewhere (LP, lending, etc.)

## Simulation Model

### Input Parameters

| Parameter | Source | Description |
|-----------|--------|-------------|
| `vaultAum` | `getNavData()` | Total vault AUM in USD |
| `currentGrgBalance` | `getVaultTokenBalance(GRG)` | GRG already held by vault |
| `grgPrice` | `/api/quote?sell=GRG&buy=USDC` | Current GRG market price |
| `grgLiquidity` | DEX liquidity depth | Max purchasable without >2% slippage |
| `totalPoolStake` | Staking proxy read | Aggregate GRG staked across all pools |
| `epochReward` | Staking proxy read | GRG rewards distributed per epoch |
| `epochDuration` | Staking proxy read | Epoch length (typically 7 days) |
| `chainId` | Context | Must be Ethereum mainnet (1) for staking |

### Simulation Range

Simulate GRG staking at **0% to 10% of AUM**, in 1% increments:

```
for allocation in [0%, 1%, 2%, ..., 10%]:
    grgAmountUsd = vaultAum × allocation
    grgAmount = grgAmountUsd / grgPrice

    # Constraint: cannot exceed on-chain liquidity
    if grgAmount > grgLiquidity:
        grgAmount = grgLiquidity
        break  # higher allocations are not feasible

    annualReward = estimateAnnualReward(grgAmount, totalPoolStake, epochReward)
    annualYieldPct = annualReward × grgPrice / grgAmountUsd
    
    # Risk-adjusted return (penalize for GRG price volatility)
    riskAdjustedYield = annualYieldPct - volatilityPenalty(grgPrice)
    
    results.push({ allocation, grgAmount, annualYieldPct, riskAdjustedYield })
```

### Reward Estimation

The staking reward for a pool is proportional to its share of total stake:

```
poolRewardPerEpoch = epochReward × (poolStake / totalPoolStake)
operatorReward = poolRewardPerEpoch × operatorShare  # min 30%
communityReward = poolRewardPerEpoch × (1 - operatorShare)
```

Where:
- `poolStake` = vault's own GRG stake + community delegated stake
- Community delegated stake is harder to predict; model conservatively
  as 0 initially, then show the upside if community delegates

### Constraints

1. **Liquidity ceiling**: The recommended stake amount MUST NOT exceed the
   available on-chain liquidity for GRG on the target chain. If the DEX
   liquidity for GRG is only 50,000 GRG with <2% slippage, then 50,000 GRG
   is the hard maximum regardless of the AUM percentage calculation.
   *Exceeding this would cause the purchase transaction to revert.*

2. **Purchase requirement**: GRG must be acquired before staking. The
   simulation should model the swap cost (fees + slippage) as part of the
   total cost basis.

3. **Staking is Ethereum-only**: GRG staking is only available on Ethereum
   mainnet (chainId=1). Acquiring GRG on another chain requires bridging.

## Optimization Goal

**Minimize the staked GRG amount that offers the best risk-adjusted yield.**

The rationale:
- ANY positive GRG stake that yields net positive risk-adjusted return means
  staking is beneficial to the portfolio
- But we want the **smallest allocation** that captures most of the benefit,
  because:
  - Lower capital at risk to GRG price volatility
  - More capital available for primary strategy (swaps, LP, perps)
  - Diminishing marginal returns: doubling your stake doesn't double your
    yield percentage (it does increase absolute reward, but the rate stays
    the same)

The optimal point is where the **marginal risk-adjusted yield** starts to
flatten — i.e., the allocation beyond which staking more GRG adds little
incremental yield relative to the additional capital locked.

## Community Stake Multiplier

A key benefit not captured in pure yield math: staking GRG makes the pool
eligible for **community delegated stake**. The reward mechanics:

- Staking rewards are proportional to `poolStake / totalPoolStake`
- `poolStake` = operator stake + community delegated stake
- Community delegators earn a minimum of 30% of the pool's rewards
- The operator earns the remaining (up to 70%)

This means:
- A pool with 10,000 GRG staked by operator + 90,000 GRG from community
  earns 10× the base reward
- The operator keeps up to 70% of that enlarged reward
- Net effect: operator's effective yield can be **7× higher** than staking alone

The simulation should present two scenarios:
1. **Conservative**: Operator stake only, no community delegation
2. **Optimistic**: Operator stake + projected community delegation
   (e.g., 2-5× the operator's own stake as a reasonable range)

## Output Format

The simulation returns a recommendation:

```json
{
  "recommendation": {
    "optimalAllocationPct": 3,
    "grgAmount": "15000",
    "grgCostUsd": "4500.00",
    "estimatedAnnualYieldPct": "12.5",
    "estimatedAnnualRewardGrg": "1875",
    "estimatedAnnualRewardUsd": "562.50",
    "riskAdjustedYieldPct": "8.2",
    "communityUpsideYieldPct": "24.5",
    "liquidityCeiling": "50000",
    "liquidityUtilizationPct": "30"
  },
  "simulationResults": [
    { "allocationPct": 0, "yieldPct": "0", "riskAdjustedPct": "0" },
    { "allocationPct": 1, "yieldPct": "12.5", "riskAdjustedPct": "8.2" },
    { "allocationPct": 2, "yieldPct": "12.5", "riskAdjustedPct": "8.2" },
    ...
  ],
  "constraints": {
    "maxByLiquidity": "50000 GRG (on-chain limit)",
    "maxByAum": "15000 GRG (10% of AUM)",
    "effectiveMax": "15000 GRG",
    "chainId": 1,
    "note": "GRG must be purchased on Ethereum or bridged from another chain"
  }
}
```

## OpenClaw Agent Instructions

When the orchestrator agent evaluates GRG staking for a vault:

1. **Call `rigoblock_simulate_staking`** to get the simulation results
2. **Look at `optimalAllocationPct`** — this is the recommended allocation
3. **If `optimalAllocationPct` > 0**, staking has a net benefit:
   - Check if the vault already holds enough GRG (`currentGrgBalance`)
   - If not, plan a `rigoblock_swap(USDC→GRG)` step first
   - Then `rigoblock_stake_grg(amount)`
4. **If `optimalAllocationPct` == 0**, staking is not beneficial at current
   conditions (e.g., GRG price too high, liquidity too low, or yield
   doesn't justify the risk)
5. **Always respect the liquidity ceiling** — never recommend staking more
   GRG than can be purchased without excessive slippage
6. **Minimize the stake** — prefer the smallest allocation that captures
   the benefit. A 3% allocation with 8% risk-adjusted yield is better than
   10% allocation with 8.5% yield — the marginal 0.5% isn't worth 3.3×
   more capital at risk
