# Automated Strategies

Two deterministic strategy types are supported. Both go through the full safety stack
(NAV shield, delegation checks, 7-point validation) on every execution.

## TWAP (Time-Weighted Average Price)

Split a large swap into equal-size slices executed at a fixed interval.

| Tool | Purpose |
|------|---------|
| `create_twap_order` | Create a TWAP order |
| `list_twap_orders` | List active/completed orders (`list_strategies` is an alias) |
| `cancel_twap_order` | Cancel an active order |

Execution is deterministic — no LLM reasoning at run time.
Each slice executes independently through the full safety pipeline.

## NAV Sync

Periodically synchronise NAV across all active chains when unitary value deviates
beyond a configurable threshold.

| Tool | Purpose |
|------|---------|
| `create_nav_sync` | Create a NAV sync config |
| `list_nav_syncs` | List active configs |
| `cancel_nav_sync` | Cancel a config |

For one-off manual sync, use `crosschain_sync` directly.

---

Custom strategies (e.g. LP + hedge, carry trade, yield optimisation) are NOT built into
this service. External agents compose them from the atomic API primitives exposed by
`POST /api/chat` and `GET /api/quote`. See AGENTS.md for the composability model.
