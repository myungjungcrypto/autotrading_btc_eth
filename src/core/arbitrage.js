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

export function evaluateDirection({
  symbol,
  buyExchange,
  sellExchange,
  buyBook,
  sellBook,
  config,
}) {
  if (!buyBook.asks.length || !sellBook.bids.length) return null;
  const maxBookNotional = Math.min(availableNotional(buyBook.asks), availableNotional(sellBook.bids));
  const upper = Math.min(config.maxTradeUsd, maxBookNotional);
  if (upper < config.minTradeUsd) return null;

  const costBps = config.takerFeeBps * 2 + config.slippageBufferBps;
  let lo = 0;
  let hi = upper;
  let best = null;

  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2;
    const buy = consumeNotional(buyBook.asks, mid);
    const sell = consumeNotional(sellBook.bids, mid);
    if (!buy?.complete || !sell?.complete) {
      hi = mid;
      continue;
    }
    const gross = sell.avgPrice - buy.avgPrice;
    const grossBps = bps(gross, buy.avgPrice);
    const netBps = grossBps - costBps;
    const pnlUsd = (gross * Math.min(buy.size, sell.size)) - (mid * costBps) / 10000;
    const candidate = {
      symbol,
      buyExchange,
      sellExchange,
      buyPrice: buy.avgPrice,
      sellPrice: sell.avgPrice,
      size: Math.min(buy.size, sell.size),
      notionalUsd: mid,
      grossBps,
      netBps,
      expectedPnlUsd: pnlUsd,
      buyFills: buy.fills,
      sellFills: sell.fills,
    };
    if (netBps >= config.minEdgeBps) {
      lo = mid;
      best = candidate;
    } else {
      hi = mid;
    }
  }

  if (!best || best.notionalUsd < config.minTradeUsd) return null;
  return {
    ...best,
    buyPrice: round(best.buyPrice, 6),
    sellPrice: round(best.sellPrice, 6),
    size: round(best.size, 8),
    notionalUsd: round(best.notionalUsd, 2),
    grossBps: round(best.grossBps, 3),
    netBps: round(best.netBps, 3),
    expectedPnlUsd: round(best.expectedPnlUsd, 4),
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
