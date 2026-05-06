import { normalizeOrderbook } from "./normalize.js";

export class MockExchangeClient {
  constructor({ exchange, markets, skewBps = 0 }) {
    this.exchange = exchange;
    this.markets = markets;
    this.skewBps = skewBps;
    this.startedAt = Date.now();
  }

  async getOrderbook(symbol, depth = 20) {
    const base = symbol === "BTC" ? 100000 : 3000;
    const t = (Date.now() - this.startedAt) / 1000;
    const wave = Math.sin(t / 7 + (symbol === "BTC" ? 0 : 1.7)) * 8;
    const venueSkew = (base * this.skewBps) / 10000;
    const mid = base + wave + venueSkew;
    const spread = symbol === "BTC" ? 8 : 0.8;
    const levels = Math.max(1, depth);
    const bids = [];
    const asks = [];

    for (let i = 0; i < levels; i += 1) {
      const step = symbol === "BTC" ? 4 : 0.4;
      const size = symbol === "BTC" ? 0.02 + i * 0.005 : 0.5 + i * 0.08;
      bids.push([mid - spread / 2 - i * step, size]);
      asks.push([mid + spread / 2 + i * step, size]);
    }

    return normalizeOrderbook({
      exchange: this.exchange,
      symbol,
      market: this.markets[symbol],
      raw: { bids, asks },
    });
  }

  async getPortfolio() {
    return { mock: true };
  }

  async getTradeHistory() {
    return { trades: [] };
  }

  async placeOrder(order) {
    return {
      mock: true,
      order_id: `mock-${this.exchange}-${Date.now()}`,
      order,
    };
  }
}
