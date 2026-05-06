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
    let state;
    if (existsSync(this.statePath)) {
      state = JSON.parse(readFileSync(this.statePath, "utf8"));
    } else {
      state = {
        startedAt: nowIso(),
        status: "starting",
        paused: false,
        lastTickAt: null,
        books: {},
        opportunities: {},
        trades: [],
        events: [],
        exposure: {},
        openPositions: {},
        realizedPnlUsd: 0,
        dailyPnlUsd: 0,
        lastError: null,
      };
    }
    state.openPositions ??= {};
    state.exposure ??= {};
    state.events ??= [];
    state.trades ??= [];
    state.books ??= {};
    state.opportunities ??= {};
    state.realizedPnlUsd ??= 0;
    state.dailyPnlUsd ??= 0;
    return state;
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
    if (isRecordedFill(trade)) {
      if (trade.action === "open") {
        this.applyExposure(trade);
        this.state.openPositions[trade.symbol] = openPositionFromTrade(trade);
      } else if (trade.action === "close") {
        this.state.realizedPnlUsd += trade.realizedPnlUsd ?? 0;
        delete this.state.openPositions[trade.symbol];
        this.state.exposure[trade.symbol] = {};
      } else {
        this.state.realizedPnlUsd += trade.realizedPnlUsd ?? 0;
        this.applyExposure(trade);
      }
      this.state.dailyPnlUsd = this.calculateDailyPnl();
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

function isRecordedFill(trade) {
  return ["filled", "paper_filled", "submitted"].includes(trade.status);
}

function openPositionFromTrade(trade) {
  const raw = trade.rawOpportunity ?? {};
  const entryBuyNotional = sumNotional(raw.buyFills) || trade.notionalUsd;
  const entrySellNotional = sumNotional(raw.sellFills) || trade.sellPrice * trade.size;
  return {
    id: trade.positionId ?? trade.id,
    symbol: trade.symbol,
    openedAt: trade.ts,
    buyExchange: trade.buyExchange,
    sellExchange: trade.sellExchange,
    size: trade.size,
    entryBuyPrice: trade.buyPrice,
    entrySellPrice: trade.sellPrice,
    entryBuyNotional,
    entrySellNotional,
    entryCostUsd: (entryBuyNotional * (raw.costBps ?? 0)) / 10000,
    entryNetBps: trade.netBps,
    triggerBps: raw.triggerBps,
    mode: trade.mode,
  };
}

function sumNotional(fills = []) {
  return fills.reduce((sum, fill) => sum + (fill.notional ?? 0), 0);
}
