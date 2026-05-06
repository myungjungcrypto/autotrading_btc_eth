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
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    engine.stop();
    if (stopReportScheduler) stopReportScheduler();
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (error) => {
    logger.error("unhandled rejection", error);
    shutdown();
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", error);
    shutdown();
  });
} catch (error) {
  logger.error("startup failed", error);
  process.exit(1);
}
