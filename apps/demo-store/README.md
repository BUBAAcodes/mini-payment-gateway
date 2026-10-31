# Demo store

A pretend merchant that sells one T-shirt for ₹500 through the gateway. It does what any merchant integrating the gateway should do:

- **Creates orders with an `Idempotency-Key`.** If a request times out or gets a 5xx, it retries with the same key, so a retry can never create a second order.
- **Checks the redirect signature.** When checkout sends the customer back, the store verifies `signature = HMAC_SHA256("{order_id}|{payment_id}", checkout secret)`. The `status` in that redirect isn't signed, so the store only uses it to pick which page to show.
- **Verifies webhooks (Standard Webhooks).** It checks the signature against the raw request bytes, rejects timestamps more than 5 minutes off, and compares in constant time.
- **Skips webhook IDs it has already processed.** Delivery is at least once, so duplicates do arrive.
- **Re-fetches the payment from the API before fulfilling.** It fulfils only if the payment is `captured` and the amount matches. Once an order is fulfilled it stays fulfilled, so a late `payment.failed` from an earlier attempt can't undo it.

| Route                    | What it does                                                        |
| ------------------------ | ------------------------------------------------------------------- |
| `GET /`                  | Product page: size picker (S–XL) and a Buy button                   |
| `POST /buy`              | Creates a gateway order (size in its notes), redirects to checkout  |
| `GET /payments/callback` | Checks checkout's signature, then 303 to the order page (no page)   |
| `POST /webhooks/gateway` | Receives signed webhooks                                            |
| `GET /orders/:id`        | Order status; refreshes itself until the webhook marks it fulfilled |
| `GET /health`            | Health check                                                        |

**Orders and processed webhook IDs live in memory.** A restart forgets them. That's fine for a demo. A real merchant would store both in its database, and would record the webhook ID in the same transaction that fulfils the order.

## Configuration

| Variable                  | Default                 |                                                                                       |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `GATEWAY_SECRET_KEY`      | (required)              | The API key, `sk_test_…`                                                              |
| `GATEWAY_WEBHOOK_SECRET`  | (required)              | The webhook signing secret, `whsec_…`                                                 |
| `GATEWAY_CHECKOUT_SECRET` | (required)              | Verifies the checkout redirect signature                                              |
| `API_BASE_URL`            | `http://localhost:4000` | Where the gateway API lives                                                           |
| `STORE_BASE_URL`          | `http://localhost:3001` | This store's URL as the customer's browser sees it                                    |
| `PORT`                    | `3001`                  | When run on the host, the `PORT` in the root `.env` belongs to the API and is ignored |

`pnpm db:seed` prints the three secrets once. When run on the host, the store reads them from the repo's root `.env`.

## Running the full flow in Docker

```sh
docker compose up -d postgres redis
pnpm db:migrate        # or `pnpm db:reset` to start over (deletes all data)
# The API container reaches the store by service name, not localhost:
STORE_WEBHOOK_URL=http://demo-store:3001/webhooks/gateway pnpm db:seed
# Copy the three GATEWAY_* lines it prints into .env, then:
docker compose up --build
```

1. Open http://localhost:3001 and click **Buy now**.
2. Pay on the checkout page (http://localhost:3000) with UPI `success@test`, or with card `4111 1111 1111 1111` and OTP `123456`.
3. You land back on the store, and the order flips to **Fulfilled** within a few seconds, once the webhook arrives.

To run on the host instead: `pnpm db:seed` without `STORE_WEBHOOK_URL`, then `pnpm --filter @gateway/demo-store dev` alongside the API and web.
