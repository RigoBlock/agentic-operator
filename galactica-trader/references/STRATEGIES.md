# Strategy — XAUT/USDT LP + Hedged Exposure

One strategy: provide XAUT/USDT liquidity on Uniswap v4 (Arbitrum) and
hedge all XAUT price exposure with a short on GMX (Arbitrum). The hedge
is **always on** — it is not removed when funding costs money. The strategy
produces synthetic USDT yield: LP fees minus hedge cost. The agent decides
all allocation amounts autonomously.

---

## XAUT/USDT LP + Permanent Hedge

**Goal:** Generate USDT yield from XAUT/USDT LP fees while maintaining
zero net directional XAUT exposure at all times.

**Chains:** BSC + Optimism (raise funds / minting) <> Arbitrum (LP + hedge via GMX perps)

**Core principle:** The GMX short is the hedge for the LP's XAUT exposure.
Even when the perp funding rate is negative (costing the vault), the hedge
stays on. Removing the hedge would create unhedged directional XAUT
exposure — that is speculation, not yield generation. The strategy's yield
is: `LP_fees - hedge_cost`. If this is negative, that is the cost of
maintaining the hedged position. The agent does NOT exit the hedge to
"save" on funding.

### How Capital Flows

The vault raises funds on **BSC** and **Optimism** — investors mint pool tokens there
(USDT as base token). Capital is bridged to Arbitrum for both LP and hedge operations.
The same vault address exists on multiple chains but may not exist on all chains.
A vault with zero total supply can still hold real token balances (Rigoblock uses
virtual supplies for cross-chain transfer tracking).
GMX XAUT market uses WBTC (long) and USDC (short) as collateral.
For the short hedge, the agent uses USDC collateral.

The agent decides all allocation sizes autonomously:
- ~80% to LP (split roughly 40% XAUT + 40% USDT)
- ~15% to GMX hedge collateral (as USDC)
- ~5% idle buffer for rebalancing, gas, exits
- The agent should maximize LP allocation while maintaining sufficient
  GMX margin and an adequate liquidity buffer

### Entry Sequence

```
1. get_aggregated_nav → discover where funds are across all chains
2. get_token_balance(token: "USDT", chain: "arbitrum") → check if already on Arbitrum
3. IF bridge needed: crosschain_transfer(USDT, from: source chain, to: "arbitrum")
   Then: verify_bridge_arrival(token: "USDT", chain: "arbitrum", minAmount: <expected>)
4. build_vault_swap(USDT → XAUT, chain: "arbitrum") → buy gold (~40% of capital)
5. add_liquidity(
     tokenA: "XAUT", tokenB: "USDT",
     hooks: <rigoblock_oracle_hook_address>,
     chain: "arbitrum"
   ) → add LP on Uni v4 (with oracle hook)
6. build_vault_swap(USDT → USDC, chain: "arbitrum") → convert ~15% to hedge collateral
7. gmx_open_position(
     market: "XAUT", isLong: false,
     collateral: "USDC", leverage: 10
   ) → hedge LP's directional exposure
8. crosschain_sync(from: "arbitrum", to: all active chains) → sync NAV
```

### Position Monitoring (every 5 minutes, autonomous)

The agent composes monitoring from available primitives — no hardcoded logic.

```
Every 5 minutes:
  1. get_lp_positions → LP XAUT amount (exposure)
  2. gmx_get_positions → hedge size, PnL, leverage, liquidation price
  3. Analyze:
     - Hedge drift: |LP_XAUT_usd - hedge_size_usd| / LP_XAUT_usd
     - Collateral health: current leverage vs target 10x
     - Idle capital: undeployed balances on any chain
  4. If hedge drift > 5%:
     → gmx_increase_position or gmx_close_position (partial) to match
  5. If leverage > 12x (collateral eroded):
     → Source USDC: check Arbitrum balance → other chains via bridge → reduce LP as last resort
     → gmx_increase_position to add collateral, restore 10x
  6. If new deposit detected (excess capital on BSC, Optimism, or any chain):
     → crosschain_transfer to Arbitrum → verify_bridge_arrival → swap → add LP → adjust hedge
     → Maintain 80/15/5 allocation ratio
```

### Multi-step Autonomous Execution

When the strategy engine detects a condition requiring action, it runs an
**agentic loop** — up to 6 sequential operations per run:

```
Example: collateral health deteriorating (leverage at 13x)
  Step 1: get_token_balance("USDC") on Arbitrum → $0 idle
  Step 2: get_aggregated_nav → $8 USDT idle on Optimism
  Step 3: crosschain_transfer(USDT, optimism → arbitrum)
  Step 4: build_vault_swap(USDT → USDC on Arbitrum)
  Step 5: gmx_increase_position (add USDC collateral)
  → Leverage restored to ~10x
```

Each step is executed, results fed back to the LLM, which decides the next
step. The agent reasons about what to do — we provide the tools.

### Cross-Chain NAV Sync (separate strategy, every ~30 minutes)

NAV sync has a cost (bridge message fee), so run it less frequently than
position monitoring. Sync more often if NAV deviation is significant.
This is a SEPARATE strategy from the carry trade monitor.

```
Regular schedule (~30 minutes):
  crosschain_sync between all active chain pairs (BSC, Optimism, Arbitrum)

On XAUT price move > 1% since last sync:
  Immediate sync — stale NAV = wrong unit price for investors

After any bridge operation completes:
  Sync affected chains — balances have changed

Before any rebalance decision:
  get_aggregated_nav() to get accurate cross-chain picture
```

**Why NAV sync matters:** Investors can mint/burn vault tokens at any time
based on the on-chain NAV. If NAV is stale on one chain, the unit price
is wrong — this lets arbitrageurs exploit the pricing mismatch. Regular
sync prevents this.

### Exit Sequence

Only used when the operator decides to wind down the strategy entirely
(not triggered by funding cost).

```
1. gmx_close_position(XAUT, short) → close hedge
2. remove_liquidity_v4(positionId) → remove LP
3. build_vault_swap(XAUT → USDT, arbitrum) → convert remaining XAUT
4. crosschain_transfer(USDT, arbitrum → BSC or Optimism) → return funds
5. crosschain_sync() on all active chains → final NAV sync
6. get_vault_info() → verify final state
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
4. **Liquidity buffer** — Keep enough idle USDT on the capital chain (BSC/Optimism) for
   rebalancing operations and gas. The agent decides the appropriate amount
   based on position sizes and market volatility.
5. **NAV deviation** — If cross-chain NAV differs significantly, sync
   immediately rather than waiting for the regular 8-hour schedule.
