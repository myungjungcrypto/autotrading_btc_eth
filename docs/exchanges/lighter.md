# Lighter Notes

## Production Market Data

- REST base URL: `https://mainnet.zklighter.elliot.ai`
- API prefix: `/api/v1`
- WebSocket URL: `wss://mainnet.zklighter.elliot.ai/stream`

The public WebSocket order book channel is:

```json
{
  "type": "subscribe",
  "channel": "order_book/{MARKET_INDEX}"
}
```

The channel publishes a complete snapshot on subscription and then state-change
updates. Updates are batched every 50ms. The `begin_nonce` on each update should
match the previous update's `nonce`; if it does not, the local book may have a
gap and must be rebuilt by resubscribing.

## Market Mapping

The current default mapping is:

```text
ETH-PERP: 0
BTC-PERP: 1
```

These values come from the official examples where ETH uses market index `0`
and BTC appears as market id `1`. If Lighter changes market indexing, update:

```text
LIGHTER_MARKET_BTC
LIGHTER_MARKET_ETH
```

Use `/api/v1/orderBooks` or `/api/v1/orderBookDetails` to verify precision,
fees, minimum order size, and market metadata before live trading.

## Live Orders

Live order placement is intentionally not implemented yet. Lighter orders require
an account index, API key index, private key, signer support, nonce management,
and integer price/size conversion using the market precision metadata.
