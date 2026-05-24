import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { buildDailyReport } from "../reports/daily.js";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export function createAppServer({ config, store, engine, logger }) {
  const clients = new Set();

  engine.on("event", (event) => {
    const text = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(text);
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/api/status") {
        return json(res, store.snapshot());
      }

      if (url.pathname === "/api/config") {
        return json(res, publicConfig(config));
      }

      if (url.pathname === "/api/report/today") {
        return json(res, buildDailyReport(store.snapshot()));
      }

      if (url.pathname === "/api/control" && req.method === "POST") {
        const body = await readJson(req);
        if (body.action === "pause") store.setPaused(true, "manual");
        else if (body.action === "resume") store.setPaused(false, "manual");
        else return json(res, { error: "Unknown action" }, 400);
        return json(res, store.snapshot());
      }

      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        clients.add(res);
        res.write(`data: ${JSON.stringify({ type: "connected", payload: store.snapshot() })}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }

      return serveStatic(url.pathname, res);
    } catch (error) {
      logger.error("server request failed", error);
      return json(res, { error: error.message }, 500);
    }
  });

  server.closeSseClients = () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        // Ignore already-closed dashboard streams.
      }
    }
    clients.clear();
  };

  return server;
}

function serveStatic(pathname, res) {
  const publicDir = join(process.cwd(), "public");
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicConfig(config) {
  return {
    trading: config.trading,
    runtime: {
      marketDataMode: config.runtime.marketDataMode,
      reportTime: config.runtime.reportTime,
      timezone: config.runtime.timezone,
    },
    cascade: {
      baseUrl: config.cascade.baseUrl,
      markets: config.cascade.markets,
      orderbookPath: config.cascade.orderbookPath,
    },
    risex: {
      baseUrl: config.risex.baseUrl,
      apiPrefix: config.risex.apiPrefix,
      markets: config.risex.markets,
    },
    lighter: {
      baseUrl: config.lighter.baseUrl,
      apiPrefix: config.lighter.apiPrefix,
      markets: config.lighter.markets,
      wsUrl: config.lighter.wsUrl,
    },
  };
}
