# Runbook

This is the short operating checklist for running the Cascade x RISEx bot on the
EC2 instance and viewing the dashboard from your Mac.

## What Must Be Running

Two things are needed:

1. EC2 bot service: runs the arbitrage engine and dashboard server on
   `127.0.0.1:8787` inside EC2.
2. Mac SSH tunnel: forwards your Mac's `127.0.0.1:8787` to the EC2 dashboard.

The browser alone does not start the bot. If the EC2 bot is stopped, the tunnel
will print `connect failed: Connection refused`.

## Recommended Daily Flow

Use PM2 for the bot so it keeps running after you close the SSH session.

### One-Time PM2 Install On EC2

Run this once after cloning the repo to `~/cascade-risex-arbi`:

```bash
cd ~/cascade-risex-arbi
sudo systemctl stop cascade-risex-arbi 2>/dev/null || true
sudo systemctl disable cascade-risex-arbi 2>/dev/null || true
sudo npm install -g pm2
pm2 startup systemd -u ec2-user --hp /home/ec2-user
pm2 save
```

If `pm2 startup` prints a `sudo env ...` command, copy and run that exact command
once, then run `pm2 save` again.

### Start Full Program On EC2

This is the command set to use when asking for "the full program start command":

```bash
cd ~/cascade-risex-arbi

git pull --ff-only
npm install
npm run check
npm test

pm2 start src/main.js --name cascade-risex-arbi --time
pm2 save
pm2 status
```

Healthy logs should include:

```text
dashboard listening ... http://127.0.0.1:8787
Lighter WS connected ... wss://mainnet.zklighter.elliot.ai/stream
Cascade WS connected
RISEx WS connected ... wss://api.rise.trade/ws/
```

The default data-quality guards are:

```bash
MAX_BOOK_SPREAD_BPS=100
MAX_BOOK_MID_MOVE_BPS=500
MAX_CROSS_VENUE_MID_DIFF_BPS=300
STALE_BOOK_MS=15000
EXCHANGES=cascade,risex,lighter
ROUTE_PAIRS=lighter:cascade,lighter:risex
```

### Stop Bot On EC2

```bash
pm2 stop cascade-risex-arbi
```

### Restart Bot After Pulling Updates

```bash
cd ~/cascade-risex-arbi
git pull --ff-only
npm install
npm run check
npm test
pm2 restart cascade-risex-arbi --update-env
pm2 save
pm2 status
```

### Watch Logs On EC2

```bash
pm2 logs cascade-risex-arbi
```

Stop watching logs with `Ctrl-C`. This does not stop the bot.

## Dashboard Tunnel From Mac

Open a separate Mac terminal:

```bash
ssh -i ~/Downloads/jung_test.pem \
  -L 8787:127.0.0.1:8787 \
  ec2-user@43.201.222.151
```

Then open:

```text
http://127.0.0.1:8787
```

Keep this SSH tunnel terminal open while viewing the dashboard. Closing this
terminal only closes dashboard access from your Mac; it does not stop the bot if
the bot is running under PM2.

## Quick Health Checks

On EC2:

```bash
pm2 status
curl -s http://127.0.0.1:8787/api/status
```

On Mac:

```bash
lsof -iTCP:8787 -sTCP:LISTEN
```

If local port `8787` is already used, either close the old SSH tunnel or use a
different local port:

```bash
ssh -i ~/Downloads/jung_test.pem \
  -L 8878:127.0.0.1:8787 \
  ec2-user@43.201.222.151
```

Then open:

```text
http://127.0.0.1:8878
```

## Manual Mode

Manual mode is useful for quick debugging only:

```bash
cd ~/cascade-risex-arbi
npm start
```

In manual mode, closing the SSH terminal or pressing `Ctrl-C` stops the bot.
For normal operation, prefer the PM2 commands above.
