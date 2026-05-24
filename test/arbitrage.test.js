import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeNotional,
  evaluateArbitrage,
  evaluateArbitrageAcrossBooks,
  evaluateExitArbitrage,
} from "../src/core/arbitrage.js";
import { normalizeOrderbook } from "../src/clients/normalize.js";
import { CascadeClient } from "../src/clients/cascade.js";
import { LighterClient } from "../src/clients/lighter.js";
import { RisexClient } from "../src/clients/risex.js";
import { bookSpreadBps, checkBookHealth, checkBookMove, checkCrossVenueMid } from "../src/core/risk.js";

test("consumeNotional calculates VWAP across levels", () => {
  const result = consumeNotional(
    [
      { price: 100, size: 1 },
      { price: 101, size: 2 },
    ],
    201,
  );
  assert.equal(result.complete, true);
  assert.equal(result.size, 2);
  assert.equal(result.avgPrice, 100.5);
});

test("evaluateArbitrage selects profitable cascade buy and risex sell", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD",
    raw: {
      bids: [[99900, 1]],
      asks: [[100000, 1]],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "BTC",
    market: "1",
    raw: {
      bids: [{ price: "100200", quantity: "1" }],
      asks: [{ price: "100250", quantity: "1" }],
    },
  });

  const opp = evaluateArbitrage({
    symbol: "BTC",
    cascadeBook,
    risexBook,
    config: {
      maxTradeUsd: 1000,
      minTradeUsd: 10,
      minEdgeBps: 5,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(opp.buyExchange, "cascade");
  assert.equal(opp.sellExchange, "risex");
  assert.equal(opp.symbol, "BTC");
  assert.ok(opp.netBps > 5);
});

test("evaluateArbitrage rejects spread below threshold", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "ETH",
    market: "ETH-USD",
    raw: {
      bids: [[3000, 10]],
      asks: [[3001, 10]],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "ETH",
    market: "2",
    raw: {
      bids: [[3001.5, 10]],
      asks: [[3002, 10]],
    },
  });

  const opp = evaluateArbitrage({
    symbol: "ETH",
    cascadeBook,
    risexBook,
    config: {
      maxTradeUsd: 1000,
      minTradeUsd: 10,
      minEdgeBps: 10,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(opp, null);
});

test("evaluateArbitrage only consumes levels with profitable marginal edge", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    raw: {
      bids: [[99, 20]],
      asks: [
        [100, 1],
        [105, 20],
      ],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "BTC",
    market: "1",
    raw: {
      bids: [
        [101, 1],
        [100, 20],
      ],
      asks: [[102, 20]],
    },
  });

  const opp = evaluateArbitrage({
    symbol: "BTC",
    cascadeBook,
    risexBook,
    config: {
      maxTradeUsd: 1000,
      minTradeUsd: 10,
      minEdgeBps: 50,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(opp.buyExchange, "cascade");
  assert.equal(opp.sellExchange, "risex");
  assert.equal(opp.size, 1);
  assert.equal(opp.notionalUsd, 100);
  assert.equal(opp.buyFills.length, 1);
  assert.equal(opp.sellFills.length, 1);
});

test("evaluateArbitrage matches the same base size on both legs", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    raw: {
      bids: [[99, 10]],
      asks: [[100, 2]],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "BTC",
    market: "1",
    raw: {
      bids: [[110, 1]],
      asks: [[111, 10]],
    },
  });

  const opp = evaluateArbitrage({
    symbol: "BTC",
    cascadeBook,
    risexBook,
    config: {
      maxTradeUsd: 1000,
      minTradeUsd: 10,
      minEdgeBps: 1,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(opp.size, 1);
  assert.equal(opp.notionalUsd, 100);
  assert.equal(opp.expectedPnlUsd, 10);
});

test("evaluateArbitrageAcrossBooks selects the best configured Lighter route", () => {
  const books = {
    lighter: normalizeOrderbook({
      exchange: "lighter",
      symbol: "BTC",
      market: "1",
      raw: {
        bids: [[99.9, 10]],
        asks: [[100, 10]],
      },
    }),
    cascade: normalizeOrderbook({
      exchange: "cascade",
      symbol: "BTC",
      market: "BTC-USD-PERP",
      raw: {
        bids: [[99.7, 10]],
        asks: [[99.8, 10]],
      },
    }),
    risex: normalizeOrderbook({
      exchange: "risex",
      symbol: "BTC",
      market: "1",
      raw: {
        bids: [[101, 10]],
        asks: [[101.2, 10]],
      },
    }),
  };

  const opp = evaluateArbitrageAcrossBooks({
    symbol: "BTC",
    books,
    routePairs: [
      ["lighter", "cascade"],
      ["lighter", "risex"],
    ],
    config: {
      maxTradeUsd: 1000,
      minTradeUsd: 10,
      entryEdgeBps: 1,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(opp.buyExchange, "lighter");
  assert.equal(opp.sellExchange, "risex");
  assert.ok(opp.netBps > 90);
});

test("evaluateExitArbitrage closes when entry spread returns to exit threshold", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    raw: {
      bids: [[100, 2]],
      asks: [[100.2, 2]],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "BTC",
    market: "1",
    raw: {
      bids: [[100.1, 2]],
      asks: [[100.3, 2]],
    },
  });

  const close = evaluateExitArbitrage({
    symbol: "BTC",
    position: {
      id: "pos-1",
      symbol: "BTC",
      buyExchange: "cascade",
      sellExchange: "risex",
      size: 1,
      entryBuyPrice: 100,
      entrySellPrice: 101,
      entryBuyNotional: 100,
      entrySellNotional: 101,
      entryCostUsd: 0,
    },
    cascadeBook,
    risexBook,
    config: {
      exitEdgeBps: 0,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(close.action, "close");
  assert.equal(close.buyExchange, "risex");
  assert.equal(close.sellExchange, "cascade");
  assert.equal(close.size, 1);
  assert.equal(close.expectedPnlUsd, 0.7);
});

test("evaluateExitArbitrage holds while entry spread is still above exit threshold", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    raw: {
      bids: [[100, 2]],
      asks: [[100, 2]],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "BTC",
    market: "1",
    raw: {
      bids: [[101, 2]],
      asks: [[101.2, 2]],
    },
  });

  const close = evaluateExitArbitrage({
    symbol: "BTC",
    position: {
      id: "pos-1",
      symbol: "BTC",
      buyExchange: "cascade",
      sellExchange: "risex",
      size: 1,
      entryBuyPrice: 100,
      entrySellPrice: 101,
      entryBuyNotional: 100,
      entrySellNotional: 101,
      entryCostUsd: 0,
    },
    cascadeBook,
    risexBook,
    config: {
      exitEdgeBps: 0,
      takerFeeBps: 0,
      slippageBufferBps: 0,
    },
  });

  assert.equal(close, null);
});

test("RisexClient applies WebSocket orderbook snapshots and deltas", () => {
  const client = new RisexClient(
    {
      markets: { BTC: "1" },
      orderbookTransport: "ws",
      wsUrl: "wss://ws.testnet.rise.trade/ws",
    },
    noopLogger(),
  );

  client.handleWsMessage({
    channel: "orderbook",
    data: {
      market_id: 1,
      bids: [{ price: "100000000000000000000", quantity: "1000000000000000000" }],
      asks: [{ price: "101", quantity: "2" }],
    },
    timestamp: String(Date.now() * 1_000_000),
  });

  const snapshot = client.bookFromCache("BTC", "1", 10);
  assert.equal(snapshot.bestBid, 100);
  assert.equal(snapshot.bestAsk, 101);
  assert.equal(snapshot.bids[0].size, 1);

  client.handleWsMessage({
    channel: "orderbook",
    type: "update",
    market_id: "1",
    data: {
      market_id: 1,
      bids: [{ price: "100000000000000000000", quantity: "0" }],
      asks: [{ price: "102", quantity: "1.5" }],
    },
  });

  const updated = client.bookFromCache("BTC", "1", 10);
  assert.equal(updated.bestBid, null);
  assert.equal(updated.bestAsk, 101);
  assert.equal(updated.asks[1].price, 102);
});

test("CascadeClient preserves the real last update time for stale detection", () => {
  const client = new CascadeClient(
    {
      baseUrl: "https://engine.cascade.xyz",
      markets: { BTC: "BTC-USD-PERP" },
      wsPath: "/ws",
      orderbookTickSize: 0.1,
    },
    noopLogger(),
  );
  client.books.set("BTC-USD-PERP", {
    bids: new Map([[100, { price: 100, quantity: 1 }]]),
    asks: new Map([[101, { price: 101, quantity: 1 }]]),
    receivedAt: 12345,
  });

  const book = client.bookFromCache("BTC", "BTC-USD-PERP", 10);
  assert.equal(book.receivedAt, 12345);
});

test("LighterClient applies WebSocket orderbook snapshots and deltas", () => {
  const client = new LighterClient(
    {
      baseUrl: "https://mainnet.zklighter.elliot.ai",
      apiPrefix: "/api/v1",
      markets: { BTC: "1" },
      orderbookTransport: "ws",
      wsUrl: "wss://mainnet.zklighter.elliot.ai/stream",
    },
    noopLogger(),
  );

  client.handleWsMessage({
    channel: "order_book:1",
    order_book: {
      bids: [{ price: "100", size: "1" }],
      asks: [{ price: "101", size: "2" }],
      nonce: 10,
      begin_nonce: 0,
      offset: 1000,
    },
    timestamp: Date.now(),
    type: "update/order_book",
  });

  const snapshot = client.bookFromCache("BTC", "1", 10);
  assert.equal(snapshot.bestBid, 100);
  assert.equal(snapshot.bestAsk, 101);
  assert.equal(snapshot.bids[0].size, 1);
  assert.equal(snapshot.nonce, 10);

  client.handleWsMessage({
    channel: "order_book:1",
    order_book: {
      bids: [{ price: "100", size: "0" }],
      asks: [{ price: "102", size: "1.5" }],
      nonce: 11,
      begin_nonce: 10,
      offset: 1001,
    },
    timestamp: Date.now(),
    type: "update/order_book",
  });

  const updated = client.bookFromCache("BTC", "1", 10);
  assert.equal(updated.bestBid, null);
  assert.equal(updated.bestAsk, 101);
  assert.equal(updated.asks[1].price, 102);
  assert.equal(updated.nonce, 11);
});

test("LighterClient drops local book on nonce gap", () => {
  const client = new LighterClient(
    {
      baseUrl: "https://mainnet.zklighter.elliot.ai",
      apiPrefix: "/api/v1",
      markets: { ETH: "0" },
      orderbookTransport: "ws",
      wsUrl: "wss://mainnet.zklighter.elliot.ai/stream",
    },
    noopLogger(),
  );

  client.handleWsMessage({
    channel: "order_book:0",
    order_book: {
      bids: [{ price: "2000", size: "1" }],
      asks: [{ price: "2001", size: "1" }],
      nonce: 20,
      begin_nonce: 0,
    },
    type: "update/order_book",
  });
  client.handleWsMessage({
    channel: "order_book:0",
    order_book: {
      bids: [{ price: "2002", size: "1" }],
      asks: [],
      nonce: 22,
      begin_nonce: 19,
    },
    type: "update/order_book",
  });

  assert.equal(client.bookFromCache("ETH", "0", 10), null);
});

test("checkBookHealth rejects sparse books with excessive internal spread", () => {
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "BTC",
    market: "1",
    raw: {
      bids: [[77977.2, 60.5]],
      asks: [[87500, 70.7]],
    },
  });

  assert.ok(bookSpreadBps(risexBook) > 1000);
  const health = checkBookHealth(risexBook, 100);
  assert.equal(health.ok, false);
  assert.equal(health.reason, "wide_book_spread");
  assert.equal(health.details.exchange, "risex");
});

test("checkBookMove rejects sudden mid price jumps from the last healthy book", () => {
  const previousBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    receivedAt: 10_000,
    raw: {
      bids: [[100, 1]],
      asks: [[101, 1]],
    },
  });
  const currentBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    receivedAt: 11_000,
    raw: {
      bids: [[110, 1]],
      asks: [[111, 1]],
    },
  });

  const result = checkBookMove(currentBook, previousBook, {
    maxBookMidMoveBps: 500,
    staleBookMs: 15_000,
    now: 11_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "book_mid_jump");
});

test("checkBookMove ignores stale previous books when comparing jumps", () => {
  const previousBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    receivedAt: 1_000,
    raw: {
      bids: [[100, 1]],
      asks: [[101, 1]],
    },
  });
  const currentBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "BTC",
    market: "BTC-USD-PERP",
    receivedAt: 30_000,
    raw: {
      bids: [[110, 1]],
      asks: [[111, 1]],
    },
  });

  const result = checkBookMove(currentBook, previousBook, {
    maxBookMidMoveBps: 500,
    staleBookMs: 15_000,
    now: 30_000,
  });

  assert.equal(result.ok, true);
});

test("checkCrossVenueMid rejects large Cascade and RISEx mid divergence", () => {
  const cascadeBook = normalizeOrderbook({
    exchange: "cascade",
    symbol: "ETH",
    market: "ETH-USD-PERP",
    raw: {
      bids: [[2000, 10]],
      asks: [[2001, 10]],
    },
  });
  const risexBook = normalizeOrderbook({
    exchange: "risex",
    symbol: "ETH",
    market: "2",
    raw: {
      bids: [[2100, 10]],
      asks: [[2101, 10]],
    },
  });

  const result = checkCrossVenueMid(cascadeBook, risexBook, 300);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cross_venue_mid_divergence");
});

function noopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
