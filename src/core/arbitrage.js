import { bps, round } from "../lib/math.js";

export function consumeNotional(levels, notionalUsd) {
  let remaining = notionalUsd;
  let qty = 0;
  let spent = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 0) break;
    const levelNotional = level.price * level.size;
    const takeNotional = Math.min(remaining, levelNotional);
    const takeQty = takeNotional / level.price;
    qty += takeQty;
    spent += takeNotional;
    remaining -= takeNotional;
    fills.push({ price: level.price, size: takeQty, notional: takeNotional });
  }
  if (spent <= 0 || qty <= 0) return null;
  return {
    notionalUsd: spent,
    size: qty,
    avgPrice: spent / qty,
    fills,
    complete: remaining <= 0.000001,
  };
}

export function availableNotional(levels) {
  return levels.reduce((sum, level) => sum + level.price * level.size, 0);
}

export function consumeProfitableDepth({
  buyLevels,
  sellLevels,
  maxTradeUsd,
  minTradeUsd,
  minEdgeBps,
  costBps,
}) {
  let buyIndex = 0;
  let sellIndex = 0;
  let buyRemainingSize = buyLevels[0]?.size ?? 0;
  let sellRemainingSize = sellLevels[0]?.size ?? 0;
  let remainingUsd = maxTradeUsd;
  let size = 0;
  let buyNotional = 0;
  let sellNotional = 0;
  const buyFills = [];
  const sellFills = [];

  while (
    buyIndex < buyLevels.length &&
    sellIndex < sellLevels.length &&
    remainingUsd > 0.000001
  ) {
    const buyLevel = buyLevels[buyIndex];
    const sellLevel = sellLevels[sellIndex];
    const levelNetBps = bps(sellLevel.price - buyLevel.price, buyLevel.price) - costBps;
    if (levelNetBps < minEdgeBps) break;

    const maxSizeByUsd = remainingUsd / buyLevel.price;
    const takeSize = Math.min(buyRemainingSize, sellRemainingSize, maxSizeByUsd);
    if (takeSize <= 0) break;

    const buyFillNotional = takeSize * buyLevel.price;
    const sellFillNotional = takeSize * sellLevel.price;
    buyFills.push({ price: buyLevel.price, size: takeSize, notional: buyFillNotional });
    sellFills.push({ price: sellLevel.price, size: takeSize, notional: sellFillNotional });

    size += takeSize;
    buyNotional += buyFillNotional;
    sellNotional += sellFillNotional;
    remainingUsd -= buyFillNotional;
    buyRemainingSize -= takeSize;
    sellRemainingSize -= takeSize;

    if (buyRemainingSize <= 0.000000001) {
      buyIndex += 1;
      buyRemainingSize = buyLevels[buyIndex]?.size ?? 0;
    }
    if (sellRemainingSize <= 0.000000001) {
      sellIndex += 1;
      sellRemainingSize = sellLevels[sellIndex]?.size ?? 0;
    }
  }

  if (buyNotional < minTradeUsd || size <= 0) return null;

  const buyPrice = buyNotional / size;
  const sellPrice = sellNotional / size;
  const grossBps = bps(sellPrice - buyPrice, buyPrice);
  const netBps = grossBps - costBps;
  if (netBps < minEdgeBps) return null;

  return {
    size,
    buyPrice,
    sellPrice,
    notionalUsd: buyNotional,
    grossBps,
    netBps,
    expectedPnlUsd: sellNotional - buyNotional - (buyNotional * costBps) / 10000,
    buyFills,
    sellFills,
  };
}

export function evaluateDirection({
  symbol,
  buyExchange,
  sellExchange,
  buyBook,
  sellBook,
  config,
}) {
  if (!buyBook.asks.length || !sellBook.bids.length) return null;
  const costBps = config.takerFeeBps * 2 + config.slippageBufferBps;
  const fill = consumeProfitableDepth({
    buyLevels: buyBook.asks,
    sellLevels: sellBook.bids,
    maxTradeUsd: config.maxTradeUsd,
    minTradeUsd: config.minTradeUsd,
    minEdgeBps: config.minEdgeBps,
    costBps,
  });

  if (!fill) return null;
  return {
    symbol,
    buyExchange,
    sellExchange,
    buyPrice: round(fill.buyPrice, 6),
    sellPrice: round(fill.sellPrice, 6),
    size: round(fill.size, 8),
    notionalUsd: round(fill.notionalUsd, 2),
    grossBps: round(fill.grossBps, 3),
    netBps: round(fill.netBps, 3),
    expectedPnlUsd: round(fill.expectedPnlUsd, 4),
    buyFills: fill.buyFills,
    sellFills: fill.sellFills,
  };
}

export function evaluateArbitrage({ symbol, cascadeBook, risexBook, config }) {
  const directions = [
    evaluateDirection({
      symbol,
      buyExchange: "cascade",
      sellExchange: "risex",
      buyBook: cascadeBook,
      sellBook: risexBook,
      config,
    }),
    evaluateDirection({
      symbol,
      buyExchange: "risex",
      sellExchange: "cascade",
      buyBook: risexBook,
      sellBook: cascadeBook,
      config,
    }),
  ].filter(Boolean);

  directions.sort((a, b) => b.expectedPnlUsd - a.expectedPnlUsd);
  return directions[0] ?? null;
}
