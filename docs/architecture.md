# Architecture

## Overview

The system is a single Node.js service with four layers:

1. Exchange adapters normalize Cascade and RISEx WebSocket orderbook streams into a common orderbook and order interface. REST remains available for account, history, and fallback operations. A mock adapter is available for local smoke tests.
2. The arbitrage engine evaluates BTC and ETH two-leg opportunities in both directions, opens one position per symbol, and then watches that position for an exit spread.
3. Executors apply safety policy. `paper` mode records simulated open/close fills. `live` mode is gated and sends IOC-style paired orders through adapters.
4. The dashboard, Telegram notifier, and daily report read from the same state store.

Live trading is disabled unless both `TRADING_MODE=live` and `TRADING_ENABLED=true`.

## Folder Structure

```text
src/
  clients/        Exchange-specific REST clients and orderbook normalization
  core/           Arbitrage evaluation, execution, engine loop, risk checks
  lib/            Config, HTTP, logging, math helpers
  reports/        Daily PnL/report generation
  server/         HTTP API, SSE, static dashboard
  main.js         Process entry point
public/           Dashboard HTML, CSS, browser JS
docs/
  exchanges/      Local exchange API notes
test/             Node test runner unit tests
```

## Data Flow

```mermaid
flowchart LR
  C["Cascade WS"] --> N["Normalize Orderbook"]
  R["RISEx WS"] --> N
  N --> E["Arbitrage Engine"]
  E --> X["Executor: paper or live"]
  X --> S["State Store JSONL"]
  S --> D["Dashboard API + SSE"]
  S --> P["Daily Report"]
  X --> T["Telegram Notifier"]
```

## Edge Cases

- Stale orderbook: the engine skips a symbol when either venue book is older than `STALE_BOOK_MS`.
- Empty or crossed local book: malformed levels are ignored; impossible opportunities are rejected.
- Wide venue book spread: if either venue's own best bid/ask spread exceeds `MAX_BOOK_SPREAD_BPS`, the symbol is skipped to avoid treating stale or sparse testnet liquidity as an arbitrage signal.
- Shallow liquidity: executable size is matched level-by-level with the same base asset size on both venues, and stops before the first marginal level that no longer clears `ENTRY_EDGE_BPS`.
- Open position lifecycle: while a symbol has an open position, new entries are blocked and the engine only checks whether the spread has compressed to `EXIT_EDGE_BPS`.
- One-leg failure in live mode: live executor records the failed pair, pauses the engine, and sends an alert so the position can be manually repaired or handled by a future hedge module.
- Daily loss breach: engine pauses when realized daily PnL is below `-MAX_DAILY_LOSS_USD`.
- Position imbalance: paper state tracks per-symbol venue exposure and refuses opportunities that would exceed `MAX_POSITION_USD_PER_SYMBOL`.
- Missing credentials: adapters raise explicit configuration errors; paper mode continues without live credentials.
- Unknown exchange route during onboarding: keep `TRADING_MODE=paper` until live orderbook data, balances, alerts, and paper fills are validated.

## Error Management

- HTTP calls use timeout and retry with exponential backoff.
- WebSocket orderbook clients keep local depth caches, resubscribe while snapshots are pending, and reconnect on snapshot timeout or socket close.
- Every tick emits an event with either opportunities, skips, or errors.
- State changes are appended to JSONL before being exposed to the dashboard.
- Telegram failures are logged but do not crash the trading loop.
- Unhandled process errors are logged and cause a clean non-zero exit.

## Performance Evaluation

The hot path is O(symbols * depth) because each entry or exit direction walks normalized orderbook levels once. BTC and ETH are evaluated in parallel. With depth 20 and a 50ms target loop, the CPU cost is still small on a small EC2 instance. Network latency dominates initial snapshots, but steady-state decisions read local WebSocket caches for both venues. RISEx documentation currently throttles orderbook stream updates to a maximum of 4 updates per second per market, so the 50ms engine loop can react as soon as the newest streamed book is present but cannot make RISEx publish faster than its 250ms bucket.
