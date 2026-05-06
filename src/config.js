import { envBool, envList, envNumber, envString, loadEnvFile } from "./lib/env.js";

export function loadConfig() {
  loadEnvFile();

  const symbols = envList("SYMBOLS", ["BTC", "ETH"]);
  if (symbols.length === 0) {
    throw new Error("At least one symbol must be configured");
  }

  const tradingMode = envString("TRADING_MODE", "paper");
  if (!["paper", "live"].includes(tradingMode)) {
    throw new Error("TRADING_MODE must be paper or live");
  }

  const cfg = {
    server: {
      host: envString("HOST", "127.0.0.1"),
      port: envNumber("PORT", 8787, { min: 1 }),
    },
    runtime: {
      nodeEnv: envString("NODE_ENV", "development"),
      dataDir: envString("DATA_DIR", "./data"),
      marketDataMode: envString("MARKET_DATA_MODE", "mock"),
      reportTime: envString("REPORT_TIME", "09:00"),
      timezone: envString("TIMEZONE", "Asia/Seoul"),
    },
    trading: {
      mode: tradingMode,
      enabled: envBool("TRADING_ENABLED", false),
      symbols,
      loopIntervalMs: envNumber("LOOP_INTERVAL_MS", 2500, { min: 250 }),
      orderbookDepth: envNumber("ORDERBOOK_DEPTH", 20, { min: 1 }),
      staleBookMs: envNumber("STALE_BOOK_MS", 5000, { min: 500 }),
      minEdgeBps: envNumber("MIN_EDGE_BPS", 8),
      takerFeeBps: envNumber("TAKER_FEE_BPS", 0),
      slippageBufferBps: envNumber("SLIPPAGE_BUFFER_BPS", 3),
      minTradeUsd: envNumber("MIN_TRADE_USD", 20, { min: 0 }),
      maxTradeUsd: envNumber("MAX_TRADE_USD", 250, { min: 1 }),
      maxPositionUsdPerSymbol: envNumber("MAX_POSITION_USD_PER_SYMBOL", 1000, { min: 0 }),
      maxDailyLossUsd: envNumber("MAX_DAILY_LOSS_USD", 100, { min: 0 }),
    },
    telegram: {
      botToken: envString("TELEGRAM_BOT_TOKEN"),
      chatId: envString("TELEGRAM_CHAT_ID"),
    },
    cascade: {
      name: "cascade",
      baseUrl: envString("CASCADE_BASE_URL", "https://engine.cascade.cooking"),
      jwt: envString("CASCADE_JWT"),
      orderbookPath: envString("CASCADE_ORDERBOOK_PATH", "/orderbook"),
      orderbookQueryParam: envString("CASCADE_ORDERBOOK_QUERY_PARAM", "market"),
      placeOrderPath: envString("CASCADE_PLACE_ORDER_PATH", "/orders/place"),
      cancelOrderPath: envString("CASCADE_CANCEL_ORDER_PATH", "/orders/cancel"),
      positionsPath: envString("CASCADE_POSITIONS_PATH", "/account/positions"),
      marketsPath: envString("CASCADE_MARKETS_PATH", "/markets"),
      markets: Object.fromEntries(
        symbols.map((symbol) => [symbol, envString(`CASCADE_MARKET_${symbol}`, `${symbol}-USD`)]),
      ),
    },
    risex: {
      name: "risex",
      baseUrl: envString("RISEX_BASE_URL", "https://api.testnet.rise.trade"),
      apiPrefix: envString("RISEX_API_PREFIX", "/v1"),
      account: envString("RISEX_ACCOUNT"),
      signer: envString("RISEX_SIGNER"),
      enableTestnetServerSigning: envBool("RISEX_ENABLE_TESTNET_SERVER_SIGNING", false),
      signerPrivateKey: envString("RISEX_SIGNER_PRIVATE_KEY"),
      markets: Object.fromEntries(
        symbols.map((symbol) => [symbol, envString(`RISEX_MARKET_${symbol}`, `${symbol}-PERP`)]),
      ),
    },
  };

  if (cfg.trading.minTradeUsd > cfg.trading.maxTradeUsd) {
    throw new Error("MIN_TRADE_USD cannot be greater than MAX_TRADE_USD");
  }
  if (!["mock", "live"].includes(cfg.runtime.marketDataMode)) {
    throw new Error("MARKET_DATA_MODE must be mock or live");
  }
  if (cfg.trading.mode === "live" && cfg.runtime.marketDataMode !== "live") {
    throw new Error("TRADING_MODE=live requires MARKET_DATA_MODE=live");
  }

  return cfg;
}
