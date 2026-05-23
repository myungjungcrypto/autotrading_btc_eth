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

Use `systemd` for the bot so it keeps running after you close the SSH session.

### One-Time Service Install On EC2

Run this once after cloning the repo to `~/cascade-risex-arbi`:

```bash
cd ~/cascade-risex-arbi
sudo cp ops/systemd/cascade-risex-arbi.service /etc/systemd/system/cascade-risex-arbi.service
sudo systemctl daemon-reload
sudo systemctl enable cascade-risex-arbi
```

### Start Bot On EC2

```bash
sudo systemctl start cascade-risex-arbi
systemctl status cascade-risex-arbi --no-pager
```

Healthy logs should include:

```text
dashboard listening ... http://127.0.0.1:8787
Cascade WS connected
RISEx WS connected ... wss://api.rise.trade/ws/
```

### Stop Bot On EC2

```bash
sudo systemctl stop cascade-risex-arbi
```

### Restart Bot After Pulling Updates

```bash
cd ~/cascade-risex-arbi
git pull --ff-only
npm install
npm run check
npm test
sudo systemctl restart cascade-risex-arbi
systemctl status cascade-risex-arbi --no-pager
```

### Watch Logs On EC2

```bash
journalctl -u cascade-risex-arbi -f
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
the bot is running under `systemd`.

## Quick Health Checks

On EC2:

```bash
systemctl is-active cascade-risex-arbi
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
For normal operation, prefer the `systemd` commands above.
