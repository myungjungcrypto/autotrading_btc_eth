import { requestJson, withQuery } from "../lib/http.js";
import { decimalToNumber } from "../lib/math.js";
import { normalizeOrderbook } from "./normalize.js";

export class RisexClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.marketsCache = null;
  }

  url(path) {
    return `${this.config.baseUrl}${this.config.apiPrefix}${path}`;
  }

  async getMarkets(forceRefresh = false) {
    if (this.marketsCache && !forceRefresh) return this.marketsCache;
    const data = await requestJson(withQuery(this.url("/markets"), { force_refresh: forceRefresh }));
    this.marketsCache = data.markets ?? [];
    return this.marketsCache;
  }

  async resolveMarket(symbol) {
    const configured = this.config.markets[symbol];
    if (/^\d+$/.test(String(configured))) {
      return { market_id: String(configured), config: {} };
    }
    const markets = await this.getMarkets();
    const wanted = String(configured).toUpperCase();
    const found = markets.find((market) => {
      const names = [
        market.market_id,
        market.display_name,
        market.base_asset_symbol,
        market.underlying,
        market.config?.name,
      ]
        .filter(Boolean)
        .map((item) => String(item).toUpperCase());
      return names.includes(wanted) || names.includes(symbol.toUpperCase());
    });
    if (!found) {
      throw new Error(`RISEx market not found for ${symbol} (${configured})`);
    }
    return found;
  }

  async getOrderbook(symbol, depth) {
    const market = await this.resolveMarket(symbol);
    const raw = await requestJson(
      withQuery(this.url("/orderbook"), {
        market_id: market.market_id,
        limit: depth,
      }),
    );
    return normalizeOrderbook({
      exchange: "risex",
      symbol,
      market: market.market_id,
      raw,
    });
  }

  async getPortfolio() {
    if (!this.config.account) return null;
    return requestJson(withQuery(this.url("/portfolio/details"), { account: this.config.account }));
  }

  async getTradeHistory({ startTimeNs, endTimeNs, limit = 1000 } = {}) {
    if (!this.config.account) return { trades: [] };
    return requestJson(
      withQuery(this.url("/trade-history"), {
        account: this.config.account,
        start_time: startTimeNs,
        end_time: endTimeNs,
        limit,
        sorted_by: "-time",
      }),
    );
  }

  async getNonceState() {
    if (!this.config.account) throw new Error("RISEX_ACCOUNT is required for live orders");
    return requestJson(this.url(`/nonce-state/${this.config.account}`));
  }

  async buildPermit() {
    if (!this.config.account || !this.config.signer) {
      throw new Error("RISEX_ACCOUNT and RISEX_SIGNER are required for live orders");
    }
    const nonce = await this.getNonceState();
    const permit = {
      account: this.config.account,
      signer: this.config.signer,
      nonce_anchor: nonce.nonce_anchor ?? "0",
      nonce_bitmap_index: Number(nonce.current_bitmap_index ?? 0),
      deadline: Math.floor(Date.now() / 1000) + 60,
    };
    if (this.config.enableTestnetServerSigning && this.config.signerPrivateKey) {
      permit.signer_private_key = this.config.signerPrivateKey;
    } else {
      throw new Error(
        "RISEx live orders require a permit signature. Enable testnet server signing or add client-side EIP-712 signing.",
      );
    }
    return permit;
  }

  async placeOrder(order) {
    const market = await this.resolveMarket(order.symbol);
    const marketConfig = market.config ?? {};
    const stepSize = decimalToNumber(marketConfig.step_size) || 1;
    const stepPrice = decimalToNumber(marketConfig.step_price) || 1;
    const body = {
      market_id: Number(market.market_id),
      size_steps: Math.max(1, Math.floor(order.size / stepSize)),
      price_ticks: Math.max(1, Math.floor(order.price / stepPrice)),
      side: order.side === "buy" ? 0 : 1,
      post_only: false,
      reduce_only: Boolean(order.reduceOnly),
      stp_mode: 2,
      order_type: 1,
      time_in_force: 3,
      builder_id: 0,
      client_order_id: String(order.clientOrderId ?? "0"),
      ttl_units: 0,
      permit: await this.buildPermit(),
      no_retry: true,
    };
    return requestJson(this.url("/orders/place"), {
      method: "POST",
      body,
      retries: 0,
    });
  }
}
