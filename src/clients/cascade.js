import { requestJson, withQuery } from "../lib/http.js";
import { normalizeOrderbook } from "./normalize.js";

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
