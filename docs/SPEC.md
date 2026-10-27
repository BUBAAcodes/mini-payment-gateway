# Mini Payment Gateway: Build Spec

A test-mode simulation of a payment gateway's core backend: a small Razorpay or Stripe with a fake bank and no real money.

This file is the single source of truth for the project. **Claude Code: read the whole file before every session.**

---

## 0. How to work with this spec

**For every build step (section 14):**
1. Read this file and the code that already exists.
2. Show a short plan and wait for approval.
3. Write the tests for the step first, then the code.
4. Run the tests and the type-check; fix until everything passes.
5. Explain what you built in plain words and ask me 3 quiz questions about it.
6. Commit with a message like `step-08: orders API with idempotency`.

**Ground rules:**
- One step per session. Don't start the next step on your own.
- Never break a rule in section 3. If a step seems to need it, stop and ask.
- No new dependency without saying why. Prefer Node built-ins (`crypto`, `fetch`).
- Small functions named after the business action (`capturePayment`, `createRefund`).
- Every path that moves money has an integration test against a real Postgres.

---

## 1. What we're building, in plain words

A payment gateway is the middleman between shops and banks. It is not a bank. It shows the customer a payment screen, asks the bank to approve the payment, tells the shop "paid", keeps a record of what it owes each shop, and later pays each shop minus a fee.

| Term | Meaning |
|---|---|
| Merchant | The shop that wants to get paid |
| Customer | The person paying |
| Gateway API | Our service; merchants' servers call it |
| API key | The merchant's secret password for our API |
| Checkout page | The payment screen the customer sees |
| Fake bank | A pretend bank inside our code that approves, declines or delays |
| Capture | The moment the money is confirmed as taken |
| Webhook | Our server calling the merchant's server: "payment pay_123 captured" |
| Ledger | Append-only, double-entry record of who owes whom |
| Idempotency | Repeating the same request never repeats its effect |
| Refund | Money returned to the customer |
| Settlement | Paying a merchant what we owe them |
| Reconciliation | Checking our records against the bank's records |
| Outbox | A table of events written in the same transaction as the change they describe |

### One payment, start to finish
1. A customer buys a ₹500 T-shirt on the demo store.
2. The store's server asks our API to create a ₹500 order.
3. The customer lands on our checkout page and enters a test UPI ID.
4. Our gateway asks the fake bank, which approves.
5. We record it in the ledger: the store is owed ₹490 and we keep ₹10 as our fee.
6. We send the store a signed webhook saying "paid", and the store fulfils the order.
7. Later we settle ₹490 to the store and reconcile our records with the bank's file.

---

## 2. Scope

**In scope:** merchant signup and API keys; orders; hosted checkout with simulated UPI and cards (with OTP); a fake bank with success, failure, delay and lost-callback cases; payments with a state machine; double-entry ledger; full and partial refunds; signed webhooks with retries and replay; settlements; reconciliation against the bank's file; merchant dashboard; demo store; rate limiting; API docs; tests; Docker; CI/CD; free deployment.

**Out of scope (real gateways do these; we skip or simulate them):** real banks, UPI (NPCI) and card networks; RBI payment aggregator authorisation; merchant KYC; escrow accounts; PCI DSS audits and card tokenisation; fraud scoring, disputes and chargebacks; routing across banks; payment methods beyond UPI and cards; multi-currency; multi-region high availability.

---

## 3. Rules that must always hold

1. **Money** is integer paise, never floats. INR only. Order amounts are between 100 and 50,000,000 paise (₹1 to ₹5,00,000).
2. **Idempotency:** a POST with an `Idempotency-Key` we've already seen never creates a second object.
3. **Ledger:** every ledger transaction balances (total debits = total credits). Ledger rows are never updated or deleted; corrections are new reversal entries.
4. **Atomicity:** a payment or refund state change, its ledger entries and its outbox event commit in one database transaction, or not at all.
5. **One payment per order:** an order is paid at most once, and at most one payment attempt per order is in progress at a time.
6. **No over-refunds:** refunds on a payment never add up to more than the captured amount.
7. **Webhooks** are signed (Standard Webhooks), delivered at least once, and may arrive out of order.
8. **Secrets:** API keys are stored only as a prefix plus a SHA-256 hash and shown once. Secrets we must use later (webhook signing secrets, checkout signing secrets) are encrypted at rest with AES-256-GCM.
9. **Cards:** full card numbers are never stored or logged, not even fake ones. Keep only the last four digits and the network.
10. **Timeouts:** a bank timeout means "unknown", never "failed". Resolve it with a status check.
11. **No open transactions during network calls:** never hold a database transaction open while calling the bank or a webhook URL.
12. **Sleep-safe jobs:** every background job catches up on overdue work at startup, because the free server sleeps.
13. **Test mode only:** our own brand and a visible test-mode banner on checkout. Never imitate a real gateway's name or design.

---

## 4. Stack and repo layout

