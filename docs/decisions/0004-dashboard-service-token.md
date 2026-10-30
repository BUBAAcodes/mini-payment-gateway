# 0004: The dashboard calls the API with a service token and the session's merchant ID

**Status:** accepted (step 19)

## Context

The dashboard (Next.js) needs the same data the merchant API serves: payments, refunds, webhooks, balance, settlements. On top of that it needs things merchants' servers don't get: API keys and reconciliation issues. The rules:

- The browser never calls the API directly; only Next.js server code does (section 12).
- A logged-in user must only ever see their own merchant's data.

Three ways to authenticate the Next.js server to the API:

1. Use one of the merchant's API keys. We only store their hashes, so we can't use one on the merchant's behalf. Creating a hidden key per merchant would mean storing a key we can use, and it would appear in, and count against, the merchant's own keys.
2. Forward the Better Auth session to the API and have the API check it in the database. The API would then depend on Better Auth's tables and cookie format.
3. A shared secret between our two servers, plus the merchant ID in a header.

## Decision

Option 3. The web server calls `/dashboard/*` with `Authorization: Bearer DASHBOARD_SERVICE_TOKEN` and `X-Merchant-Id`.

- **The API side.** `requireDashboardService` checks the token in constant time, checks the merchant ID's format and that the merchant exists, and sets the same `res.locals.merchantId` the API key middleware sets. Every failure is the same 401.
- **The web side.** The merchant ID comes only from `requireMerchant()`, which reads the Better Auth session and its `users.merchant_id`. It never comes from a URL, a form field or anything else the browser sends. Better Auth can't set `merchant_id` from input (`input: false`).
- **Shared code.** The dashboard router mounts the merchant API's own routers (payments, refunds, webhooks, events, settlements, balance). Every merchant-scoped query is the same code for both, so another merchant's ID still gives a 404.

## Consequences

- **The token is powerful.** Whoever holds it can act as any merchant. Only the API and web servers have it, it is 32+ characters, and it travels only between those two servers. Rotating it means changing both at once.
- **Correctness depends on one function.** If web code passed a merchant ID from the request instead of from `requireMerchant()`, the API couldn't tell. Keep all dashboard API calls behind `requireMerchant()`.
- **No rate limit on `/dashboard`.** The limiter counts per API key, and these calls come from our own server.
- **Not in the public docs.** `/docs` documents the API merchants use. The dashboard API is private to our web server.
- **`proxy.ts` is only a fast first check.** It looks for a session cookie and doesn't touch the database. The real check is `requireMerchant()` on every page, so a stale or forged cookie gets nothing.
