import { requestJson, withQuery } from "../lib/http.js";
import { normalizeOrderbook } from "./normalize.js";
import { WebSocket } from "ws";

export class CascadeClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.connecting = false;
    this.nextRequestId = 1;
    this.subscribedMarkets = new Set(Object.values(config.markets ?? {}).filter(Boolean));
    this.books = new Map();
    this.waiters = new Map();
  }

  url(path) {
    return `${this.config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  authHeaders() {
    return this.config.jwt ? { authorization: `Bearer ${this.config.jwt}` } : {};
  }

  async getOrderbook(symbol, depth) {
    if (this.config.orderbookTransport === "ws") {
      return this.getOrderbookFromWs(symbol, depth);
    }

    const market = this.config.markets[symbol];
    const raw = await requestJson(
      withQuery(this.url(this.config.orderbookPath), {
        [this.config.orderbookQueryParam]: market,
        limit: depth,
      }),
      { headers: this.authHeaders() },
    );
    return normalizeOrderbook({
      exchange: "cascade",
      symbol,
      market,
      raw,
    });
  }

  async getOrderbookFromWs(symbol, depth) {
    const market = this.config.markets[symbol];
    this.ensureWs();
    this.subscribeMarket(market);

    const cached = this.bookFromCache(symbol, market, depth);
    if (cached) return cached;

    return this.waitForBook(symbol, market, depth);
  }

  ensureWs() {
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
    const wsUrl = this.wsUrl();
    this.connecting = true;
    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      this.connecting = false;
      for (const market of this.subscribedMarkets) this.sendBookSubscribe(market);
      this.logger.info("Cascade WS connected", { url: wsUrl, markets: [...this.subscribedMarkets] });
    });

    this.ws.on("message", (data) => {
      try {
        this.handleWsMessage(JSON.parse(String(data)));
      } catch (error) {
        this.logger.warn("Cascade WS message parse failed", { message: error.message });
      }
    });

    this.ws.on("close", () => {
      this.connecting = false;
      this.ws = null;
      this.rejectAllWaiters(new Error("Cascade WS closed before orderbook snapshot"));
      this.logger.warn("Cascade WS closed");
    });

    this.ws.on("error", (error) => {
      this.connecting = false;
      this.ws = null;
      this.rejectAllWaiters(error);
      this.logger.warn("Cascade WS error", { message: error.message });
    });
  }

  subscribeMarket(market) {
    if (this.subscribedMarkets.has(market)) return;
    this.subscribedMarkets.add(market);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendBookSubscribe(market);
  }

  sendBookSubscribe(market) {
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "subscribe",
        params: {
          source: "book",
          symbol: market,
          tickSize: this.config.orderbookTickSize,
        },
        id: this.nextRequestId,
      }),
    );
    this.nextRequestId += 1;
  }

  handleWsMessage(payload) {
    if (payload.error) {
      const error = new Error(`Cascade WS error: ${payload.error.message ?? "unknown"}`);
      this.rejectAllWaiters(error);
      throw error;
    }
    const data = payload.data;
    if (!data?.symbol || (!Array.isArray(data.bids) && !Array.isArray(data.asks))) return;

    const type = String(payload.type ?? "").toLowerCase();
    if (type.includes("snapshot")) {
      this.books.set(data.symbol, {
        bids: levelsToMap(data.bids),
        asks: levelsToMap(data.asks),
        receivedAt: Date.now(),
        sequenceNumber: data.sequenceNumber,
      });
    } else if (type.includes("delta")) {
      const book = this.books.get(data.symbol);
      if (!book) return;
      applyLevelDeltas(book.bids, data.bids);
      applyLevelDeltas(book.asks, data.asks);
      book.receivedAt = Date.now();
      book.sequenceNumber = data.sequenceNumber ?? book.sequenceNumber;
    } else {
      return;
    }

    this.resolveWaiters(data.symbol);
  }

  waitForBook(symbol, market, depth) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let waiter = null;

      const finish = (book, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeWaiter(this.waiters, market, waiter);
        if (error) reject(error);
        else resolve(book);
      };

      const timeout = setTimeout(() => {
        const error = new Error(`Cascade orderbook timeout for ${market}`);
        finish(null, error);
        this.books.delete(market);
        this.resetWs(error.message);
      }, this.config.timeoutMs ?? 8000);

      const waiters = this.waiters.get(market) ?? [];
      waiter = { symbol, market, depth, finish };
      waiters.push(waiter);
      this.waiters.set(market, waiters);
    });
  }

  bookFromCache(symbol, market, depth) {
    const book = this.books.get(market);
    if (!book) return null;
    return normalizeOrderbook({
      exchange: "cascade",
      symbol,
      market,
      raw: {
        bids: mapToLevels(book.bids, "bid").slice(0, depth),
        asks: mapToLevels(book.asks, "ask").slice(0, depth),
      },
      receivedAt: this.ws?.readyState === WebSocket.OPEN ? Date.now() : book.receivedAt,
    });
  }

  resolveWaiters(market) {
    const waiters = this.waiters.get(market);
    if (!waiters?.length) return;
    this.waiters.delete(market);
    for (const waiter of waiters) {
      waiter.finish(this.bookFromCache(waiter.symbol, waiter.market, waiter.depth));
    }
  }

  rejectAllWaiters(error) {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.finish(null, error);
    }
    this.waiters.clear();
  }

  close() {
    this.rejectAllWaiters(new Error("Cascade client closed"));
    const ws = this.ws;
    this.ws = null;
    this.connecting = false;
    if (!ws) return;
    try {
      ws.terminate();
    } catch {
      // Ignore close failures during shutdown.
    }
  }

  resetWs(reason) {
    const ws = this.ws;
    this.ws = null;
    this.connecting = false;
    if (!ws) return;
    this.logger.warn("Cascade WS reconnecting", { reason });
    try {
      ws.terminate();
    } catch {
      // Ignore termination failures during reconnect.
    }
  }

  wsUrl() {
    const wsBase = this.config.baseUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
    return `${wsBase}${this.config.wsPath}`;
  }

  async getPositions() {
    if (!this.config.jwt) return null;
    return requestJson(this.url(this.config.positionsPath), {
      headers: this.authHeaders(),
    });
  }

  async placeOrder(order) {
    if (!this.config.jwt) {
      throw new Error("CASCADE_JWT is required for live Cascade orders");
    }
    const body = {
      market: this.config.markets[order.symbol],
      side: order.side,
      size: String(order.size),
      price: String(order.price),
      type: "limit",
      timeInForce: "IOC",
      reduceOnly: Boolean(order.reduceOnly),
      clientOrderId: order.clientOrderId,
    };
    return requestJson(this.url(this.config.placeOrderPath), {
      method: "POST",
      headers: this.authHeaders(),
      body,
      retries: 0,
    });
  }
}

function levelsToMap(levels = []) {
  const map = new Map();
  applyLevelDeltas(map, levels);
  return map;
}

function applyLevelDeltas(map, levels = []) {
  for (const level of levels) {
    const price = Number(level.price ?? level[0]);
    const quantity = Number(level.quantity ?? level.size ?? level[1]);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) continue;
    if (quantity <= 0) map.delete(price);
    else map.set(price, { price, quantity });
  }
}

function mapToLevels(map, side) {
  return [...map.values()].sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
}

function removeWaiter(waitersByMarket, market, waiter) {
  if (!waiter) return;
  const waiters = waitersByMarket.get(market);
  if (!waiters) return;
  const next = waiters.filter((item) => item !== waiter);
  if (next.length) waitersByMarket.set(market, next);
  else waitersByMarket.delete(market);
}
