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

export function sumNotional(fills = []) {
  return fills.reduce((sum, fill) => sum + (fill.notional ?? 0), 0);
}

export function consumeBaseSize(levels, targetSize) {
  let remaining = targetSize;
  let size = 0;
  let notionalUsd = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 0) break;
    const takeSize = Math.min(remaining, level.size);
    const notional = takeSize * level.price;
    size += takeSize;
    notionalUsd += notional;
    remaining -= takeSize;
    fills.push({ price: level.price, size: takeSize, notional });
  }
  if (size <= 0 || notionalUsd <= 0) return null;
  return {
    size,
    notionalUsd,
    avgPrice: notionalUsd / size,
    fills,
    complete: remaining <= 0.000000001,
  };
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
    costBps,
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
  const entryEdgeBps = config.entryEdgeBps ?? config.minEdgeBps;
  const fill = consumeProfitableDepth({
    buyLevels: buyBook.asks,
    sellLevels: sellBook.bids,
    maxTradeUsd: config.maxTradeUsd,
    minTradeUsd: config.minTradeUsd,
    minEdgeBps: entryEdgeBps,
    costBps,
  });

  if (!fill) return null;
  return {
    action: "open",
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
    costBps,
    triggerBps: entryEdgeBps,
  };
}

export function evaluateArbitrage({ symbol, cascadeBook, risexBook, config }) {
  return evaluateArbitrageAcrossBooks({
    symbol,
    books: { cascade: cascadeBook, risex: risexBook },
    routePairs: [["cascade", "risex"]],
    config,
  });
}

export function evaluateArbitrageAcrossBooks({ symbol, books, routePairs, config }) {
  const directions = [
    ...routePairs.flatMap(([leftExchange, rightExchange]) => {
      const leftBook = books[leftExchange];
      const rightBook = books[rightExchange];
      if (!leftBook || !rightBook) return [];
      return [
        evaluateDirection({
          symbol,
          buyExchange: leftExchange,
          sellExchange: rightExchange,
          buyBook: leftBook,
          sellBook: rightBook,
          config,
        }),
        evaluateDirection({
          symbol,
          buyExchange: rightExchange,
          sellExchange: leftExchange,
          buyBook: rightBook,
          sellBook: leftBook,
          config,
        }),
      ];
    }),
  ].filter(Boolean);

  directions.sort((a, b) => b.expectedPnlUsd - a.expectedPnlUsd);
  return directions[0] ?? null;
}

export function evaluateExitArbitrage({ symbol, position, cascadeBook, risexBook, config }) {
  return evaluateExitArbitrageAcrossBooks({
    symbol,
    position,
    books: { cascade: cascadeBook, risex: risexBook },
    config,
  });
}

export function evaluateExitArbitrageAcrossBooks({ symbol, position, books, config }) {
  if (!position || position.symbol !== symbol) return null;
  const originalBuyBook = books[position.buyExchange];
  const originalSellBook = books[position.sellExchange];
  const closeBuyBook = books[position.sellExchange];
  const closeSellBook = books[position.buyExchange];
  if (!originalBuyBook || !originalSellBook || !closeBuyBook || !closeSellBook) return null;

  const costBps = config.takerFeeBps * 2 + config.slippageBufferBps;
  const currentEntryRoute = evaluateFixedSizeRoute({
    buyBook: originalBuyBook,
    sellBook: originalSellBook,
    size: position.size,
    costBps,
  });
  if (!currentEntryRoute) return null;
  if (currentEntryRoute.netBps > config.exitEdgeBps) return null;

  const closeRoute = evaluateFixedSizeRoute({
    buyBook: closeBuyBook,
    sellBook: closeSellBook,
    size: position.size,
    costBps,
  });
  if (!closeRoute) return null;

  const entryBuyNotional = position.entryBuyNotional ?? position.entryBuyPrice * position.size;
  const entrySellNotional = position.entrySellNotional ?? position.entrySellPrice * position.size;
  const entryCostUsd = position.entryCostUsd ?? (entryBuyNotional * costBps) / 10000;
  const closeCostUsd = (closeRoute.buy.notionalUsd * costBps) / 10000;
  const pnlUsd =
    entrySellNotional -
    entryBuyNotional +
    closeRoute.sell.notionalUsd -
    closeRoute.buy.notionalUsd -
    entryCostUsd -
    closeCostUsd;
  if (pnlUsd < (config.minClosePnlUsd ?? -Infinity)) return null;

  return {
    action: "close",
    symbol,
    positionId: position.id,
    buyExchange: position.sellExchange,
    sellExchange: position.buyExchange,
    buyPrice: round(closeRoute.buy.avgPrice, 6),
    sellPrice: round(closeRoute.sell.avgPrice, 6),
    size: round(position.size, 8),
    notionalUsd: round(closeRoute.buy.notionalUsd, 2),
    grossBps: round(closeRoute.grossBps, 3),
    netBps: round(currentEntryRoute.netBps, 3),
    exitEdgeBps: config.exitEdgeBps,
    expectedPnlUsd: round(pnlUsd, 4),
    buyFills: closeRoute.buy.fills,
    sellFills: closeRoute.sell.fills,
    costBps,
  };
}

function evaluateFixedSizeRoute({ buyBook, sellBook, size, costBps }) {
  const buy = consumeBaseSize(buyBook.asks, size);
  const sell = consumeBaseSize(sellBook.bids, size);
  if (!buy?.complete || !sell?.complete) return null;
  const grossBps = bps(sell.avgPrice - buy.avgPrice, buy.avgPrice);
  return {
    buy,
    sell,
    grossBps,
    netBps: grossBps - costBps,
  };
}
