const els = {
  status: document.querySelector("#status"),
  mode: document.querySelector("#mode"),
  dailyPnl: document.querySelector("#dailyPnl"),
  totalPnl: document.querySelector("#totalPnl"),
  markets: document.querySelector("#markets"),
  opportunities: document.querySelector("#opportunities"),
  trades: document.querySelector("#trades"),
  positions: document.querySelector("#positions"),
  exposure: document.querySelector("#exposure"),
  report: document.querySelector("#report"),
  events: document.querySelector("#events"),
  pauseBtn: document.querySelector("#pauseBtn"),
  resumeBtn: document.querySelector("#resumeBtn"),
};

let cfg = null;

async function fetchJson(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmt(value, digits = 2) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num.toFixed(digits) : "-";
}

function pnlClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function ageLabel(receivedAt) {
  if (!receivedAt) return "-";
  const age = Date.now() - new Date(receivedAt).getTime();
  if (!Number.isFinite(age)) return "-";
  if (age < 1000) return `${age}ms`;
  return `${(age / 1000).toFixed(1)}s`;
}

function render(state) {
  els.status.textContent = `${state.status}${state.paused ? " paused" : ""}`;
  els.mode.textContent = `${cfg?.trading?.mode ?? "-"} / ${cfg?.runtime?.marketDataMode ?? "-"}${
    cfg?.trading?.enabled ? " live-on" : ""
  }`;
  els.dailyPnl.textContent = `${fmt(state.dailyPnlUsd, 4)} USD`;
  els.dailyPnl.className = pnlClass(state.dailyPnlUsd);
  els.totalPnl.textContent = `${fmt(state.realizedPnlUsd, 4)} USD`;
  els.totalPnl.className = pnlClass(state.realizedPnlUsd);

  els.markets.innerHTML = Object.entries(state.books ?? {})
    .map(([symbol, books]) => marketHtml(symbol, books))
    .join("");

  els.opportunities.innerHTML =
    Object.values(state.opportunities ?? {})
      .map(opportunityHtml)
      .join("") || `<p>No executable spread above threshold.</p>`;

  els.trades.innerHTML = (state.trades ?? [])
    .slice(0, 50)
    .map(
      (trade) => `<tr>
        <td>${new Date(trade.ts).toLocaleString()}</td>
        <td>${trade.symbol}</td>
        <td>${trade.action ?? "-"}</td>
        <td>${trade.buyExchange} -> ${trade.sellExchange}</td>
        <td>${fmt(trade.notionalUsd, 2)}</td>
        <td>${fmt(trade.netBps, 3)}</td>
        <td class="${pnlClass(trade.realizedPnlUsd)}">${fmt(trade.realizedPnlUsd, 4)}</td>
      </tr>`,
    )
    .join("");

  els.positions.textContent = JSON.stringify(state.openPositions ?? {}, null, 2);
  els.exposure.textContent = JSON.stringify(state.exposure ?? {}, null, 2);
  els.events.innerHTML = (state.events ?? [])
    .slice(0, 80)
    .map(
      (event) => `<div class="event">
        <span>${new Date(event.ts).toLocaleString()}</span>
        <strong>${event.type}</strong>
        <code>${escapeHtml(JSON.stringify(event.payload ?? {}))}</code>
      </div>`,
    )
    .join("");
}

function marketHtml(symbol, books) {
  const entries = Object.entries(books ?? {});
  const marketLabels = entries
    .map(([exchange, book]) => `${labelExchange(exchange)} ${book.market ?? "-"}`)
    .join(" / ");
  return `<div class="market">
    <div class="market-head"><strong>${symbol}</strong><span>${marketLabels || "-"}</span></div>
    <div class="quote-grid">
      ${entries.map(([exchange, book]) => exchangeQuoteHtml(exchange, book)).join("")}
    </div>
  </div>`;
}

function exchangeQuoteHtml(exchange, book) {
  const extra = [
    `age ${ageLabel(book.receivedAt)}`,
    `${fmt(book.latencyMs, 0)}ms`,
    `spread ${fmt(book.spreadBps, 1)}bps`,
    book.wsConnected === false ? "ws disconnected" : "",
    book.rateLimited ? "rate limited" : "",
    book.nonce ? `nonce ${book.nonce}` : "",
    book.lastError ? `last error ${book.lastError}` : "",
    book.errorAt ? `error age ${ageLabel(book.errorAt)}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  return `<span>${labelExchange(exchange)} bid <strong>${fmt(book.bestBid, 4)}</strong> / ${fmt(book.bids?.[0]?.size, 6)}
      <small>${escapeHtml(extra)}</small>
    </span>
    <span>${labelExchange(exchange)} ask <strong>${fmt(book.bestAsk, 4)}</strong> / ${fmt(book.asks?.[0]?.size, 6)}</span>`;
}

function labelExchange(exchange) {
  const labels = { cascade: "Cascade", risex: "RISEx", lighter: "Lighter" };
  return labels[exchange] ?? exchange;
}

function opportunityHtml(opp) {
  const action = opp.action ?? "open";
  const threshold =
    action === "close"
      ? `Exit <= ${fmt(opp.exitEdgeBps, 3)} bps`
      : `Entry >= ${fmt(opp.triggerBps, 3)} bps`;
  return `<div class="opportunity">
    <div class="opp-head"><strong>${opp.symbol} ${action}</strong><span>${opp.buyExchange} -> ${opp.sellExchange}</span></div>
    <div class="opp-values">
      <span>Size <strong>${fmt(opp.size, 6)}</strong></span>
      <span>Notional <strong>${fmt(opp.notionalUsd, 2)}</strong></span>
      <span>Net bps <strong>${fmt(opp.netBps, 3)}</strong></span>
      <span>Exp PnL <strong>${fmt(opp.expectedPnlUsd, 4)}</strong></span>
      <span>${threshold}</span>
    </div>
  </div>`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

async function refreshReport() {
  const report = await fetchJson("/api/report/today");
  els.report.textContent = report.markdown;
}

async function control(action) {
  const state = await fetchJson("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  render(state);
}

async function init() {
  cfg = await fetchJson("/api/config");
  render(await fetchJson("/api/status"));
  await refreshReport();
  setInterval(async () => render(await fetchJson("/api/status")), 5000);
  setInterval(refreshReport, 30000);

  const events = new EventSource("/api/events");
  events.onmessage = async (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "connected") render(event.payload);
    if (event.type?.startsWith("trade") || event.type === "tick.completed") {
      render(await fetchJson("/api/status"));
      await refreshReport();
    }
  };
}

els.pauseBtn.addEventListener("click", () => control("pause"));
els.resumeBtn.addEventListener("click", () => control("resume"));
init().catch((error) => {
  els.status.textContent = error.message;
});
