# Cascade API Notes

Source: user-provided Cascade developer guide, stored here for local reference.

## Environment

- App: `https://app.cascade.cooking`
- Engine API: `https://engine.cascade.cooking`
- Chain: Arbitrum Sepolia
- Funds: mock USDC

## Account Setup

1. Open `https://app.cascade.cooking`.
2. Enter invite code.
3. Create account with email verification.
4. Mint mock USDC on Arbitrum Sepolia:

```text
Contract: 0x0964018860620fcC232fC8C0A0fc0dC2911c4100
Function: mint(address to, uint256 amount)
```

5. Deposit funds to the Cascade deposit address.

## Delegates

After account setup, add a delegate EOA in the profile menu under Delegates.

Verification endpoint:

```bash
curl "https://engine.cascade.cooking/account/delegates?account=<ACCOUNT>&subaccountIndex=<INDEX>" \
  -H "Authorization: Bearer <token>"
```

## Authentication

Identity terms:

- Owner account: stable trading account identity.
- Delegate signer: wallet signing auth challenges or EIP-712 payloads.
- Subaccount index: risk sleeve under the owner account.

Manual auth:

1. Request a challenge:

```bash
curl "https://engine.cascade.cooking/auth?account=<OWNER_ACCOUNT>"
```

2. Sign `signing_payload` with EIP-191 and post:

```json
{
  "message": "<challenge.message>",
  "signature": "<signature>",
  "server_signature": "<challenge.server_signature>"
}
```

3. Use returned `token`:

```text
Authorization: Bearer <token>
```

4. WebSocket auth:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "auth",
  "params": { "bearer": "<token>" }
}
```

## Public Orderbook

Cascade's current app reads public orderbooks from the engine WebSocket:

```text
wss://engine.cascade.cooking/ws
```

Subscription format:

```json
{
  "jsonrpc": "2.0",
  "method": "subscribe",
  "params": {
    "source": "book",
    "symbol": "BTC-USD-PERP",
    "tickSize": 0.1
  },
  "id": 1
}
```

The bot uses this for paper/live market data.

## Implementation Note

The provided docs confirm auth and account routes, but do not publish live order placement schemas. This repository keeps Cascade order routes configurable:

- `CASCADE_ORDERBOOK_TRANSPORT`
- `CASCADE_WS_PATH`
- `CASCADE_ORDERBOOK_TICK_SIZE`
- `CASCADE_ORDERBOOK_PATH`
- `CASCADE_ORDERBOOK_QUERY_PARAM`
- `CASCADE_PLACE_ORDER_PATH`
- `CASCADE_CANCEL_ORDER_PATH`
- `CASCADE_POSITIONS_PATH`
- `CASCADE_MARKETS_PATH`
