import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso, startOfLocalDay } from "../lib/math.js";

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.statePath = join(dataDir, "state.json");
    this.eventsPath = join(dataDir, "events.jsonl");
    this.state = this.load();
  }

  load() {
    if (existsSync(this.statePath)) {
      return JSON.parse(readFileSync(this.statePath, "utf8"));
    }
    return {
      startedAt: nowIso(),
      status: "starting",
      paused: false,
      lastTickAt: null,
      books: {},
      opportunities: {},
      trades: [],
      events: [],
      exposure: {},
      realizedPnlUsd: 0,
      dailyPnlUsd: 0,
      lastError: null,
    };
  }

  save() {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  appendEvent(type, payload = {}) {
    const event = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ts: nowIso(), type, payload };
    this.state.events.unshift(event);
    this.state.events = this.state.events.slice(0, 250);
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    this.save();
    return event;
  }

  setStatus(status) {
    this.state.status = status;
    this.save();
  }

  setPaused(paused, reason = "") {
    this.state.paused = paused;
    this.appendEvent(paused ? "engine.paused" : "engine.resumed", { reason });
  }

  updateBooks(symbol, books) {
    this.state.books[symbol] = books;
    this.state.lastTickAt = nowIso();
    this.save();
  }

  updateOpportunity(symbol, opportunity) {
    if (opportunity) this.state.opportunities[symbol] = opportunity;
    else delete this.state.opportunities[symbol];
    this.save();
  }

  recordTrade(trade) {
    this.state.trades.unshift(trade);
    this.state.trades = this.state.trades.slice(0, 500);
    if (trade.status === "filled" || trade.status === "paper_filled") {
      this.state.realizedPnlUsd += trade.realizedPnlUsd ?? 0;
      this.state.dailyPnlUsd = this.calculateDailyPnl();
      this.applyExposure(trade);
    }
    this.appendEvent("trade.recorded", trade);
  }

  applyExposure(trade) {
    const symbolExposure = this.state.exposure[trade.symbol] ?? {};
    symbolExposure[trade.buyExchange] = (symbolExposure[trade.buyExchange] ?? 0) + trade.notionalUsd;
    symbolExposure[trade.sellExchange] = (symbolExposure[trade.sellExchange] ?? 0) - trade.notionalUsd;
    this.state.exposure[trade.symbol] = symbolExposure;
  }

  calculateDailyPnl(date = new Date()) {
    const start = startOfLocalDay(date).getTime();
    return this.state.trades
      .filter((trade) => new Date(trade.ts).getTime() >= start)
      .reduce((sum, trade) => sum + (trade.realizedPnlUsd ?? 0), 0);
  }

  snapshot() {
    this.state.dailyPnlUsd = this.calculateDailyPnl();
    return structuredClone(this.state);
  }
}
