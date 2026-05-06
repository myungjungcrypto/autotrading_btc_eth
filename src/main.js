import { loadConfig } from "./config.js";
import { CascadeClient } from "./clients/cascade.js";
import { MockExchangeClient } from "./clients/mock.js";
import { RisexClient } from "./clients/risex.js";
import { ArbitrageEngine } from "./core/engine.js";
import { PaperExecutor, LiveExecutor } from "./core/executor.js";
import { StateStore } from "./core/store.js";
import { createLogger } from "./lib/logger.js";
import { TelegramNotifier } from "./notifier.js";
import { scheduleDailyReport } from "./reports/daily.js";
import { createAppServer } from "./server/server.js";

const logger = createLogger("main");

try {
  const cfg = loadConfig();
  const store = new StateStore(cfg.runtime.dataDir);
  const notifier = new TelegramNotifier(cfg.telegram, logger.child("telegram"));
  const clients =
    cfg.runtime.marketDataMode === "mock"
      ? {
          cascade: new MockExchangeClient({
            exchange: "cascade",
            markets: cfg.cascade.markets,
            skewBps: -6,
          }),
          risex: new MockExchangeClient({
            exchange: "risex",
            markets: cfg.risex.markets,
            skewBps: 6,
          }),
        }
      : {
          cascade: new CascadeClient(cfg.cascade, logger.child("cascade")),
          risex: new RisexClient(cfg.risex, logger.child("risex")),
        };
  const executor =
    cfg.trading.mode === "live"
      ? new LiveExecutor({ clients, store, notifier, logger: logger.child("executor") })
      : new PaperExecutor({ store, notifier, logger: logger.child("executor") });
  const engine = new ArbitrageEngine({
    config: cfg.trading,
    clients,
    executor,
    store,
    logger: logger.child("engine"),
  });

  const stopReportScheduler = scheduleDailyReport({
    store,
    notifier,
    reportTime: cfg.runtime.reportTime,
    logger: logger.child("report"),
  });

  const server = createAppServer({ config: cfg, store, engine, logger: logger.child("server") });
  server.listen(cfg.server.port, cfg.server.host, () => {
    logger.info("dashboard listening", {
      url: `http://${cfg.server.host}:${cfg.server.port}`,
      mode: cfg.trading.mode,
      marketDataMode: cfg.runtime.marketDataMode,
      cascadeOrderbookTransport: cfg.cascade.orderbookTransport,
      liveEnabled: cfg.trading.enabled,
    });
    engine.start();
  });

  let shuttingDown = false;
  const shutdown = (reason = "shutdown", exitCode = 0) => {
    if (shuttingDown) {
      logger.warn("forcing shutdown after repeated signal", { reason });
      process.exit(exitCode);
    }
    shuttingDown = true;
    logger.info("shutting down", { reason });
    engine.stop();
    if (stopReportScheduler) stopReportScheduler();
    for (const client of Object.values(clients)) {
      if (typeof client.close === "function") client.close();
    }
    if (typeof server.closeSseClients === "function") server.closeSseClients();

    const forceExit = setTimeout(() => {
      logger.warn("forced process exit after shutdown timeout", { reason });
      process.exit(exitCode);
    }, 2000);

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(exitCode);
    });
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  };

  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.on("unhandledRejection", (error) => {
    logger.error("unhandled rejection", error);
    shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", error);
    shutdown("uncaughtException", 1);
  });
} catch (error) {
  logger.error("startup failed", error);
  process.exit(1);
}
