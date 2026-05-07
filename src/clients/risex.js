import { requestJson, withQuery } from "../lib/http.js";
import { decimalToNumber } from "../lib/math.js";
import { normalizeOrderbook } from "./normalize.js";
import { WebSocket } from "ws";

export class RisexClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.marketsCache = null;
    this.orderbookCache = new Map();
    this.inFlightOrderbooks = new Map();
    this.backoffUntil = new Map();
    this.lastOrderbookLogAt = new Map();
    this.lastErrorLogAt = new Map();
    this.ws = null;
    this.connecting = false;
    this.subscribedMarketIds = new Set();
    this.books = new Map();
    this.waiters = new Map();
  }

  url(path) {
    return `${this.config.baseUrl}${this.config.apiPrefix}${path}`;
  }

  async getMarkets(forceRefresh = false) {
    if (this.marketsCache && !forceRefresh) return this.marketsCache;
    const data = await requestJson(withQuery(this.url("/markets"), { force_refresh: forceRefresh }));
    this.marketsCache = data.data?.markets ?? data.markets ?? [];
    return this.marketsCache;
  }

  async resolveMarket(symbol) {
    const configured = this.config.markets[symbol];
    if (/^\d+$/.test(String(configured))) {
      return { market_id: String(configured), config: {} };
    }
    const markets = await this.getMarkets();
    const wanted = String(configured).toUpperCase();
    const found = markets.find((market) => {
      const names = [
        market.market_id,
        market.display_name,
        market.base_asset_symbol,
        market.underlying,
        market.config?.name,
      ]
        .filter(Boolean)
        .map((item) => String(item).toUpperCase());
      return names.includes(wanted) || names.includes(symbol.toUpperCase());
    });
    if (!found) {
      throw new Error(`RISEx market not found for ${symbol} (${configured})`);
    }
    return found;
  }

  async getOrderbook(symbol, depth) {
    if (this.config.orderbookTransport === "ws") {
      return this.getOrderbookFromWs(symbol, depth);
    }
    return this.getOrderbookFromRest(symbol, depth);
  }

  async getOrderbookFromWs(symbol, depth) {
    const startedAt = Date.now();
    const market = await this.resolveMarket(symbol);
    const marketId = String(market.market_id);
    this.subscribeMarket(marketId);
    this.ensureWs();

    const cached = this.bookFromCache(symbol, marketId, depth);
    if (cached) {
      cached.readLatencyMs = Date.now() - startedAt;
      this.logOrderbook(symbol, cached);
      return cached;
    }

    const book = await this.waitForBook(symbol, marketId, depth);
    book.readLatencyMs = Date.now() - startedAt;
    this.logOrderbook(symbol, book);
    return book;
  }

  async getOrderbookFromRest(symbol, depth) {
    const cached = this.orderbookCache.get(symbol);
    const now = Date.now();
    const backoffUntil = this.backoffUntil.get(symbol) ?? 0;
    if (cached && now < backoffUntil) {
      cached.rateLimited = true;
      cached.rateLimitBackoffUntil = backoffUntil;
      return cached;
    }
    if (cached && now - cached.fetchedAt < (this.config.pollIntervalMs ?? 1000)) {
      cached.rateLimited = false;
      return cached;
    }
    if (this.inFlightOrderbooks.has(symbol)) return this.inFlightOrderbooks.get(symbol);

    const request = this.fetchOrderbook(symbol, depth, cached);
    this.inFlightOrderbooks.set(symbol, request);
    try {
      return await request;
    } finally {
      this.inFlightOrderbooks.delete(symbol);
    }
  }

  ensureWs() {
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
    this.connecting = true;
    this.ws = new WebSocket(this.config.wsUrl);

    this.ws.on("open", () => {
      this.connecting = false;
      this.sendOrderbookSubscribe([...this.subscribedMarketIds]);
      this.logger.info("RISEx WS connected", {
        url: this.config.wsUrl,
        markets: [...this.subscribedMarketIds],
      });
    });

    this.ws.on("message", (data) => {
      try {
        this.handleWsMessage(JSON.parse(String(data)));
      } catch (error) {
        this.logger.warn("RISEx WS message parse failed", { message: error.message });
      }
    });

    this.ws.on("close", () => {
      this.connecting = false;
      this.ws = null;
      this.rejectAllWaiters(new Error("RISEx WS closed before orderbook snapshot"));
      this.logger.warn("RISEx WS closed");
    });

    this.ws.on("error", (error) => {
      this.connecting = false;
      this.ws = null;
      this.rejectAllWaiters(error);
      this.logger.warn("RISEx WS error", { message: error.message });
    });
  }

  subscribeMarket(marketId) {
    const existed = this.subscribedMarketIds.has(marketId);
    this.subscribedMarketIds.add(marketId);
    if (!existed && this.ws?.readyState === WebSocket.OPEN) {
      this.sendOrderbookSubscribe([marketId]);
    }
  }

  sendOrderbookSubscribe(marketIds) {
    if (!marketIds.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        method: "subscribe",
        params: {
          channel: "orderbook",
          market_ids: marketIds.map((marketId) => {
            const numeric = Number(marketId);
            return Number.isFinite(numeric) ? numeric : marketId;
          }),
        },
      }),
    );
  }

  handleWsMessage(payload) {
    if (payload.error || payload.status === "error") {
      const message = payload.error?.message ?? payload.message ?? "unknown";
      const error = new Error(`RISEx WS error: ${message}`);
      this.rejectAllWaiters(error);
      throw error;
    }
    if (payload.channel !== "orderbook") return;

    const data = payload.data;
    const marketId = String(payload.market_id ?? data?.market_id ?? "");
    if (!marketId || (!Array.isArray(data?.bids) && !Array.isArray(data?.asks))) return;

    const type = String(payload.type ?? payload.method ?? "").toLowerCase();
    const existing = this.books.get(marketId);
    const receivedAt = Date.now();
    const latencyMs = timestampLatencyMs(payload.timestamp ?? payload.worker_timestamp, receivedAt);

    if (type.includes("update") && !existing) {
      this.logger.warn("RISEx orderbook update arrived before snapshot; resubscribing", { market: marketId });
      this.sendOrderbookSubscribe([marketId]);
      return;
    }

    if (type.includes("update") && existing) {
      applyLevelDeltas(existing.bids, data.bids);
      applyLevelDeltas(existing.asks, data.asks);
      existing.receivedAt = receivedAt;
      existing.latencyMs = latencyMs;
      existing.blockNumber = payload.block_number ?? existing.blockNumber;
      existing.logIndex = payload.log_index ?? existing.logIndex;
      existing.checksum = payload.checksum ?? existing.checksum;
    } else {
      this.books.set(marketId, {
        bids: levelsToMap(data.bids),
        asks: levelsToMap(data.asks),
        receivedAt,
        latencyMs,
        blockNumber: payload.block_number,
        logIndex: payload.log_index,
        checksum: payload.checksum,
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
        this.logger.warn("RISEx orderbook snapshot still pending; resubscribing", { market: marketId });
        this.sendOrderbookSubscribe([marketId]);
      }, this.config.wsResubscribeMs ?? 5000);

      timeout = setTimeout(() => {
        const error = new Error(`RISEx orderbook timeout for ${marketId}`);
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
      exchange: "risex",
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
    normalized.blockNumber = book.blockNumber;
    normalized.logIndex = book.logIndex;
    normalized.checksum = book.checksum;
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
    if (!ws) return;
    this.logger.warn("RISEx WS reconnecting", { reason });
    try {
      ws.terminate();
    } catch {
      // Ignore termination failures during reconnect.
    }
  }

  close() {
    this.rejectAllWaiters(new Error("RISEx client closed"));
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

  async fetchOrderbook(symbol, depth, cached) {
    const startedAt = Date.now();
    const market = await this.resolveMarket(symbol);
    let raw;
    try {
      raw = await requestJson(
        withQuery(this.url("/orderbook"), {
          market_id: market.market_id,
          limit: depth,
        }),
        {
          timeoutMs: this.config.timeoutMs ?? 2500,
          retries: this.config.retries ?? 0,
        },
      );
    } catch (error) {
      if (error.status === 429) {
        const backoffUntil = Date.now() + (this.config.rateLimitBackoffMs ?? 10000);
        this.backoffUntil.set(symbol, backoffUntil);
        this.logOrderbookError(symbol, error, "RISEx rate limited; using cached orderbook when available");
        if (cached) {
          cached.rateLimited = true;
          cached.rateLimitBackoffUntil = backoffUntil;
          return cached;
        }
      }
      this.logOrderbookError(symbol, error, "RISEx orderbook request failed");
      if (cached) return cached;
      throw error;
    }

    const book = normalizeOrderbook({
      exchange: "risex",
      symbol,
      market: market.market_id,
      raw: raw.data ?? raw,
    });
    book.latencyMs = Date.now() - startedAt;
    book.fetchedAt = Date.now();
    book.rateLimited = false;
    book.rateLimitBackoffUntil = null;
    this.backoffUntil.delete(symbol);
    this.orderbookCache.set(symbol, book);
    this.logOrderbook(symbol, book);
    return book;
  }

  logOrderbook(symbol, book) {
    const interval = this.config.logIntervalMs ?? 10000;
    if (interval <= 0) return;
    const now = Date.now();
    const last = this.lastOrderbookLogAt.get(symbol) ?? 0;
    if (now - last < interval) return;
    this.lastOrderbookLogAt.set(symbol, now);
    this.logger.info("RISEx orderbook", {
      symbol,
      market: book.market,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      latencyMs: book.latencyMs,
    });
  }

  logOrderbookError(symbol, error, message) {
    const interval = this.config.errorLogIntervalMs ?? 10000;
    if (interval <= 0) return;
    const key = `${symbol}:${error.status ?? error.name ?? "error"}`;
    const now = Date.now();
    const last = this.lastErrorLogAt.get(key) ?? 0;
    if (now - last < interval) return;
    this.lastErrorLogAt.set(key, now);
    this.logger.warn(message, {
      symbol,
      status: error.status,
      message: error.message,
      backoffMs: this.config.rateLimitBackoffMs ?? 10000,
    });
  }

  async getPortfolio() {
    if (!this.config.account) return null;
    return requestJson(withQuery(this.url("/portfolio/details"), { account: this.config.account }));
  }

  async getTradeHistory({ startTimeNs, endTimeNs, limit = 1000 } = {}) {
    if (!this.config.account) return { trades: [] };
    return requestJson(
      withQuery(this.url("/trade-history"), {
        account: this.config.account,
        start_time: startTimeNs,
        end_time: endTimeNs,
        limit,
        sorted_by: "-time",
      }),
    );
  }

  async getNonceState() {
    if (!this.config.account) throw new Error("RISEX_ACCOUNT is required for live orders");
    return requestJson(this.url(`/nonce-state/${this.config.account}`));
  }

  async buildPermit() {
    if (!this.config.account || !this.config.signer) {
      throw new Error("RISEX_ACCOUNT and RISEX_SIGNER are required for live orders");
    }
    const nonce = await this.getNonceState();
    const permit = {
      account: this.config.account,
      signer: this.config.signer,
      nonce_anchor: nonce.nonce_anchor ?? "0",
      nonce_bitmap_index: Number(nonce.current_bitmap_index ?? 0),
      deadline: Math.floor(Date.now() / 1000) + 60,
    };
    if (this.config.enableTestnetServerSigning && this.config.signerPrivateKey) {
      permit.signer_private_key = this.config.signerPrivateKey;
    } else {
      throw new Error(
        "RISEx live orders require a permit signature. Enable testnet server signing or add client-side EIP-712 signing.",
      );
    }
    return permit;
  }

  async placeOrder(order) {
    const market = await this.resolveMarket(order.symbol);
    const marketConfig = market.config ?? {};
    const stepSize = decimalToNumber(marketConfig.step_size) || 1;
    const stepPrice = decimalToNumber(marketConfig.step_price) || 1;
    const body = {
      market_id: Number(market.market_id),
      size_steps: Math.max(1, Math.floor(order.size / stepSize)),
      price_ticks: Math.max(1, Math.floor(order.price / stepPrice)),
      side: order.side === "buy" ? 0 : 1,
      post_only: false,
      reduce_only: Boolean(order.reduceOnly),
      stp_mode: 2,
      order_type: 1,
      time_in_force: 3,
      builder_id: 0,
      client_order_id: String(order.clientOrderId ?? "0"),
      ttl_units: 0,
      permit: await this.buildPermit(),
      no_retry: true,
    };
    return requestJson(this.url("/orders/place"), {
      method: "POST",
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
  for (const level of levels ?? []) {
    const price = decimalToNumber(level.price ?? level.px ?? level[0]);
    const quantity = decimalToNumber(level.quantity ?? level.size ?? level.sz ?? level[1]);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0) continue;
    if (quantity <= 0) map.delete(price);
    else {
      map.set(price, {
        price,
        quantity,
        order_count: decimalToNumber(level.order_count ?? level.orders ?? level.n ?? 0),
      });
    }
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
