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

export function bookMid(book) {
  const bid = book?.bestBid;
  const ask = book?.bestAsk;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask <= bid) {
    return null;
  }
  return (bid + ask) / 2;
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

export function checkBookMove(book, previousBook, { maxBookMidMoveBps, staleBookMs, now = Date.now() } = {}) {
  if ((maxBookMidMoveBps ?? 0) <= 0 || !previousBook || isBookStale(previousBook, staleBookMs, now)) {
    return { ok: true };
  }

  const currentMid = bookMid(book);
  const previousMid = bookMid(previousBook);
  if (!Number.isFinite(currentMid) || !Number.isFinite(previousMid)) return { ok: true };

  const moveBps = (Math.abs(currentMid - previousMid) / previousMid) * 10000;
  if (moveBps <= maxBookMidMoveBps) return { ok: true };

  return {
    ok: false,
    reason: "book_mid_jump",
    details: {
      exchange: book.exchange,
      market: book.market,
      previousMid,
      currentMid,
      moveBps,
      maxBookMidMoveBps,
    },
  };
}

export function checkCrossVenueMid(leftBook, rightBook, maxCrossVenueMidDiffBps) {
  if ((maxCrossVenueMidDiffBps ?? 0) <= 0) return { ok: true };

  const leftMid = bookMid(leftBook);
  const rightMid = bookMid(rightBook);
  if (!Number.isFinite(leftMid) || !Number.isFinite(rightMid)) return { ok: true };

  const averageMid = (leftMid + rightMid) / 2;
  const diffBps = (Math.abs(leftMid - rightMid) / averageMid) * 10000;
  if (diffBps <= maxCrossVenueMidDiffBps) return { ok: true };

  return {
    ok: false,
    reason: "cross_venue_mid_divergence",
    details: {
      leftExchange: leftBook.exchange,
      rightExchange: rightBook.exchange,
      leftMarket: leftBook.market,
      rightMarket: rightBook.market,
      leftMid,
      rightMid,
      diffBps,
      maxCrossVenueMidDiffBps,
    },
  };
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
