# Lighter x Cascade x RISEx Arbitrage

Production-oriented delta-neutral arbitrage monitor for BTC and ETH across Lighter, Cascade, and RISEx.

The app starts in `paper` trading mode with `MARKET_DATA_MODE=live`, so it reads real public order books while keeping order execution disabled. It monitors order books, opens delta-neutral pairs when the executable spread is wide enough, closes them when the spread reverts, records PnL, serves a dashboard, sends Telegram notifications when configured, and produces a daily report. Live trading is intentionally gated by both `TRADING_MODE=live` and `TRADING_ENABLED=true`.

Trade decisions use executable orderbook depth, not mark/index prices. By default the engine evaluates `lighter:cascade` and `lighter:risex` route pairs, opens when net spread is at least `ENTRY_EDGE_BPS=50` (0.5%), and closes when the same route compresses to `EXIT_EDGE_BPS=0`.

## Quick Start

```bash
cp .env.example .env
npm test
npm start
```

Open `http://127.0.0.1:8787`.

## Key Scripts

- `npm start`: run the bot and dashboard.
- `npm test`: run unit tests.
- `npm run check`: syntax-check JS files.

## Live Trading Notes

Cascade public docs provided in this repository confirm auth and JWT usage for the testnet engine. The default market-data endpoint is the production Cascade engine behind `https://cascade.xyz/trade/BTC-USD`, because that is the screen this bot is meant to compare against RISEx. Public orderbook data is read from the Cascade engine WebSocket using the app's `source=book` subscription format. Live order placement routes are still configurable through `.env` until Cascade publishes the full order schema.

RISEx market-data defaults match the production web app at `https://www.rise.trade/en/trade/ETH-PERP`: REST is `https://api.rise.trade/api/v1` and WebSocket is `wss://api.rise.trade/ws/`. Public orderbook data uses the RISEx `orderbook` WebSocket channel by default, so the 50ms engine loop reads the latest local cache instead of hammering REST. RISEx live order submission requires a valid permit. On testnet only, RISEx docs expose a server-signing escape hatch via `signer_private_key`; this app supports it only when `RISEX_ENABLE_TESTNET_SERVER_SIGNING=true`. For production, replace that with client-side EIP-712 permit signing before enabling live trading.

Lighter market-data defaults use the read-only `wss://mainnet.zklighter.elliot.ai/stream?readonly=true` stream and the public `order_book/{MARKET_INDEX}` channel. The client verifies update continuity with `begin_nonce` and `nonce`; if a gap is detected, it discards the local book and resubscribes with exponential reconnect backoff. Lighter live order submission is intentionally not implemented yet.

See [docs/architecture.md](docs/architecture.md) for architecture, data flow, edge cases, error handling, and performance notes.

## EC2 Deployment

Amazon Linux 2023 deployment notes and a `systemd` service template are included in:

- [docs/deploy-amazon-linux-2023.md](docs/deploy-amazon-linux-2023.md)
- [docs/runbook.md](docs/runbook.md)
- [ops/systemd/cascade-risex-arbi.service](ops/systemd/cascade-risex-arbi.service)
