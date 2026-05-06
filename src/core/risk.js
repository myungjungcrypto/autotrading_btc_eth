export function isBookStale(book, staleBookMs, now = Date.now()) {
  return !book?.receivedAt || now - book.receivedAt > staleBookMs;
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
