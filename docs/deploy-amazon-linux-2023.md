# Amazon Linux 2023 Deployment

This guide assumes the EC2 instance is already provisioned and you can SSH into it.

## 1. Install runtime

Use Node.js 20 or newer.

```bash
sudo dnf update -y
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node --version
npm --version
```

## 2. Clone the repository

```bash
sudo mkdir -p /opt/cascade-risex-arbi
sudo chown ec2-user:ec2-user /opt/cascade-risex-arbi
git clone https://github.com/myungjungcrypto/autotrading_btc_eth.git /opt/cascade-risex-arbi/app
cd /opt/cascade-risex-arbi/app
npm install
cp .env.example .env
```

Edit `.env` on the server and put real credentials only on the EC2 instance. Do not commit `.env`.

Start conservatively:

```bash
TRADING_MODE=paper
TRADING_ENABLED=false
MARKET_DATA_MODE=live
LOOP_INTERVAL_MS=50
STALE_BOOK_MS=15000
ENTRY_EDGE_BPS=50
EXIT_EDGE_BPS=0
MAX_BOOK_SPREAD_BPS=100
```

If you previously copied an older `.env`, make sure the market ids are updated:

```bash
CASCADE_BASE_URL=https://engine.cascade.xyz
CASCADE_TIMEOUT_MS=15000
CASCADE_RESUBSCRIBE_MS=5000
CASCADE_ORDERBOOK_TRANSPORT=ws
CASCADE_WS_PATH=/ws
CASCADE_ORDERBOOK_TICK_SIZE=0.1
ENTRY_EDGE_BPS=50
EXIT_EDGE_BPS=0
CASCADE_MARKET_BTC=BTC-USD-PERP
CASCADE_MARKET_ETH=ETH-USD-PERP
RISEX_MARKET_BTC=1
RISEX_MARKET_ETH=2
RISEX_TIMEOUT_MS=2500
RISEX_RETRIES=0
RISEX_ORDERBOOK_TRANSPORT=ws
RISEX_WS_URL=wss://ws.testnet.rise.trade/ws
RISEX_WS_RESUBSCRIBE_MS=5000
RISEX_POLL_INTERVAL_MS=1000
RISEX_RATE_LIMIT_BACKOFF_MS=10000
RISEX_LOG_INTERVAL_MS=10000
RISEX_ERROR_LOG_INTERVAL_MS=10000
```

Switch to live trading only after live market data, balances, Telegram alerts, and paper fills look correct:

```bash
TRADING_MODE=live
TRADING_ENABLED=true
MARKET_DATA_MODE=live
```

## 3. Verify manually

```bash
npm run check
npm test
npm start
```

Open the dashboard through your chosen tunnel, reverse proxy, or security-group rule:

```text
http://EC2_PUBLIC_IP:8787
```

For a trading bot, prefer not exposing the dashboard publicly. Use SSH tunneling when possible:

```bash
ssh -L 8787:127.0.0.1:8787 ec2-user@EC2_PUBLIC_IP
```

Then open:

```text
http://127.0.0.1:8787
```

## 4. Install systemd service

```bash
sudo cp ops/systemd/cascade-risex-arbi.service /etc/systemd/system/cascade-risex-arbi.service
sudo systemctl daemon-reload
sudo systemctl enable cascade-risex-arbi
sudo systemctl start cascade-risex-arbi
sudo systemctl status cascade-risex-arbi
```

Logs:

```bash
journalctl -u cascade-risex-arbi -f
```

Restart after pulling updates:

```bash
cd /opt/cascade-risex-arbi/app
git pull
npm install
npm run check
npm test
sudo systemctl restart cascade-risex-arbi
```

## 5. Operational checklist

- Keep `.env` only on EC2.
- Start in `paper` mode and verify orderbook freshness.
- Confirm Telegram completion and failure alerts.
- Confirm daily report time in the server timezone.
- Keep `MAX_POSITION_NOTIONAL_USD` and `MAX_DAILY_LOSS_USD` small until live fills are verified.
- Watch for `leg_failed` events; the engine pauses automatically after a partial execution failure.
