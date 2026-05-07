import test from "node:test";
import assert from "node:assert/strict";
import { consumeNotional, evaluateArbitrage, evaluateExitArbitrage } from "../src/core/arbitrage.js";
import { normalizeOrderbook } from "../src/clients/normalize.js";
import { RisexClient } from "../src/clients/risex.js";

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

function noopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
