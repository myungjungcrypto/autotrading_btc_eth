import test from "node:test";
import assert from "node:assert/strict";
import { consumeNotional, evaluateArbitrage } from "../src/core/arbitrage.js";
import { normalizeOrderbook } from "../src/clients/normalize.js";

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
