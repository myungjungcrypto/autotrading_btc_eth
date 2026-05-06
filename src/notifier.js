import { requestJson } from "./lib/http.js";

export class TelegramNotifier {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.config.botToken && this.config.chatId);
  }

  async send(text) {
    if (!this.enabled) return;
    try {
      await requestJson(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: "POST",
        body: {
          chat_id: this.config.chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        },
        retries: 1,
      });
    } catch (error) {
      this.logger.warn("Telegram send failed", { error: error.message });
    }
  }

  async tradeCompleted(trade) {
    await this.send(
      `Trade completed: ${trade.symbol}\n` +
        `Buy ${trade.buyExchange} / Sell ${trade.sellExchange}\n` +
        `Notional: ${trade.notionalUsd} USD\n` +
        `PnL: ${trade.realizedPnlUsd ?? 0} USD\n` +
        `Mode: ${trade.mode}`,
    );
  }

  async alert(message) {
    await this.send(`ALERT: ${message}`);
  }

  async report(markdown) {
    await this.send(markdown.slice(0, 3900));
  }
}
