export function isBookStale(book, staleBookMs, now = Date.now()) {
  return !book?.receivedAt || now - book.receivedAt > staleBookMs;
}

export function bookSpreadBps(book) {
  const bid = book?.bestBid;
  const ask = book?.bestAsk;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return Infinity;
  if (ask <= bid) return Infinity;
  return ((ask - bid) / ((ask + bid) / 2)) * 10000;
}

export function checkBookHealth(book, maxBookSpreadBps) {
  if (!book?.bids?.length || !book?.asks?.length) {
    return {
      ok: false,
      reason: "empty_book",
      details: { exchange: book?.exchange, market: book?.market },
    };
  }
  if ((maxBookSpreadBps ?? 0) <= 0) return { ok: true };
  const spreadBps = bookSpreadBps(book);
  if (!Number.isFinite(spreadBps) || spreadBps > maxBookSpreadBps) {
    return {
      ok: false,
      reason: "wide_book_spread",
      details: {
        exchange: book.exchange,
        market: book.market,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        spreadBps,
        maxBookSpreadBps,
      },
    };
  }
  return { ok: true };
}

export function checkOpportunityRisk({ opportunity, state, config }) {
  if (!opportunity) return { ok: false, reason: "no_opportunity" };
  const openPosition = state.openPositions?.[opportunity.symbol];
  if (opportunity.action === "close") {
    if (!openPosition) return { ok: false, reason: "no_open_position" };
    if (openPosition.id !== opportunity.positionId) {
      return { ok: false, reason: "position_mismatch" };
    }
    return { ok: true };
  }
  if (state.dailyPnlUsd <= -config.maxDailyLossUsd) {
    return { ok: false, reason: "daily_loss_limit" };
  }
  if (openPosition) {
    return { ok: false, reason: "position_already_open" };
  }

  const exposure = state.exposure?.[opportunity.symbol] ?? {};
  const next = { ...exposure };
  const signedNotional = opportunity.notionalUsd;
  next[opportunity.buyExchange] = (next[opportunity.buyExchange] ?? 0) + signedNotional;
  next[opportunity.sellExchange] = (next[opportunity.sellExchange] ?? 0) - signedNotional;

  for (const [exchange, value] of Object.entries(next)) {
    if (Math.abs(value) > config.maxPositionUsdPerSymbol) {
      return {
        ok: false,
        reason: "position_limit",
        details: { exchange, value },
      };
    }
  }

  return { ok: true };
}
