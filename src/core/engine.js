import { EventEmitter } from "node:events";
import { evaluateArbitrageAcrossBooks, evaluateExitArbitrageAcrossBooks } from "./arbitrage.js";
import {
  isBookStale,
  checkBookHealth,
  checkBookMove,
  checkCrossVenueMid,
  checkOpportunityRisk,
  bookSpreadBps,
} from "./risk.js";
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
    this.lastHealthyBooks = new Map();
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
    const previousHealthyBooks = this.lastHealthyBooks.get(symbol) ?? {};
    const clientEntries = Object.entries(this.clients);
    const results = await Promise.allSettled(
      clientEntries.map(([, client]) => client.getOrderbook(symbol, this.config.orderbookDepth)),
    );

    const books = {};
    for (let i = 0; i < results.length; i += 1) {
      const [exchange] = clientEntries[i];
      const result = results[i];
      if (result.status === "fulfilled") {
        books[exchange] = result.value;
      } else {
        const details = compactError(result.reason);
        this.store.state.lastError = details;
        if (this.shouldLogSymbolError(symbol, { ...details, exchange })) {
          this.store.appendEvent("venue.error", { symbol, exchange, ...details });
          this.logger.error(`symbol ${symbol} ${exchange} failed`, result.reason);
        }
      }
    }

    const displayBooks = Object.fromEntries(
      Object.entries(books).map(([exchange, book]) => [exchange, stripRawBook(book)]),
    );
    this.store.updateBooks(symbol, displayBooks);

    const now = Date.now();
    const healthyBooks = {};
    const healthyDisplayBooks = {};
    for (const [exchange, book] of Object.entries(books)) {
      if (isBookStale(book, this.config.staleBookMs, now)) {
        this.logSymbolSkip(symbol, "stale_book", exchange, {
          exchange,
          market: book.market,
          receivedAt: book.receivedAt,
        });
        continue;
      }

      const bookHealth = checkBookHealth(book, this.config.maxBookSpreadBps);
      if (!bookHealth.ok) {
        this.logSymbolSkip(symbol, bookHealth.reason, exchange, bookHealth.details);
        continue;
      }

      const dataQuality = checkBookMove(book, previousHealthyBooks[exchange], {
        maxBookMidMoveBps: this.config.maxBookMidMoveBps,
        staleBookMs: this.config.staleBookMs,
        now,
      });
      if (!dataQuality.ok) {
        this.logSymbolSkip(symbol, dataQuality.reason, exchange, dataQuality.details);
        continue;
      }

      healthyBooks[exchange] = book;
      healthyDisplayBooks[exchange] = displayBooks[exchange];
    }

    this.lastHealthyBooks.set(symbol, { ...previousHealthyBooks, ...healthyDisplayBooks });

    if (Object.keys(healthyBooks).length < 2) {
      this.store.updateOpportunity(symbol, null);
      this.logSymbolSkip(symbol, "insufficient_healthy_books");
      return;
    }

    const state = this.store.snapshot();
    const openPosition = state.openPositions?.[symbol];
    let routePairs;
    if (openPosition) {
      const closePair = [openPosition.buyExchange, openPosition.sellExchange];
      const closeRouteHealth = this.checkRoutePair(symbol, healthyBooks, closePair);
      routePairs = closeRouteHealth.ok ? [closePair] : [];
    } else {
      routePairs = this.healthyRoutePairs(symbol, healthyBooks);
    }

    if (routePairs.length === 0) {
      this.store.updateOpportunity(symbol, null);
      this.logSymbolSkip(symbol, "no_healthy_route_pairs");
      return;
    }

    const opportunity = openPosition
      ? evaluateExitArbitrageAcrossBooks({
          symbol,
          position: openPosition,
          books: healthyBooks,
          config: this.config,
        })
      : evaluateArbitrageAcrossBooks({
          symbol,
          books: healthyBooks,
          routePairs,
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
    const key = `${symbol}:${details.exchange ?? ""}:${details.name ?? "error"}:${details.message ?? ""}`;
    const now = Date.now();
    const last = this.lastSymbolErrorLogAt.get(key) ?? 0;
    if (now - last < interval) return false;
    this.lastSymbolErrorLogAt.set(key, now);
    return true;
  }

  shouldLogSymbolSkip(symbol, reason) {
    return this.shouldLogSymbolSkipKey(symbol, reason);
  }

  shouldLogSymbolSkipKey(symbol, reason, scope = "") {
    const interval = this.config.symbolErrorLogIntervalMs ?? 10000;
    if (interval <= 0) return false;
    const key = `${symbol}:${reason}:${scope}`;
    const now = Date.now();
    const last = this.lastSymbolSkipLogAt.get(key) ?? 0;
    if (now - last < interval) return false;
    this.lastSymbolSkipLogAt.set(key, now);
    return true;
  }

  logSymbolSkip(symbol, reason, scope = "", details = undefined) {
    if (!this.shouldLogSymbolSkipKey(symbol, reason, scope)) return;
    this.store.appendEvent("symbol.skipped", { symbol, reason, details });
  }

  healthyRoutePairs(symbol, books) {
    const routePairs = [];
    for (const pair of this.config.routePairs) {
      const result = this.checkRoutePair(symbol, books, pair);
      if (result.ok) routePairs.push(pair);
    }
    return routePairs;
  }

  checkRoutePair(symbol, books, [leftExchange, rightExchange]) {
    const leftBook = books[leftExchange];
    const rightBook = books[rightExchange];
    const scope = `${leftExchange}:${rightExchange}`;
    if (!leftBook || !rightBook) {
      this.logSymbolSkip(symbol, "route_books_unavailable", scope, { leftExchange, rightExchange });
      return { ok: false };
    }
    const midHealth = checkCrossVenueMid(leftBook, rightBook, this.config.maxCrossVenueMidDiffBps);
    if (!midHealth.ok) {
      this.logSymbolSkip(symbol, midHealth.reason, scope, midHealth.details);
      return { ok: false };
    }
    return { ok: true };
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
    spreadBps: bookSpreadBps(book),
    rateLimited: book.rateLimited,
    rateLimitBackoffUntil: book.rateLimitBackoffUntil,
    nonce: book.nonce,
    beginNonce: book.beginNonce,
    offset: book.offset,
    bids: book.bids.slice(0, 10),
    asks: book.asks.slice(0, 10),
  };
}
