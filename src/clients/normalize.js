import { decimalToNumber } from "../lib/math.js";

export function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];
  const normalized = levels
    .map((level) => {
      if (Array.isArray(level)) {
        return {
          price: decimalToNumber(level[0]),
          size: decimalToNumber(level[1]),
          orders: decimalToNumber(level[2]),
        };
      }
      return {
        price: decimalToNumber(level.price ?? level.px ?? level[0]),
        size: decimalToNumber(level.quantity ?? level.size ?? level.sz ?? level.amount ?? level[1]),
        orders: decimalToNumber(level.order_count ?? level.orders ?? level.n ?? 0),
      };
    })
    .filter((level) => level.price > 0 && level.size > 0);

  normalized.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return normalized;
}

export function normalizeOrderbook({ exchange, symbol, market, raw, receivedAt = Date.now() }) {
  const bids = normalizeLevels(raw?.bids ?? raw?.buy ?? raw?.bidLevels, "bid");
  const asks = normalizeLevels(raw?.asks ?? raw?.sell ?? raw?.askLevels, "ask");
  return {
    exchange,
    symbol,
    market,
    receivedAt,
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    markPrice: decimalToNumber(raw?.mark ?? raw?.markPrice ?? raw?.mark_price) || null,
    indexPrice: decimalToNumber(raw?.index ?? raw?.indexPrice ?? raw?.index_price) || null,
    midpoint: decimalToNumber(raw?.midpoint ?? raw?.mid ?? raw?.midPrice) || null,
    spread: decimalToNumber(raw?.spread) || null,
    raw,
  };
}
