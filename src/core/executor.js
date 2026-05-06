import { nowIso, round } from "../lib/math.js";
import { compactError } from "../lib/logger.js";

export class PaperExecutor {
  constructor({ store, notifier, logger }) {
    this.store = store;
    this.notifier = notifier;
    this.logger = logger;
  }

  async execute(opportunity) {
    const action = opportunity.action ?? "open";
    const trade = {
      id: `paper-${Date.now()}`,
      ts: nowIso(),
      mode: "paper",
      status: "paper_filled",
      action,
      positionId: opportunity.positionId,
      symbol: opportunity.symbol,
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      size: opportunity.size,
      notionalUsd: opportunity.notionalUsd,
      buyPrice: opportunity.buyPrice,
      sellPrice: opportunity.sellPrice,
      netBps: opportunity.netBps,
      realizedPnlUsd: action === "close" ? round(opportunity.expectedPnlUsd, 4) : 0,
      rawOpportunity: opportunity,
    };
    this.store.recordTrade(trade);
    await this.notifier.tradeCompleted(trade);
    return trade;
  }
}

export class LiveExecutor {
  constructor({ clients, store, notifier, logger }) {
    this.clients = clients;
    this.store = store;
    this.notifier = notifier;
    this.logger = logger;
  }

  async execute(opportunity) {
    const action = opportunity.action ?? "open";
    const clientOrderId = Date.now();
    const buyClient = this.clients[opportunity.buyExchange];
    const sellClient = this.clients[opportunity.sellExchange];
    const buyOrder = {
      symbol: opportunity.symbol,
      side: "buy",
      size: opportunity.size,
      price: opportunity.buyPrice,
      clientOrderId: `${clientOrderId}-buy`,
    };
    const sellOrder = {
      symbol: opportunity.symbol,
      side: "sell",
      size: opportunity.size,
      price: opportunity.sellPrice,
      clientOrderId: `${clientOrderId}-sell`,
    };

    const [buyResult, sellResult] = await Promise.allSettled([
      buyClient.placeOrder(buyOrder),
      sellClient.placeOrder(sellOrder),
    ]);

    const failed = buyResult.status === "rejected" || sellResult.status === "rejected";
    const trade = {
      id: `live-${clientOrderId}`,
      ts: nowIso(),
      mode: "live",
      status: failed ? "leg_failed" : "submitted",
      action,
      positionId: opportunity.positionId,
      symbol: opportunity.symbol,
      buyExchange: opportunity.buyExchange,
      sellExchange: opportunity.sellExchange,
      size: opportunity.size,
      notionalUsd: opportunity.notionalUsd,
      buyPrice: opportunity.buyPrice,
      sellPrice: opportunity.sellPrice,
      netBps: opportunity.netBps,
      realizedPnlUsd: 0,
      buyResult: serializeSettled(buyResult),
      sellResult: serializeSettled(sellResult),
      rawOpportunity: opportunity,
    };
    this.store.recordTrade(trade);

    if (failed) {
      this.store.setPaused(true, "live_leg_failed");
      await this.notifier.alert(
        `LIVE LEG FAILURE ${trade.symbol}: engine paused. Check dashboard and repair exposure.`,
      );
    } else {
      await this.notifier.tradeCompleted(trade);
    }
    return trade;
  }
}

function serializeSettled(result) {
  if (result.status === "fulfilled") return { status: "fulfilled", value: result.value };
  return { status: "rejected", reason: compactError(result.reason) };
}
