import { round, startOfLocalDay } from "../lib/math.js";

export function buildDailyReport(state, date = new Date()) {
  const start = startOfLocalDay(date).getTime();
  const trades = state.trades.filter((trade) => new Date(trade.ts).getTime() >= start);
  const pnl = trades.reduce((sum, trade) => sum + (trade.realizedPnlUsd ?? 0), 0);
  const volume = trades.reduce((sum, trade) => sum + (trade.notionalUsd ?? 0), 0);
  const bySymbol = {};

  for (const trade of trades) {
    const row = bySymbol[trade.symbol] ?? { trades: 0, pnl: 0, volume: 0 };
    row.trades += 1;
    row.pnl += trade.realizedPnlUsd ?? 0;
    row.volume += trade.notionalUsd ?? 0;
    bySymbol[trade.symbol] = row;
  }

  const lines = [
    `# Daily Arbitrage Report ${date.toISOString().slice(0, 10)}`,
    "",
    `- Trades: ${trades.length}`,
    `- Realized PnL: ${round(pnl, 4)} USD`,
    `- Notional Volume: ${round(volume, 2)} USD`,
    `- Open Positions: ${Object.keys(state.openPositions ?? {}).length}`,
    `- Engine Status: ${state.status}${state.paused ? " (paused)" : ""}`,
    "",
    "## By Symbol",
    "",
    "| Symbol | Trades | PnL USD | Volume USD |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const [symbol, row] of Object.entries(bySymbol)) {
    lines.push(`| ${symbol} | ${row.trades} | ${round(row.pnl, 4)} | ${round(row.volume, 2)} |`);
  }
  if (!Object.keys(bySymbol).length) {
    lines.push("| - | 0 | 0 | 0 |");
  }

  lines.push("", "## Recent Trades", "");
  for (const trade of trades.slice(0, 20)) {
    lines.push(
      `- ${trade.ts} ${trade.symbol} ${trade.action ?? "trade"}: buy ${trade.buyExchange} / sell ${trade.sellExchange}, ` +
        `size ${trade.size}, pnl ${round(trade.realizedPnlUsd ?? 0, 4)} USD`,
    );
  }
  if (!trades.length) lines.push("- No trades today.");

  return {
    date: date.toISOString().slice(0, 10),
    trades: trades.length,
    pnlUsd: round(pnl, 4),
    volumeUsd: round(volume, 2),
    markdown: lines.join("\n"),
  };
}

export function scheduleDailyReport({ store, notifier, reportTime, logger }) {
  const [hour, minute] = reportTime.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    logger.warn("Invalid REPORT_TIME, daily report scheduler disabled", { reportTime });
    return null;
  }

  let timer = null;
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    timer = setTimeout(async () => {
      const report = buildDailyReport(store.snapshot());
      store.appendEvent("report.daily", report);
      await notifier.report(report.markdown);
      scheduleNext();
    }, next.getTime() - now.getTime());
  };

  scheduleNext();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
