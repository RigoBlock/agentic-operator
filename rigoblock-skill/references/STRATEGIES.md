# Strategies

Generic free-form strategies and carry-trade planning were removed.

The only supported automated strategy is deterministic TWAP.

## TWAP (Deterministic)

Use these tools:

1. create_twap_order
2. list_twap_orders
3. cancel_twap_order

Behavior:

- Each order is split into fixed slices and executed on schedule.
- Execution is deterministic and does not rely on ad-hoc LLM reasoning at run time.
- Swap safety checks still apply per slice, including NAV shield enforcement on swap build and delegated execution.
- list_strategies remains a compatibility alias that returns TWAP orders only.
   evaluate whether to remove and re-add liquidity with an updated range.
4. **Liquidity buffer** — Keep enough idle USDT on the capital chain (BSC/Optimism) for
   rebalancing operations and gas. The agent decides the appropriate amount
   based on position sizes and market volatility.
5. **NAV deviation** — If cross-chain NAV differs significantly, sync
   immediately rather than waiting for the regular 8-hour schedule.
