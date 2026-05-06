import { requestJson, withQuery } from "../lib/http.js";
import { normalizeOrderbook } from "./normalize.js";
import { WebSocket } from "ws";

export class CascadeClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
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
    const wsUrl = this.wsUrl();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      let bookPayload = null;
      let pricePayload = null;
      let graceTimer = null;
      const timeout = setTimeout(() => {
        finish(null, new Error(`Cascade orderbook timeout for ${market}`));
      }, this.config.timeoutMs ?? 8000);

      const finish = (book, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (graceTimer) clearTimeout(graceTimer);
        try {
          ws.terminate();
        } catch {
          // Ignore close failures while resolving a completed fetch.
        }
        if (error) reject(error);
        else resolve(book);
      };

      const maybeFinish = () => {
        if (!bookPayload) return;
        if (!pricePayload && !graceTimer) {
          graceTimer = setTimeout(maybeFinish, 250);
          return;
        }
        finish(
          normalizeOrderbook({
            exchange: "cascade",
            symbol,
            market,
            raw: {
              bids: bookPayload.bids.slice(0, depth),
              asks: bookPayload.asks.slice(0, depth),
              mark: pricePayload?.mark,
              index: pricePayload?.index,
              midpoint: pricePayload?.midpoint,
              spread: pricePayload?.spread,
            },
          }),
        );
      };

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "subscribe",
            params: {
              source: "book",
              symbol: market,
              tickSize: this.config.orderbookTickSize,
            },
            id: 1,
          }),
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "subscribe",
            params: {
              source: "price",
              symbols: [market],
            },
            id: 2,
          }),
        );
      });

      ws.on("message", (data) => {
        try {
          const payload = JSON.parse(String(data));
          if (payload.error) {
            finish(null, new Error(`Cascade WS error: ${payload.error.message ?? "unknown"}`));
            return;
          }
          const bookData = payload.data;
          if (!bookData || bookData.symbol !== market) return;
          if (bookData.bids && bookData.asks && payload.type === "Book Snapshot") {
            bookPayload = bookData;
            maybeFinish();
            return;
          }
          if (bookData.mark || bookData.index || bookData.midpoint) {
            pricePayload = bookData;
            maybeFinish();
          }
        } catch (error) {
          finish(null, error);
        }
      });

      ws.on("error", (error) => {
        finish(null, error);
      });
    });
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
