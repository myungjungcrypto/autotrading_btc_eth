# Cascade x RISEx Arbitrage

Production-oriented delta-neutral arbitrage monitor for BTC and ETH between Cascade and RISEx.

The app starts in `paper` mode with `MARKET_DATA_MODE=mock`, so the dashboard and full control flow run immediately without keys. For real exchange data, set `MARKET_DATA_MODE=live`. It monitors order books, computes executable two-leg spreads, simulates fills, records PnL, serves a dashboard, sends Telegram notifications when configured, and produces a daily report. Live trading is intentionally gated by both `TRADING_MODE=live` and `TRADING_ENABLED=true`.

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

Cascade public docs provided in this repository confirm auth and JWT usage, but not every order or orderbook route. Cascade endpoint paths are therefore configurable through `.env`.

RISEx routes are verified from the official docs. RISEx live order submission requires a valid permit. On testnet only, RISEx docs expose a server-signing escape hatch via `signer_private_key`; this app supports it only when `RISEX_ENABLE_TESTNET_SERVER_SIGNING=true`. For production, replace that with client-side EIP-712 permit signing before enabling live trading.

See [docs/architecture.md](docs/architecture.md) for architecture, data flow, edge cases, error handling, and performance notes.

## EC2 Deployment

Amazon Linux 2023 deployment notes and a `systemd` service template are included in:

- [docs/deploy-amazon-linux-2023.md](docs/deploy-amazon-linux-2023.md)
- [ops/systemd/cascade-risex-arbi.service](ops/systemd/cascade-risex-arbi.service)