| Piece | Choice |
|---|---|
| Monorepo | pnpm workspaces (Turborepo optional later) |
| Language | TypeScript everywhere, strict mode |
| API | Express 5 + Zod (Express 5 passes async errors to the error handler) |
| Database | PostgreSQL 17 (Docker locally, Neon when deployed) |
| ORM | Prisma 7 with `@prisma/adapter-pg`; raw SQL via `$queryRaw` for row locks and `SKIP LOCKED` |
| Redis | Rate limiting only (Docker locally, Upstash when deployed; later your own MiniRedis) |
| Dashboard + checkout | Next.js (App Router) + Tailwind + shadcn/ui |
| Dashboard login | Better Auth (email + password) |
| Logging | pino, with a request ID on every log line |
| API docs | OpenAPI generated from the Zod schemas (zod-to-openapi, or Zod 4's JSON Schema export), served with Scalar at `/docs` |
| Manual API testing | Bruno collection committed in `docs/bruno/` |
| Local email | Mailpit (only if you add email verification or password resets) |
| Tests | Vitest, Supertest, Testcontainers, Playwright; k6 optional |
| CI/CD | GitHub Actions, images in GHCR |
| Security checks | Dependabot, CodeQL, Trivy |
| Hosting | Render (API, demo store), Vercel (web), Neon (Postgres), Upstash (Redis) |
| Diagrams | Mermaid in the README |

```text
gateway/
├── apps/
│   ├── api/                  # Express API, webhook worker, jobs, fake bank
│   │   └── src/
│   │       ├── routes/       # merchant, checkout, internal, dashboard
│   │       ├── services/     # orders, payments, ledger, refunds, webhooks, settlements, reconciliation
│   │       ├── fake-bank/    # simulated bank behind a BankClient interface
│   │       ├── jobs/         # worker loops: outbox fan-out, delivery sender, status checks, cleanup
│   │       └── middleware/   # auth, idempotency, rate limit, validation, request ID, errors
│   ├── web/                  # Next.js: dashboard + /pay/[orderId] checkout
│   └── demo-store/           # pretend merchant (Express + simple HTML)
├── packages/
│   ├── db/                   # Prisma schema, migrations (incl. raw SQL), seed, client
│   └── shared/               # Zod schemas, money helpers, IDs, errors, webhook sign/verify, crypto helpers
├── docs/
│   ├── SPEC.md               # this file
│   ├── architecture.md
│   ├── decisions/            # one short file per design decision
│   └── bruno/                # API collection
├── .github/
│   ├── workflows/            # ci.yml, cron.yml
│   └── dependabot.yml
├── docker-compose.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

**Monorepo notes:**
- Apps depend on `"@gateway/shared": "workspace:*"` and `"@gateway/db": "workspace:*"`.
- Every package extends `tsconfig.base.json`.
- Add internal TypeScript packages to `transpilePackages` in `next.config`, or the web app won't build.
- Import the Prisma client only from `packages/db`; never create a second client.

---

## 5. Configuration

Commit `.env.example`; never commit `.env`.

| Variable | App | Purpose |
|---|---|---|
| `DATABASE_URL` | api, web | Postgres connection (Neon pooled URL when deployed) |
| `DIRECT_DATABASE_URL` | db | Direct (non-pooled) URL for migrations |
| `REDIS_URL` | api | Rate limiting |
| `APP_ENCRYPTION_KEY` | api | 32 random bytes, base64; encrypts stored secrets |
| `INTERNAL_CRON_SECRET` | api | Protects `/internal/*` jobs |
| `DASHBOARD_SERVICE_TOKEN` | api, web | Lets the dashboard server call the API |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | web | Dashboard login |
| `API_BASE_URL` | web, demo-store | Where the API lives |
| `WEB_BASE_URL` | api | Used to build checkout URLs |
| `FEE_BPS` | api | Fee in basis points, default `200` (2%) |
| `SETTLEMENT_DELAY_DAYS` | api | Default `0` for demos (real gateways use cycles like T+2) |
| `RATE_LIMIT_PER_MINUTE` | api | Default `100` per API key |
| `ALLOW_PRIVATE_WEBHOOK_URLS` | api | `true` locally so webhooks can reach Docker services; `false` when deployed |
| `BANK_SLOW_MS`, `BANK_TIMEOUT_MS` | api | Fake bank delay and our timeout for bank calls |
| `LOG_LEVEL` | all | `info` by default |
| `GATEWAY_SECRET_KEY` | demo-store | Its API key |
| `GATEWAY_WEBHOOK_SECRET` | demo-store | Its webhook signing secret |
| `GATEWAY_CHECKOUT_SECRET` | demo-store | Verifies the redirect signature |
| `STORE_BASE_URL` | demo-store | Its own public URL, for callbacks |

**Prisma 7 notes:** it doesn't load `.env` by itself; the datasource URL lives in `prisma.config.ts`, not `schema.prisma`; and the client needs the `pg` driver adapter.

---

## 6. Data model

All money columns are `Int` paise. All tables have `created_at`; tables that change also have `updated_at`. Every merchant-owned table has `merchant_id`, and every query filters by it.

**Merchants and access**
- `merchants`: id, name, checkout_signing_secret (encrypted).
- `users` and the Better Auth tables (`session`, `account`, `verification`): dashboard logins; `users.merchant_id` links a login to a merchant.
- `api_keys`: id, merchant_id, prefix (unique), key_hash, last_used_at, revoked_at.

**Orders and payments**
- `orders`: id, merchant_id, amount, currency, receipt, notes (JSON), status (`created | attempted | paid`), client_secret_hash, callback_url, paid_at.
- `payments`: id, merchant_id, order_id, amount, fee, amount_refunded, currency, method (`upi | card`), vpa, card_last4, card_network, status (section 9.2), failure_reason, bank_ref, bank_status_checks, authorized_at, captured_at.
- `refunds`: id, merchant_id, payment_id, amount, status (`pending | processed | failed`), bank_ref, failure_reason, processed_at.

**Ledger**
- `ledger_accounts`: id, code (unique, such as `gateway_clearing`, `fee_revenue`, `payouts`, `merchant_balance:mer_123`), type (`asset | liability | revenue`), merchant_id (nullable).
- `ledger_transactions`: id, type (`capture | refund | payout | reversal`), reference_type, reference_id.
- `ledger_entries`: id, transaction_id, account_id, direction (`debit | credit`), amount (> 0).

**Reliability**
- `idempotency_keys`: merchant_id, key, method, path, request_hash, state (`in_progress | completed`), response_status, response_body (JSON); unique on (merchant_id, key).
- `events` (the outbox): id, merchant_id, type, payload (JSON), dispatched_at.
- `webhook_endpoints`: id, merchant_id, url, secret (encrypted), event_types (array, or `*`), enabled, disabled_reason.
- `webhook_deliveries`: id, event_id, endpoint_id, status (`pending | succeeded | failed`), attempt_count, next_attempt_at, locked_until, last_attempt_at, last_response_status, last_response_ms, last_error.

**Back office**
- `settlements`: id, merchant_id, period_start, period_end, gross, fees, refunds, net, status (`processed`).
- `bank_settlement_files`: id, bank_date, csv_text, imported_at.
- `bank_settlement_rows`: id, file_id, bank_ref, gateway_reference, type (`payment | refund`), amount, status.
- `reconciliation_issues`: id, bank_date, kind (`missing_in_gateway | missing_in_bank | amount_mismatch | status_mismatch`), gateway_reference, bank_ref, details (JSON), resolved_at.

**Fake bank (its own table, kept separate from ours)**
- `bank_transactions`: bank_ref, gateway_reference, type (`payment | refund`), amount, outcome, decided_at, callback_sent.

**Constraints that need raw SQL migrations** (create the migration with `prisma migrate dev --create-only`, then edit the SQL):
- `CHECK (amount BETWEEN 100 AND 50000000)` on orders; `CHECK (amount > 0)` on refunds and ledger entries.
- A partial unique index so only one attempt per order is in progress:
  `CREATE UNIQUE INDEX one_active_attempt ON payments (order_id) WHERE status IN ('created', 'otp_required', 'pending', 'authorized');`
- A deferrable constraint trigger on `ledger_entries` that rejects any transaction whose debits and credits differ at commit time.
- A trigger that blocks UPDATE and DELETE on `ledger_entries`.
- Indexes: `webhook_deliveries (status, next_attempt_at)`, `payments (merchant_id, created_at)`, `events (dispatched_at)`, `payments (status)`.

---

## 7. IDs, money, errors and API conventions

- **IDs:** prefixed random IDs: `mer_`, `key_`, `order_`, `pay_`, `rfnd_`, `evt_`, `we_` (webhook endpoint), `wd_` (delivery), `stl_`, `ltx_`, followed by 14 base62 characters (Node `crypto` or nanoid's custom alphabet).
- **API keys:** `sk_test_` plus 32 random base62 characters, shown once. Store the first 12 characters as `prefix` and the SHA-256 of the full key; compare with `crypto.timingSafeEqual`.
- **Client secrets:** `cs_` plus 24 random characters, returned once when the order is created and stored as a hash.
- **Webhook secrets:** `whsec_` plus the base64 of 32 random bytes (Standard Webhooks format), encrypted at rest.
- **Checkout signing secret:** one per merchant, encrypted at rest, shown once in the dashboard and by the seed script.
- **Fees:** `fee = round_half_up(amount × FEE_BPS / 10000)` in integer math. ₹500 (50,000 paise) at 200 bps → 1,000 paise.
- **Errors:** always `{ "error": { "code": "...", "message": "...", "field": "..." } }`.
  - 400 `validation_error` · 401 `unauthorized` · 404 `not_found` · 409 `idempotency_in_progress` or `conflict` · 422 `idempotency_mismatch` or `invalid_state` · 429 `rate_limited` · 500 `internal_error`.
- **Pagination:** `?limit=20&starting_after=pay_x` (limit 1–100); responses look like `{ "data": [...], "has_more": true }`.
- **Versioning:** everything under `/v1`.
- **Request IDs:** accept or generate `X-Request-Id`, return it on every response, include it in every log line.
- **Auth header:** `Authorization: Bearer sk_test_...`.

---

## 8. API reference

### Merchant API (API key)
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/orders` | Requires `Idempotency-Key`. Body: amount, currency, receipt, callback_url, notes. Returns the order, `client_secret` and `checkout_url` |
| GET | `/v1/orders/:id` | Includes its payments |
| GET | `/v1/payments` | Filters: status, from, to. Paginated |
| GET | `/v1/payments/:id` | Merchants re-fetch this before fulfilling |
| POST | `/v1/payments/:id/refunds` | Requires `Idempotency-Key`. Body: amount (optional; defaults to what's left) |
| GET | `/v1/refunds/:id` | |
| POST | `/v1/webhook_endpoints` | Body: url, event_types. Returns the secret once |
| GET | `/v1/webhook_endpoints` | |
| DELETE | `/v1/webhook_endpoints/:id` | |
| POST | `/v1/webhook_endpoints/:id/test` | Sends a `ping` event |
| GET | `/v1/events` | Paginated, with delivery status |
| POST | `/v1/events/:id/redeliver` | Queues a new delivery attempt |
| GET | `/v1/balance` | Unsettled balance from the ledger |
| GET | `/v1/settlements` | Paginated |

Example request, `POST /v1/orders`:
```json
{ "amount": 50000, "currency": "INR", "receipt": "rcpt_1001",
  "callback_url": "https://demo-store.example/payments/callback" }
```
Response `201`:
```json
{ "id": "order_8fK2mQx9LpZ3aB", "amount": 50000, "currency": "INR",
  "status": "created", "receipt": "rcpt_1001",
  "client_secret": "cs_...",
  "checkout_url": "https://web.example/pay/order_8fK2mQx9LpZ3aB?cs=cs_...",
  "created_at": "2026-10-28T10:00:00Z" }
```

### Checkout API (client secret; called only from Next.js server code)
| Method | Path | Notes |
|---|---|---|
| GET | `/checkout/orders/:id?cs=` | Amount, merchant name, status |
| POST | `/checkout/orders/:id/pay` | Body: method plus vpa, or card number, expiry and name. Starts a payment |
| POST | `/checkout/payments/:id/otp` | Body: otp |
| GET | `/checkout/payments/:id` | Polled for the result |

### Internal API (`INTERNAL_CRON_SECRET`)
| Method | Path | Notes |
|---|---|---|
| POST | `/internal/settle` | Creates settlements for every merchant |
| POST | `/internal/reconcile` | Imports today's bank file and compares it with our records |
| POST | `/internal/cleanup` | Deletes idempotency keys older than 24 hours |

### Dashboard API (`DASHBOARD_SERVICE_TOKEN` + `X-Merchant-Id`)
The Next.js server calls these with the merchant ID from the logged-in session. They reuse the same services as the merchant API: list payments, payment detail, create refund, list/create/revoke API keys, webhook endpoints, events and deliveries, replay, balance, settlements, reconciliation issues and marking them resolved.

### Health
`GET /health` (process is up) and `GET /ready` (database is reachable).

### Demo store routes
`GET /` product page · `POST /buy` creates an order and redirects to checkout · `GET /payments/callback` checks the redirect signature · `POST /webhooks/gateway` receives webhooks · `GET /orders/:id` shows the order's status.

---

## 9. Core flows

### 9.1 Payment
1. The merchant's server calls `POST /v1/orders` with an `Idempotency-Key`. Order status: `created`.
2. The customer opens `/pay/{orderId}?cs=...`. The Next.js server checks the client secret through the checkout API.
3. The customer picks UPI or card. In one transaction the API locks the order row (`SELECT … FOR UPDATE`), rejects it if already paid, creates a payment (`created`) and sets the order to `attempted`. The partial unique index blocks a second in-progress attempt.
4. Card payments move to `otp_required` until the OTP is submitted.
5. The API calls the fake bank (outside any transaction) and the payment moves to `pending`.
6. The bank approves → `authorized` → auto-capture.
7. **Capture, in one transaction:** payment `captured` with its fee, order `paid`, ledger capture entries, outbox event `payment.captured`.
8. The bank declines → payment `failed` with a reason and outbox event `payment.failed`. The customer can retry, which creates a new attempt.
9. Checkout redirects the customer to `callback_url` with `order_id`, `payment_id`, `status` and `signature = HMAC_SHA256("{order_id}|{payment_id}", checkout_signing_secret)` as hex.
10. The worker delivers webhooks. The demo store checks the signature, skips IDs it has seen, re-fetches the payment, then fulfils.

### 9.2 Payment states
| From | To | When |
|---|---|---|
| created | otp_required | Card payment needs an OTP |
| created or otp_required | pending | Sent to the bank |
| pending | authorized | The bank approves |
| pending | failed | The bank declines, or status checks give up |
| authorized | captured | The capture transaction commits |
| captured | refunded | Total refunded equals the amount (partial refunds stay `captured` and raise `amount_refunded`) |

Any other move throws. Implement it as one `transition(payment, to)` function with a table of allowed moves.

### 9.3 Order states
`created → attempted → paid`. Only a captured payment moves an order to `paid`.

### 9.4 Ledger entries
| Event | Debit | Credit |
|---|---|---|
| Capture ₹500 with a ₹10 fee | `gateway_clearing` 50,000 | `merchant_balance` 49,000 and `fee_revenue` 1,000 |
| Refund ₹200 | `merchant_balance` 20,000 | `gateway_clearing` 20,000 |
| Settlement payout ₹290 | `merchant_balance` 29,000 | `payouts` 29,000 |

The fee is not returned on refunds (record this as a design decision). Merchant balance = credits − debits on `merchant_balance:{id}`.

### 9.5 Refund
1. `POST /v1/payments/:id/refunds` with an `Idempotency-Key`.
2. In one transaction: lock the payment row (`SELECT … FOR UPDATE`), check the status is `captured` and that `amount_refunded + amount ≤ amount`, create the refund (`pending`) and raise `amount_refunded`. Commit.
3. Ask the fake bank to refund (outside any transaction).
4. On success, in one transaction: refund `processed`, ledger refund entries, payment `refunded` if fully refunded, outbox event `refund.processed`.
5. On failure, in one transaction: refund `failed`, lower `amount_refunded` again, outbox event `refund.failed`.
6. If the merchant balance goes negative, allow it (real gateways recover it from future settlements) and show it on the dashboard.

### 9.6 Webhook delivery
1. **Fan-out loop:** claim undispatched events with `FOR UPDATE SKIP LOCKED`, create one delivery per enabled endpoint subscribed to that event type, set `dispatched_at`, all in one transaction.
2. **Sender loop:** claim due deliveries with a lease, then commit straight away:
   ```sql
   UPDATE webhook_deliveries SET locked_until = now() + interval '30 seconds'
   WHERE id IN (
     SELECT id FROM webhook_deliveries
     WHERE status = 'pending' AND next_attempt_at <= now()
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY next_attempt_at
     LIMIT 10
     FOR UPDATE SKIP LOCKED)
   RETURNING *;
   ```
   If a worker dies mid-send, the lease expires and another loop picks the delivery up. That's why delivery is at least once.
3. Sign and POST with a 15-second timeout. A 2xx response is success; anything else, including redirects and timeouts, is a failure.
4. On failure: increase `attempt_count`, set `next_attempt_at` from the schedule in section 11 with ±20% jitter, and clear the lease. After the last attempt, mark the delivery `failed`.
5. Replay creates a fresh `pending` delivery for the same event (same `webhook-id`).
6. Both loops poll every 2 seconds while the server is awake and run once at startup to catch up.

### 9.7 Settlement
1. GitHub Actions cron calls `POST /internal/settle` once a day.
2. For each merchant: take captured payments and processed refunds since the last settlement and older than `SETTLEMENT_DELAY_DAYS`; compute gross, fees, refunds and net.
3. In one transaction: the settlement row, ledger payout entries for `net`, and outbox event `settlement.processed`.
4. Skip merchants whose net is zero or negative.

### 9.8 Reconciliation
1. The fake bank writes a CSV for each day: `bank_ref,gateway_reference,type,amount,status,bank_date`.
2. `POST /internal/reconcile` imports the file into `bank_settlement_rows`.
3. Compare it with our payments and refunds for that day and record issues: in the bank's file but not ours, ours but not the bank's, different amounts, and different statuses (for example, the bank says success but we say failed).
4. Show issues on the dashboard with a "mark resolved" button.

### 9.9 Pending payment status checks
Every 30 seconds, a job claims `pending` payments (with `SKIP LOCKED`) and asks the fake bank for their status. When the bank gives a final answer, apply it through the normal flow. After 15 minutes without an answer, mark the payment `failed` with reason `bank_timeout`. If the bank later reports success, reconciliation flags it.

---

## 10. Fake bank

Lives in `apps/api/src/fake-bank/` behind a `BankClient` interface (`authorize`, `getStatus`, `refund`, `settlementFile`), so a real bank could replace it later. It keeps its own records in `bank_transactions`, separate from ours, so reconciliation has two independent sources to compare.

| Test input | Behaviour |
|---|---|
| UPI `success@test` | Approves after about 1 second |
| UPI `fail@test` | Declines with `insufficient_funds` |
| UPI `slow@test` | Answers after `BANK_SLOW_MS` (default 20 seconds), longer than our timeout, so the payment stays `pending` until a status check resolves it |
| UPI `lost@test` | Approves in its own records but never tells us and keeps answering "pending" until we give up. Reconciliation must catch it |
| Card ending in `1111` | Approves after the OTP |
| Card ending in `0002` | Declines with `card_declined` |
| OTP `123456` | Correct; anything else fails with `otp_invalid` |

Card numbers must pass the Luhn check. Refunds always succeed unless the order's notes contain `"fail_refund": true` (to test refund failures).

---

## 11. Webhooks

Follows the open **Standard Webhooks** spec.

- **Headers:**
  - `webhook-id`: the event ID, the same on every retry.
  - `webhook-timestamp`: Unix seconds, new on each attempt.
  - `webhook-signature`: `v1,<base64>`; several space-separated values while a secret is being rotated.
- **Signature:** HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed with the base64-decoded part of the `whsec_` secret.
- **Receiver rules (the demo store follows these):** verify against the raw bytes, reject timestamps more than 5 minutes off, compare in constant time, skip IDs already processed, and re-fetch the object from the API before acting.
- **Payload:** `{ "id": "evt_...", "type": "payment.captured", "created_at": "...", "data": { "object": { ... } } }`.
- **Event types:** `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`, `settlement.processed`, `ping`.
- **Retry schedule** (delay after each failure): immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h, each with ±20% jitter. Then `failed`.
- **Success:** a 2xx response within 15 seconds.
- **Auto-disable (optional):** disable an endpoint after 5 days of nothing but failures.
- **Ordering:** not guaranteed; receivers must handle events arriving out of order.
- **SSRF protection:**
  - Allow only `http` and `https`.
  - Resolve the hostname and refuse private, loopback and link-local addresses (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7), unless `ALLOW_PRIVATE_WEBHOOK_URLS=true`.
  - Check again at send time, because DNS can change after the URL is saved.

---

## 12. Security checklist

- [ ] API keys hashed with SHA-256, shown once, revocable; `last_used_at` updated.
- [ ] Webhook and checkout signing secrets encrypted with AES-256-GCM (random IV, stored with the auth tag).
- [ ] Constant-time comparison for keys and signatures.
- [ ] Every query scoped by `merchant_id`; a test proves merchant A can't read merchant B's payment.
- [ ] Zod validation on every input; JSON body limit of 100 KB.
- [ ] `helmet` headers on the API. The browser never calls the API directly (Next.js server code does), so CORS stays closed.
- [ ] Rate limiting per API key (step 18).
- [ ] pino `redact` for the `authorization` header, card numbers, secrets and OTPs.
- [ ] SSRF checks on webhook URLs.
- [ ] Internal and dashboard routes require their secret tokens.
- [ ] No full card numbers anywhere: database, logs or error messages.
- [ ] No database transaction held open during a bank call or webhook request.

---

## 13. Screens

### Checkout (`apps/web`, route `/pay/[orderId]`)
- Test-mode banner: "Test mode. Never enter real card details."
- Merchant name and amount in ₹; UPI and card tabs, with the test inputs listed under each form.
- OTP screen for cards; a "processing" screen that polls for the result; success and failure screens, with "try again" on failure.
- Redirects to the merchant's `callback_url` with the signature.

### Dashboard (`apps/web`)
- Sign up and log in with Better Auth. Protect routes in `proxy.ts` (Next.js 16's name for middleware).
- Overview: balance, today's volume, success rate.
- Payments: list with filters, and a detail page with a refund button.
- API keys: create (shown once), list, revoke.
- Webhook endpoints: add (secret shown once), choose event types, send a test, delete.
- Events and deliveries: status, attempts, response codes, replay button.
- Settlements report.
- Reconciliation issues with "mark resolved".

### Demo store (`apps/demo-store`)
- One product page ("T-shirt, ₹500") with a buy button; a callback page ("payment received, confirming…"); an order page that flips to "fulfilled" when the webhook arrives.
- Keeps its orders and processed webhook IDs in memory. That's fine for a demo; say so in the README.

---

## 14. Build steps

Each step: build → tests pass → explain → commit. Do step 1 by hand; do the rest with Claude Code.

### Phase A: Foundation
- [ ] **1. Workspace (by hand).** `git init`; `pnpm init`; `pnpm-workspace.yaml` listing `apps/*` and `packages/*`; `pnpm create next-app@latest apps/web` (TypeScript, ESLint, Tailwind, App Router); `tsconfig.base.json`; `.gitignore`; Prettier; root scripts (`dev`, `build`, `lint`, `typecheck`, `test` via `pnpm -r`).
  *Done when:* `pnpm -r typecheck` passes.
- [ ] **2. Shared packages.** `packages/shared` (money helpers, fee calculation, ID generator, error classes, base Zod schemas) and `packages/db` (Prisma 7, `prisma.config.ts`, pg adapter, exported client).
  *Done when:* fee and ID unit tests pass, and an app can import both packages.
- [ ] **3. API skeleton and Docker.** Express 5 app with `/health` and `/ready`, pino with request IDs, error handler, Zod validation middleware, `helmet`, body limit. `docker-compose.yml` with Postgres 17 and Redis (with healthchecks), Mailpit optional. Multi-stage Dockerfile running as a non-root user.
  *Done when:* `docker compose up` starts everything and `/ready` returns 200.
- [ ] **4. CI, first version.** `.github/workflows/ci.yml`: pnpm install with cache, lint, type-check and unit tests on every push and pull request.
  *Done when:* the CI badge is green on GitHub.

### Phase B: Merchants and access
- [ ] **5. Schema and seed.** All tables from section 6; raw SQL migrations (checks, partial index, ledger triggers); a seed script that creates the demo merchant, a dashboard login, an API key, a webhook endpoint pointing at the demo store and the checkout signing secret, printing the secrets once. Also seed a few sample payments (captured, failed, partially refunded) so the dashboard never looks empty.
  *Done when:* a test inserting an unbalanced ledger transaction fails at commit, and updating a ledger row fails.
- [ ] **6. API keys and auth.** Key generation, prefix lookup, hash comparison, revoke, `last_used_at`; `Authorization: Bearer` middleware; merchant scoping on every query.
  *Done when:* tests cover valid, revoked, wrong and missing keys, and cross-merchant access returns 404.
- [ ] **7. Secret encryption.** AES-256-GCM helpers in `packages/shared`, used for webhook and checkout secrets.
  *Done when:* an encrypt-then-decrypt test passes and tampered ciphertext is rejected.

### Phase C: Orders and payments
- [ ] **8. Orders and idempotency.** `POST /v1/orders`, `GET /v1/orders/:id`; idempotency middleware that inserts the key row first, replays the stored response with header `Idempotent-Replayed: true`, returns 422 for a different body and 409 while the first request is still running.
  *Done when:* 20 parallel requests with one key create exactly one order, and the same key with a different body returns 422.
- [ ] **9. Fake bank.** Everything in section 10, behind `BankClient`, with its own table and the daily CSV.
  *Done when:* unit tests cover every test input.
- [ ] **10. Payments and checkout API.** Checkout endpoints, order lock, payment state machine, OTP, bank call with timeout, status-check job for `pending` payments.
  *Done when:* state machine tests pass (illegal moves throw); two simultaneous pay attempts on one order → only one proceeds; a `slow@test` payment ends `captured` after a status check.
- [ ] **11. Ledger and capture.** A ledger service (`post(transaction, entries)` that refuses unbalanced input), and the capture transaction with fee and outbox event.
  *Done when:* after a random mix of payments, every ledger transaction balances and the merchant balance equals the sum of net captures; an error forced in the middle of a capture leaves no payment change, no ledger rows and no event.
- [ ] **12. Checkout page.** `/pay/[orderId]` in Next.js with the screens from section 13, calling the API only from server code; redirect with signature.
  *Done when:* you can pay with `success@test` in the browser and land on the callback URL with a valid signature.

### Phase D: Telling merchants
- [ ] **13. Webhook endpoints.** Create (secret shown once), list, delete, send a test; SSRF checks.
  *Done when:* private URLs are rejected when the flag is off, and the test event is delivered.
- [ ] **14. Webhook worker.** Fan-out, leased claiming with `SKIP LOCKED`, signing, 15-second timeout, retry schedule with jitter, `failed` state, replay, startup catch-up.
  *Done when:* a receiver that returns 500 once is retried and then marked succeeded; two sender loops never deliver the same delivery twice; signature tests pass (a tampered body and an old timestamp both fail).
- [ ] **15. Demo store.** Pages and routes from section 13. Creates orders with an idempotency key, checks the redirect signature and webhook signatures, skips duplicates, and re-fetches before fulfilling.
  *Done when:* the full flow works locally in Docker: buy → pay → "fulfilled".

### Phase E: After the payment
- [ ] **16. Refunds.** Section 9.5: full and partial, idempotent, with `refund.processed` and `refund.failed` events.
  *Done when:* two simultaneous refunds that together exceed the amount → only one succeeds; the ledger balances; a full refund sets the payment to `refunded`.
- [ ] **17. Settlements, reconciliation and cron.** Sections 9.7 and 9.8, plus `.github/workflows/cron.yml` running daily at 02:00 IST (`30 20 * * *` in UTC) and calling `/internal/settle`, `/internal/reconcile` and `/internal/cleanup`.
  *Done when:* a `lost@test` payment shows up as a `status_mismatch` issue, and settlement net equals the ledger payout.
- [ ] **18. Rate limits and API docs.** Fixed-window limit per API key with Redis `INCR` + `EXPIRE` (429 with `Retry-After`); OpenAPI generated from Zod, served with Scalar at `/docs`; Bruno collection.
  *Done when:* request number 101 within a minute gets a 429, and `/docs` lists every endpoint.

### Phase F: Dashboard
- [ ] **19. Login and dashboard API.** Better Auth with email and password, a seeded demo login, route protection in `proxy.ts`; dashboard API routes protected by the service token.
  *Done when:* logged-out visitors are redirected to login, and a user only ever sees their own merchant's data.
- [ ] **20. Dashboard pages.** Everything listed in section 13.
  *Done when:* from the browser you can refund, replay a webhook, create and revoke a key, and see settlements and reconciliation issues.

### Phase G: Quality and shipping
- [ ] **21. Full test suite.** Everything in section 15, including Playwright.
  *Done when:* `pnpm test` and `pnpm test:e2e` pass locally.
- [ ] **22. CI/CD, full version.** Section 17.
  *Done when:* a pull request runs every job, and merging to main pushes images, migrates Neon and deploys.
- [ ] **23. Deploy.** Section 18. Seed the production demo merchant and try the live flow end to end.
  *Done when:* the live demo store completes a payment and shows "fulfilled".
- [ ] **24. Docs.** README (section 22), `docs/architecture.md`, decision records, and resume bullets using numbers you actually measured (test counts, p95 latency, retry behaviour).
  *Done when:* someone else could run the project locally from the README alone.

---

## 15. Tests

**Unit (Vitest)**
- Fee calculation and rounding; money formatting.
- Payment state machine: every allowed move works and every other move throws.
- Webhook signing: valid signatures pass; a tampered body, a wrong secret and timestamps more than 5 minutes off fail; multiple signatures are accepted.
- Retry schedule values and jitter range.
- Luhn check and every fake bank outcome.
- AES-GCM round trip and tamper rejection.

**Integration (Vitest + Supertest + Testcontainers with real Postgres and Redis)**
- 20 parallel orders with one idempotency key → one order and identical responses.
- Same key with a different body → 422; key still in progress → 409.
- Cross-merchant access → 404.
- Two simultaneous payment attempts on one order → only one proceeds.
- The ledger balances after a random sequence of payments and refunds; an unbalanced insert fails at commit.
- A rolled-back capture → no payment change, no ledger rows, no event.
- Two simultaneous refunds can't over-refund.
- A delivery is retried after a 500 and then succeeds; two sender loops don't double-send.
- `slow@test` resolves through status checks; `lost@test` becomes a reconciliation issue.
- The rate limiter returns 429 after the limit.

**End-to-end (Playwright)**
- Demo store → checkout → `success@test` → demo store shows "fulfilled" → dashboard shows the payment captured and the webhook delivered.
- Card payment with OTP; a failed UPI payment followed by a successful retry.

**Load (k6, optional, on your machine only)**
- 200 virtual users send the same idempotency key → one order; record p95 latency.

---

## 16. Docker

- One multi-stage Dockerfile per deployable app (api, demo-store): install → build → slim runtime, non-root user, `HEALTHCHECK` on `/health`.
- Build from the repo root; use `turbo prune` (Turborepo) or `pnpm deploy` to copy only the app and its dependencies into the image.
- `docker-compose.yml`: `postgres` (17, healthcheck, volume), `redis` (healthcheck), `api`, `web`, `demo-store`, optional `mailpit`; `depends_on` with `condition: service_healthy`.
- A compose profile `e2e` that CI uses for Playwright.

---

## 17. CI/CD (GitHub Actions)

**On every pull request**
1. Install with the pnpm cache → lint → type-check.
2. Unit and integration tests (Testcontainers works on GitHub's Linux runners); upload coverage.
3. `docker compose --profile e2e up --build -d`, then Playwright; upload the report if it fails.
4. Build the images (to prove they build) and scan them with Trivy.

**On merge to main, after the steps above pass**
5. Push images to GHCR, tagged with the commit SHA.
6. Run `prisma migrate deploy` against Neon with `DIRECT_DATABASE_URL`. Render's free tier has no pre-deploy step, so migrations run from CI. Keep migrations backward compatible, because the old version serves traffic until the new one is live.
7. Render deploys the API and demo store with Auto-Deploy set to "After CI Checks Pass". (Alternative: image-backed services deployed by a deploy hook with an `imgURL` parameter.)
8. Vercel deploys `apps/web` from Git (Root Directory `apps/web`), with preview URLs on pull requests.

**Also**
- `cron.yml` from step 17. Scheduled workflows in public repos switch off after 60 days with no activity.
- Branch protection: checks must pass before merging to main.
- Dependabot for npm and GitHub Actions; CodeQL code scanning.
- CI status badge in the README.

---

## 18. Free deployment

| Piece | Service | Notes |
|---|---|---|
| Postgres | Neon free | 0.5 GB and 100 CU-hours per project; sleeps after 5 idle minutes. Pooled URL for the app, direct URL for migrations |
| API + worker | Render free web service | Docker, health check `/health`. Sleeps after 15 idle minutes and takes about a minute to wake. No free background workers, so the worker runs inside the API |
| Demo store | Render free web service | Shares the workspace's 750 free hours a month with the API |
| Web | Vercel Hobby | Personal, non-commercial use |
| Redis | Upstash free | 256 MB, 500,000 commands a month |
| Images | GHCR | Free for public images |
| CI | GitHub Actions | Free on public repos |

---

## 19. Free-tier rules

- Keep the repo public.
- No keep-alive pingers. If Render stays awake all month, the worker keeps Neon awake too and uses up the free CU-hours.
- Run load tests only against Docker on your own machine.
- Every job catches up on overdue work at startup.

---

## 20. Five-day schedule

| Day | Work |
|---|---|
| 1 | Steps 1–12 with Claude Code, one step at a time, reviewing each |
| 2 | Steps 13–24 |
| 3 | Trace (section 21) |
| 4 | Break and fix (section 21) |
| 5 | Explain (sections 21 and 23), then a mock interview |

Create your GitHub, Neon, Render, Vercel and Upstash accounts the night before Day 1. If Day 2 runs over, finish on the morning of Day 3, but no later. If anything has to wait until after Day 5, push step 17 (settlements and reconciliation) first.

---

## 21. Understanding the code

**Day 3: trace**
- Run everything with Docker Compose. Make one payment and follow it through the logs by request ID, then through the code: route → middleware → service → transaction → outbox → worker → demo store.
- Redraw the architecture and the payment flow on paper from memory.
- For every table, write one sentence on why it exists.

**Day 4: break it, watch the tests fail, then fix it**
1. Drop the unique constraint on idempotency keys → the parallel test creates duplicates.
2. Remove `FOR UPDATE` from refunds → the concurrent refund test over-refunds.
3. Send the webhook inside the request instead of through the outbox, then kill the process mid-request → the event is lost.
4. Remove `SKIP LOCKED` and the lease → two loops double-send.
5. Use floats for money → the fee test fails.
6. Verify the signature against re-serialized JSON → valid webhooks fail.
7. Skip the timestamp check → a replayed old webhook is accepted.
8. Insert only one side of a ledger transaction → the trigger blocks the commit.

Then build one small feature yourself, with no AI help: for example a `payment.authorized` event, or a "resend test webhook" button.

**Day 5: explain**
- Write the README's decisions section in your own words.
- Answer every question in section 23 out loud, without notes.

---

## 22. README checklist

- [ ] Live demo link and demo login at the very top.
- [ ] A one-paragraph description in plain words.
- [ ] A short demo GIF or video of buy → pay → "fulfilled".
- [ ] Mermaid architecture diagram and payment sequence diagram.
- [ ] Features, tech stack, and how to run locally (`docker compose up`).
- [ ] Test commands and the CI badge.
- [ ] Links to the API docs (`/docs`) and the Bruno collection.
- [ ] Design decisions and trade-offs.
- [ ] Limitations: what a real gateway does that this doesn't (section 23).
- [ ] How it was built: designed by you, built with Claude Code, reviewed and tested by you.

---

## 23. Interview prep

**Questions to answer without notes**
- Why store money as integer paise?
- How does the idempotency key stop a double charge when two identical requests arrive at the same moment?
- Why write webhooks to an outbox instead of sending them during the request?
- What happens if the server crashes right after capture, before the webhook goes out?
- How do `SKIP LOCKED` and the lease stop two workers sending the same webhook, and what happens if a worker dies mid-send?
- How do you stop two refunds from adding up to more than the payment?
- Why a ledger instead of a single balance column?
- How does a merchant know a webhook came from you and isn't a replay?
- Why are API keys hashed but webhook secrets encrypted?
- What happens when the bank times out, and why isn't that "failed"?
- How does reconciliation catch a payment the bank approved but you never heard about?
- Why never hold a database transaction open during an HTTP call?
- What would you change to handle 100 times the traffic?
- What does a real gateway do that yours doesn't?

**Short answer to "what did you build?"**
> It's a simulation of a payment gateway's core backend. A merchant creates an order through my API, the customer pays on my checkout page, and a simulated bank approves it. My system records it in a double-entry ledger, notifies the merchant with signed webhooks, and settles and reconciles at the end of the day. Real gateways connect to banks, UPI and card networks and need RBI authorisation, merchant KYC, escrow accounts, fraud checks and PCI compliance. I left those out and focused on the software that makes sure money is never charged twice, never lost, and always adds up.

**Real gateway vs this project**
| Area | Real gateway | This project |
|---|---|---|
| Money | Banks, UPI through NPCI, card networks | Fake bank module |
| Licence and rules | RBI authorisation, merchant KYC, escrow accounts | Test mode only |
| Cards | Tokenisation, PCI DSS audits, OTP from the customer's bank | Fake cards and OTP; last four digits only (RBI also limits stored card data to the last four digits and the issuer's name) |
| Settlement | Real bank transfers on a cycle (Razorpay's standard domestic cycle is T+2 working days) | Ledger payouts with a configurable delay |
| Fraud and disputes | Risk checks, chargebacks | None |
| Payment methods | UPI, cards, netbanking, wallets, EMI, pay later | Simulated UPI and card |
| Routing | Sends each payment through the bank route most likely to succeed | One fake bank |
| Scale | Many services, multiple data centres, on-call teams | One API, one database, free tier |

**Scaling answer:** more API instances behind a load balancer; more webhook workers (the lease and `SKIP LOCKED` already allow it); connection pooling; partition big tables by date; read replicas for the dashboard; move events to Kafka once volume needs it.

---

## 24. Stretch goals (after Day 5)

- A merchant SDK on npm: automatic idempotency keys, retries with backoff, a webhook verification helper.
- An embeddable `checkout.js` popup.
- Manual capture (authorize now, capture later) with an automatic void after a timeout.
- Webhook secret rotation with two valid signatures.
- A payouts API and recovery of negative balances.
- A simple fraud rule, for example blocking more than 5 failed attempts per card in 10 minutes.
- Postgres row-level security per merchant.
- Running the rate limiter on your own MiniRedis.
