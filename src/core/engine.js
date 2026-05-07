import { EventEmitter } from "node:events";
import { evaluateArbitrage, evaluateExitArbitrage } from "./arbitrage.js";
import { isBookStale, checkOpportunityRisk } from "./risk.js";
import { compactError } from "../lib/logger.js";

export class ArbitrageEngine extends EventEmitter {
  constructor({ config, clients, executor, store, logger }) {
    super();
    this.config = config;
    this.clients = clients;
    this.executor = executor;
    this.store = store;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.inTick = false;
    this.lastSymbolErrorLogAt = new Map();
    this.lastSymbolSkipLogAt = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.store.setStatus("running");
    this.tick();
    this.timer = setInterval(() => this.tick(), this.config.loopIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.store.setStatus("stopped");
  }

  async tick() {
    if (this.inTick || this.store.state.paused) return;
    this.inTick = true;
    try {
      const results = await Promise.allSettled(
        this.config.symbols.map((symbol) => this.evaluateSymbol(symbol)),
      );
      for (let i = 0; i < results.length; i += 1) {
        if (results[i].status === "fulfilled") continue;
        const symbol = this.config.symbols[i];
        const details = compactError(results[i].reason);
        this.store.state.lastError = details;
        if (this.shouldLogSymbolError(symbol, details)) {
          this.store.appendEvent("symbol.error", { symbol, ...details });
          this.emitEvent("symbol.error", { symbol, ...details });
          this.logger.error(`symbol ${symbol} failed`, results[i].reason);
        }
      }
      this.emitEvent("tick.completed", {});
    } catch (error) {
      this.store.state.lastError = compactError(error);
      this.store.appendEvent("tick.error", compactError(error));
      this.emitEvent("tick.error", compactError(error));
      this.logger.error("tick failed", error);
    } finally {
      this.inTick = false;
    }
  }

  async evaluateSymbol(symbol) {
    const [cascadeBook, risexBook] = await Promise.all([
      this.clients.cascade.getOrderbook(symbol, this.config.orderbookDepth),
      this.clients.risex.getOrderbook(symbol, this.config.orderbookDepth),
    ]);

    this.store.updateBooks(symbol, {
      cascade: stripRawBook(cascadeBook),
      risex: stripRawBook(risexBook),
    });

    const now = Date.now();
    if (
      isBookStale(cascadeBook, this.config.staleBookMs, now) ||
      isBookStale(risexBook, this.config.staleBookMs, now)
    ) {
      this.store.updateOpportunity(symbol, null);
      if (this.shouldLogSymbolSkip(symbol, "stale_book")) {
        this.store.appendEvent("symbol.skipped", { symbol, reason: "stale_book" });
      }
      return;
    }

    const state = this.store.snapshot();
    const openPosition = state.openPositions?.[symbol];
    const opportunity = openPosition
      ? evaluateExitArbitrage({
          symbol,
          position: openPosition,
          cascadeBook,
          risexBook,
          config: this.config,
        })
      : evaluateArbitrage({
          symbol,
          cascadeBook,
          risexBook,
          config: this.config,
        });
    this.store.updateOpportunity(symbol, opportunity);

    if (!opportunity) {
      this.emitEvent(openPosition ? "position.hold" : "opportunity.none", { symbol });
      return;
    }

    const risk = checkOpportunityRisk({
      opportunity,
      state,
      config: this.config,
    });
    if (!risk.ok) {
      this.store.appendEvent("opportunity.rejected", { symbol, reason: risk.reason, details: risk.details });
      return;
    }

    this.store.appendEvent("opportunity.accepted", opportunity);
    if (this.config.mode === "paper" || this.config.enabled) {
      const trade = await this.executor.execute(opportunity);
      this.emitEvent("trade.executed", trade);
    }
  }

  emitEvent(type, payload) {
    this.emit("event", { type, payload });
  }

  shouldLogSymbolError(symbol, details) {
    const interval = this.config.symbolErrorLogIntervalMs ?? 10000;
    if (interval <= 0) return false;
    const key = `${symbol}:${details.name ?? "error"}:${details.message ?? ""}`;
    const now = Date.now();
    const last = this.lastSymbolErrorLogAt.get(key) ?? 0;
    if (now - last < interval) return false;
    this.lastSymbolErrorLogAt.set(key, now);
    return true;
  }

  shouldLogSymbolSkip(symbol, reason) {
    const interval = this.config.symbolErrorLogIntervalMs ?? 10000;
    if (interval <= 0) return false;
    const key = `${symbol}:${reason}`;
    const now = Date.now();
    const last = this.lastSymbolSkipLogAt.get(key) ?? 0;
    if (now - last < interval) return false;
    this.lastSymbolSkipLogAt.set(key, now);
    return true;
  }
}

function stripRawBook(book) {
  return {
    exchange: book.exchange,
    symbol: book.symbol,
    market: book.market,
    receivedAt: book.receivedAt,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    latencyMs: book.latencyMs,
    rateLimited: book.rateLimited,
    rateLimitBackoffUntil: book.rateLimitBackoffUntil,
    bids: book.bids.slice(0, 10),
    asks: book.asks.slice(0, 10),
  };
}
