# RISEx API Notes

Sources:

- `https://docs.risechain.com/docs/risex`
- `https://developer.rise.trade/reference/general-information`
- `https://developer.rise.trade/reference/authservice_registersigner`

## Base URLs

- REST testnet: `https://api.testnet.rise.trade/v1`
- WebSocket testnet variable in docs: `wss://ws.testnet.rise.trade/ws`

## Useful REST Routes

- `GET /v1/markets`
- `GET /v1/orderbook?market_id=<id>&limit=<depth>`
- `POST /v1/orders/place`
- `POST /v1/orders/cancel`
- `GET /v1/orders/open`
- `GET /v1/portfolio/details?account=<address>`
- `GET /v1/trade-history`
- `GET /v1/auth/eip712-domain`
- `GET /v1/nonce-state/{account}`
- `POST /v1/auth/register-signer`

## Orderbook Shape

Current testnet market ids used by this bot:

- BTC/USDC: `1`
- ETH/USDC: `2`

`GET /v1/orderbook` returns:

```json
{
  "market_id": "1",
  "bids": [{ "price": "decimal string", "quantity": "decimal string", "order_count": 1 }],
  "asks": [{ "price": "decimal string", "quantity": "decimal string", "order_count": 1 }]
}
```

## Place Order Shape

`POST /v1/orders/place` accepts:

```json
{
  "market_id": 1,
  "size_steps": 100,
  "price_ticks": 50000,
  "side": 0,
  "post_only": false,
  "reduce_only": false,
  "stp_mode": 0,
  "order_type": 1,
  "time_in_force": 3,
  "builder_id": 0,
  "client_order_id": "0",
  "ttl_units": 0,
  "permit": {
    "account": "0x...",
    "signer": "0x...",
    "nonce_anchor": "0",
    "nonce_bitmap_index": 0,
    "deadline": 1700000000,
    "signature": "0x..."
  }
}
```

Side values: `0=Buy`, `1=Sell`.

Order type values: `0=Market`, `1=Limit`.

Time-in-force values: `0=GTC`, `1=GTT`, `2=FOK`, `3=IOC`.

## Auth Notes

Signer registration uses EIP-712 with `RegisterSigner` and `VerifySigner`, both using `GET /v1/auth/eip712-domain`.

Authenticated order operations use a `permit` object. The public docs describe a testnet-only server signing field `signer_private_key`; this app can include it only when explicitly enabled for testnet.
