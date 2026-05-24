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
  const entryEdgeBps = envNumber("ENTRY_EDGE_BPS", 50);
  const exitEdgeBps = envNumber("EXIT_EDGE_BPS", 0);
  const exchanges = envList("EXCHANGES", ["cascade", "risex", "lighter"]).map((exchange) =>
    exchange.toLowerCase(),
  );
  const routePairs = parseRoutePairs(envString("ROUTE_PAIRS", "lighter:cascade,lighter:risex"));

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
      exchanges,
      routePairs,
      loopIntervalMs: envNumber("LOOP_INTERVAL_MS", 50, { min: 50 }),
      orderbookDepth: envNumber("ORDERBOOK_DEPTH", 20, { min: 1 }),
      staleBookMs: envNumber("STALE_BOOK_MS", 15000, { min: 500 }),
      entryEdgeBps,
      exitEdgeBps,
      minEdgeBps: entryEdgeBps,
      takerFeeBps: envNumber("TAKER_FEE_BPS", 0),
      slippageBufferBps: envNumber("SLIPPAGE_BUFFER_BPS", 3),
      maxBookSpreadBps: envNumber("MAX_BOOK_SPREAD_BPS", 100, { min: 0 }),
      maxBookMidMoveBps: envNumber("MAX_BOOK_MID_MOVE_BPS", 500, { min: 0 }),
      maxCrossVenueMidDiffBps: envNumber("MAX_CROSS_VENUE_MID_DIFF_BPS", 300, { min: 0 }),
      minTradeUsd: envNumber("MIN_TRADE_USD", 20, { min: 0 }),
      maxTradeUsd: envNumber("MAX_TRADE_USD", 250, { min: 1 }),
      maxPositionUsdPerSymbol: envNumber("MAX_POSITION_USD_PER_SYMBOL", 1000, { min: 0 }),
      maxDailyLossUsd: envNumber("MAX_DAILY_LOSS_USD", 100, { min: 0 }),
      symbolErrorLogIntervalMs: envNumber("SYMBOL_ERROR_LOG_INTERVAL_MS", 10000, { min: 0 }),
    },
    telegram: {
      botToken: envString("TELEGRAM_BOT_TOKEN"),
      chatId: envString("TELEGRAM_CHAT_ID"),
    },
    cascade: {
      name: "cascade",
      baseUrl: envString("CASCADE_BASE_URL", "https://engine.cascade.xyz"),
      jwt: envString("CASCADE_JWT"),
      timeoutMs: envNumber("CASCADE_TIMEOUT_MS", 15000, { min: 1000 }),
      resubscribeMs: envNumber("CASCADE_RESUBSCRIBE_MS", 5000, { min: 500 }),
      orderbookTransport: envString("CASCADE_ORDERBOOK_TRANSPORT", "ws"),
      wsPath: envString("CASCADE_WS_PATH", "/ws"),
      orderbookTickSize: envNumber("CASCADE_ORDERBOOK_TICK_SIZE", 0.1, { min: 0.000001 }),
      orderbookPath: envString("CASCADE_ORDERBOOK_PATH", "/orderbook"),
      orderbookQueryParam: envString("CASCADE_ORDERBOOK_QUERY_PARAM", "market"),
      placeOrderPath: envString("CASCADE_PLACE_ORDER_PATH", "/orders/place"),
      cancelOrderPath: envString("CASCADE_CANCEL_ORDER_PATH", "/orders/cancel"),
      positionsPath: envString("CASCADE_POSITIONS_PATH", "/account/positions"),
      marketsPath: envString("CASCADE_MARKETS_PATH", "/markets"),
      markets: Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          envString(`CASCADE_MARKET_${symbol}`, `${symbol}-USD-PERP`),
        ]),
      ),
    },
    risex: {
      name: "risex",
      baseUrl: envString("RISEX_BASE_URL", "https://api.rise.trade/api"),
      apiPrefix: envString("RISEX_API_PREFIX", "/v1"),
      timeoutMs: envNumber("RISEX_TIMEOUT_MS", 2500, { min: 100 }),
      retries: envNumber("RISEX_RETRIES", 0, { min: 0 }),
      orderbookTransport: envString("RISEX_ORDERBOOK_TRANSPORT", "ws"),
      wsUrl: envString("RISEX_WS_URL", "wss://api.rise.trade/ws/"),
      wsResubscribeMs: envNumber("RISEX_WS_RESUBSCRIBE_MS", 5000, { min: 500 }),
      pollIntervalMs: envNumber("RISEX_POLL_INTERVAL_MS", 1000, { min: 50 }),
      rateLimitBackoffMs: envNumber("RISEX_RATE_LIMIT_BACKOFF_MS", 10000, { min: 1000 }),
      logIntervalMs: envNumber("RISEX_LOG_INTERVAL_MS", 10000, { min: 0 }),
      errorLogIntervalMs: envNumber("RISEX_ERROR_LOG_INTERVAL_MS", 10000, { min: 0 }),
      account: envString("RISEX_ACCOUNT"),
      signer: envString("RISEX_SIGNER"),
      enableTestnetServerSigning: envBool("RISEX_ENABLE_TESTNET_SERVER_SIGNING", false),
      signerPrivateKey: envString("RISEX_SIGNER_PRIVATE_KEY"),
      markets: Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          envString(`RISEX_MARKET_${symbol}`, symbol === "BTC" ? "1" : symbol === "ETH" ? "2" : symbol),
        ]),
      ),
    },
    lighter: {
      name: "lighter",
      baseUrl: envString("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai"),
      apiPrefix: envString("LIGHTER_API_PREFIX", "/api/v1"),
      timeoutMs: envNumber("LIGHTER_TIMEOUT_MS", 2500, { min: 100 }),
      retries: envNumber("LIGHTER_RETRIES", 0, { min: 0 }),
      orderbookTransport: envString("LIGHTER_ORDERBOOK_TRANSPORT", "ws"),
      wsUrl: envString("LIGHTER_WS_URL", "wss://mainnet.zklighter.elliot.ai/stream"),
      wsResubscribeMs: envNumber("LIGHTER_WS_RESUBSCRIBE_MS", 5000, { min: 500 }),
      logIntervalMs: envNumber("LIGHTER_LOG_INTERVAL_MS", 10000, { min: 0 }),
      markets: Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          envString(`LIGHTER_MARKET_${symbol}`, symbol === "BTC" ? "1" : symbol === "ETH" ? "0" : symbol),
        ]),
      ),
    },
  };

  if (cfg.trading.minTradeUsd > cfg.trading.maxTradeUsd) {
    throw new Error("MIN_TRADE_USD cannot be greater than MAX_TRADE_USD");
  }
  if (cfg.trading.exchanges.length < 2) {
    throw new Error("At least two exchanges must be configured");
  }
  if (cfg.trading.routePairs.length === 0) {
    throw new Error("At least one ROUTE_PAIRS entry must be configured");
  }
  if (cfg.trading.exitEdgeBps > cfg.trading.entryEdgeBps) {
    throw new Error("EXIT_EDGE_BPS cannot be greater than ENTRY_EDGE_BPS");
  }
  if (!["mock", "live"].includes(cfg.runtime.marketDataMode)) {
    throw new Error("MARKET_DATA_MODE must be mock or live");
  }
  if (!["rest", "ws"].includes(cfg.risex.orderbookTransport)) {
    throw new Error("RISEX_ORDERBOOK_TRANSPORT must be rest or ws");
  }
  if (cfg.lighter.orderbookTransport !== "ws") {
    throw new Error("LIGHTER_ORDERBOOK_TRANSPORT must be ws");
  }
  for (const exchange of cfg.trading.exchanges) {
    if (!["cascade", "risex", "lighter"].includes(exchange)) {
      throw new Error(`Unsupported exchange in EXCHANGES: ${exchange}`);
    }
  }
  for (const [left, right] of cfg.trading.routePairs) {
    if (!cfg.trading.exchanges.includes(left) || !cfg.trading.exchanges.includes(right)) {
      throw new Error(`ROUTE_PAIRS includes disabled exchange: ${left}:${right}`);
    }
  }
  if (cfg.trading.mode === "live" && cfg.runtime.marketDataMode !== "live") {
    throw new Error("TRADING_MODE=live requires MARKET_DATA_MODE=live");
  }

  return cfg;
}

function parseRoutePairs(raw) {
  return String(raw)
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [left, right] = pair.split(":").map((item) => item?.trim().toLowerCase());
      if (!left || !right || left === right) {
        throw new Error(`Invalid ROUTE_PAIRS entry: ${pair}`);
      }
      return [left, right];
    });
}
