import { WebSocket } from "ws";
import { decimalToNumber } from "../lib/math.js";
import { requestJson } from "../lib/http.js";
import { normalizeOrderbook } from "./normalize.js";

export class LighterClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.connecting = false;
    this.books = new Map();
    this.waiters = new Map();
    this.marketsCache = null;
    this.subscribedMarketIds = new Set(Object.values(config.markets ?? {}).filter(Boolean).map(String));
    this.wsSubscribedMarketIds = new Set();
    this.lastOrderbookLogAt = new Map();
    this.nextConnectAt = 0;
    this.closed = false;
  }

  url(path) {
    return `${this.config.baseUrl}${this.config.apiPrefix}${path}`;
  }

  async getMarkets(forceRefresh = false) {
    if (this.marketsCache && !forceRefresh) return this.marketsCache;
    const data = await requestJson(this.url("/orderBooks"), {
      timeoutMs: this.config.timeoutMs ?? 2500,
      retries: this.config.retries ?? 0,
    });
    this.marketsCache = data.order_books ?? data.orderBooks ?? data.data?.order_books ?? data.data ?? [];
    return this.marketsCache;
  }

  resolveMarket(symbol) {
    const configured = this.config.markets[symbol];
    if (configured === undefined || configured === null || configured === "") {
      throw new Error(`Lighter market not configured for ${symbol}`);
    }
    return String(configured);
  }

  async getOrderbook(symbol, depth) {
    if (this.config.orderbookTransport !== "ws") {
      throw new Error("Lighter orderbook currently supports LIGHTER_ORDERBOOK_TRANSPORT=ws only");
    }
    return this.getOrderbookFromWs(symbol, depth);
  }

  async getOrderbookFromWs(symbol, depth) {
    const startedAt = Date.now();
    const marketId = this.resolveMarket(symbol);
    this.subscribeMarket(marketId);
    const wsAvailable = this.ensureWs();

    const cached = this.bookFromCache(symbol, marketId, depth);
    if (cached) {
      cached.readLatencyMs = Date.now() - startedAt;
      this.logOrderbook(symbol, cached);
      return cached;
    }

    if (!wsAvailable) {
      throw new Error(`Lighter WS reconnect backoff for ${marketId}`);
    }

    const book = await this.waitForBook(symbol, marketId, depth);
    book.readLatencyMs = Date.now() - startedAt;
    this.logOrderbook(symbol, book);
    return book;
  }

  ensureWs() {
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return true;
    if (Date.now() < this.nextConnectAt) return false;

    this.closed = false;
    this.connecting = true;
    this.ws = new WebSocket(this.config.wsUrl);
    this.wsSubscribedMarketIds.clear();

    this.ws.on("open", () => {
      this.connecting = false;
      this.nextConnectAt = 0;
      for (const marketId of this.subscribedMarketIds) this.sendOrderbookSubscribe(marketId);
      this.logger.info("Lighter WS connected", {
        url: this.config.wsUrl,
        markets: [...this.subscribedMarketIds],
      });
    });

    this.ws.on("message", (data) => {
      try {
        this.handleWsMessage(JSON.parse(String(data)));
      } catch (error) {
        this.logger.warn("Lighter WS message parse failed", { message: error.message });
      }
    });

    this.ws.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer?.toString?.() || `close ${code}`;
      this.connecting = false;
      this.ws = null;
      this.rejectAllWaiters(new Error("Lighter WS closed before orderbook snapshot"));
      if (!this.closed) this.scheduleReconnect(reason);
      this.logger.warn("Lighter WS closed");
    });

    this.ws.on("error", (error) => {
      this.connecting = false;
      this.ws = null;
      this.rejectAllWaiters(error);
      this.scheduleReconnect(error.message);
      this.logger.warn("Lighter WS error", { message: error.message });
    });
    return true;
  }

  subscribeMarket(marketId) {
    const key = String(marketId);
    const existed = this.subscribedMarketIds.has(key);
    this.subscribedMarketIds.add(key);
    if (!existed && this.ws?.readyState === WebSocket.OPEN) {
      this.sendOrderbookSubscribe(key);
    }
  }

  sendOrderbookSubscribe(marketId) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const key = String(marketId);
    if (this.wsSubscribedMarketIds.has(key)) return;
    this.ws.send(
      JSON.stringify({
        type: "subscribe",
        channel: `order_book/${key}`,
      }),
    );
    this.wsSubscribedMarketIds.add(key);
  }

  handleWsMessage(payload) {
    if (payload.error || payload.type === "error") {
      const message = payload.error?.message ?? payload.message ?? "unknown";
      const normalized = String(message).toLowerCase();
      if (normalized.includes("already subscribed")) return;
      if (normalized.includes("too many websocket messages")) {
        this.logger.warn("Lighter WS rate limited; reconnecting", { message });
        this.resetWs(message);
        return;
      }
      const error = new Error(`Lighter WS error: ${message}`);
      this.rejectAllWaiters(error);
      throw error;
    }

    const channel = String(payload.channel ?? "");
    if (!channel.startsWith("order_book:")) return;

    const marketId = channel.split(":")[1];
    const data = payload.order_book;
    if (!marketId || (!Array.isArray(data?.bids) && !Array.isArray(data?.asks))) return;

    const existing = this.books.get(marketId);
    const receivedAt = Date.now();
    const latencyMs = timestampLatencyMs(payload.timestamp ?? data.last_updated_at, receivedAt);
    const nonce = decimalToNumber(data.nonce);
    const beginNonce = decimalToNumber(data.begin_nonce);
    const type = String(payload.type ?? "").toLowerCase();

    if (existing) {
      if (
        Number.isFinite(beginNonce) &&
        Number.isFinite(existing.nonce) &&
        beginNonce !== existing.nonce
      ) {
        if (beginNonce < existing.nonce) return;
        this.logger.warn("Lighter orderbook nonce gap; resubscribing", {
          market: marketId,
          beginNonce,
          lastNonce: existing.nonce,
        });
        this.books.delete(marketId);
        this.resetWs(`Lighter nonce gap for ${marketId}`);
        return;
      }
      applyLevelDeltas(existing.bids, data.bids);
      applyLevelDeltas(existing.asks, data.asks);
      existing.receivedAt = receivedAt;
      existing.latencyMs = latencyMs;
      existing.nonce = Number.isFinite(nonce) ? nonce : existing.nonce;
      existing.beginNonce = Number.isFinite(beginNonce) ? beginNonce : existing.beginNonce;
      existing.offset = decimalToNumber(data.offset ?? payload.offset) || existing.offset;
      existing.lastUpdatedAt = data.last_updated_at ?? payload.last_updated_at ?? existing.lastUpdatedAt;
    } else {
      if (type.includes("update")) {
        this.logger.warn("Lighter orderbook update arrived before snapshot; reconnecting", { market: marketId });
        this.resetWs(`Lighter update before snapshot for ${marketId}`);
        return;
      }
      this.books.set(marketId, {
        bids: levelsToMap(data.bids),
        asks: levelsToMap(data.asks),
        receivedAt,
        latencyMs,
        nonce,
        beginNonce,
        offset: decimalToNumber(data.offset ?? payload.offset) || null,
        lastUpdatedAt: data.last_updated_at ?? payload.last_updated_at ?? null,
      });
    }

    this.resolveWaiters(marketId);
  }

  waitForBook(symbol, marketId, depth) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let waiter = null;
      let timeout = null;
      let resubscribe = null;

      const finish = (book, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(resubscribe);
        removeWaiter(this.waiters, marketId, waiter);
        if (error) reject(error);
        else resolve(book);
      };

      resubscribe = setTimeout(() => {
        if (settled) return;
        this.logger.warn("Lighter orderbook snapshot still pending; reconnecting", { market: marketId });
        this.resetWs(`Lighter snapshot pending for ${marketId}`);
      }, this.config.wsResubscribeMs ?? 5000);

      timeout = setTimeout(() => {
        const error = new Error(`Lighter orderbook timeout for ${marketId}`);
        finish(null, error);
        this.books.delete(marketId);
        this.resetWs(error.message);
      }, this.config.timeoutMs ?? 2500);

      const waiters = this.waiters.get(marketId) ?? [];
      waiter = { symbol, marketId, depth, finish };
      waiters.push(waiter);
      this.waiters.set(marketId, waiters);
    });
  }

  bookFromCache(symbol, marketId, depth) {
    const book = this.books.get(marketId);
    if (!book) return null;
    const normalized = normalizeOrderbook({
      exchange: "lighter",
      symbol,
      market: marketId,
      raw: {
        bids: mapToLevels(book.bids, "bid").slice(0, depth),
        asks: mapToLevels(book.asks, "ask").slice(0, depth),
      },
      receivedAt: book.receivedAt,
    });
    normalized.latencyMs = book.latencyMs ?? 0;
    normalized.wsConnected = this.ws?.readyState === WebSocket.OPEN;
    normalized.nonce = book.nonce;
    normalized.beginNonce = book.beginNonce;
    normalized.offset = book.offset;
    normalized.lastUpdatedAt = book.lastUpdatedAt;
    return normalized;
  }

  resolveWaiters(marketId) {
    const waiters = this.waiters.get(marketId);
    if (!waiters?.length) return;
    this.waiters.delete(marketId);
    for (const waiter of waiters) {
      waiter.finish(this.bookFromCache(waiter.symbol, waiter.marketId, waiter.depth));
    }
  }

  rejectAllWaiters(error) {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.finish(null, error);
    }
    this.waiters.clear();
  }

  resetWs(reason) {
    const ws = this.ws;
    this.ws = null;
    this.connecting = false;
    this.wsSubscribedMarketIds.clear();
    this.scheduleReconnect(reason);
    if (!ws) return;
    this.logger.warn("Lighter WS reconnecting", { reason });
    try {
      ws.terminate();
    } catch {
      // Ignore termination failures during reconnect.
    }
  }

  close() {
    this.rejectAllWaiters(new Error("Lighter client closed"));
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    this.connecting = false;
    this.wsSubscribedMarketIds.clear();
    if (!ws) return;
    try {
      ws.terminate();
    } catch {
      // Ignore close failures during shutdown.
    }
  }

  async placeOrder() {
    throw new Error("Lighter live order placement is not implemented yet; keep TRADING_MODE=paper");
  }

  logOrderbook(symbol, book) {
    const interval = this.config.logIntervalMs ?? 10000;
    if (interval <= 0) return;
    const now = Date.now();
    const last = this.lastOrderbookLogAt.get(symbol) ?? 0;
    if (now - last < interval) return;
    this.lastOrderbookLogAt.set(symbol, now);
    this.logger.info("Lighter orderbook", {
      symbol,
      market: book.market,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      latencyMs: book.latencyMs,
      nonce: book.nonce,
    });
  }

  scheduleReconnect(reason) {
    const backoffMs = this.config.wsReconnectBackoffMs ?? 10000;
    this.nextConnectAt = Math.max(this.nextConnectAt, Date.now() + backoffMs);
    this.logger.warn("Lighter WS reconnect backoff", { reason, backoffMs });
  }
}

function levelsToMap(levels = []) {
  const map = new Map();
  applyLevelDeltas(map, levels);
  return map;
}

function applyLevelDeltas(map, levels = []) {
  for (const level of levels ?? []) {
    const price = decimalToNumber(level.price ?? level.px ?? level[0]);
    const size = decimalToNumber(level.size ?? level.quantity ?? level.sz ?? level[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0) continue;
    if (size <= 0) map.delete(price);
    else map.set(price, { price, size });
  }
}

function mapToLevels(map, side) {
  return [...map.values()].sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
}

function timestampLatencyMs(timestamp, receivedAt) {
  const raw = Number(timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const timestampMs = raw > 1e15 ? raw / 1e6 : raw > 1e12 ? raw / 1e3 : raw;
  const latencyMs = receivedAt - timestampMs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 600000) return 0;
  return Math.round(latencyMs);
}

function removeWaiter(waitersByMarket, marketId, waiter) {
  if (!waiter) return;
  const waiters = waitersByMarket.get(marketId);
  if (!waiters) return;
  const next = waiters.filter((item) => item !== waiter);
  if (next.length) waitersByMarket.set(marketId, next);
  else waitersByMarket.delete(marketId);
}
