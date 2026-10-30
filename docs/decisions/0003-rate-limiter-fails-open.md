# 0003: The rate limiter fails open, with a counter per minute

**Status:** accepted (step 18)

## Context

Each API key may make `RATE_LIMIT_PER_MINUTE` requests a minute (100 by default); request 101 gets `429` with `Retry-After`. The counts live in Redis: Upstash when deployed, where the free tier is a shared service we don't control, and later possibly your own MiniRedis.

Two questions:

1. What happens to a merchant's request when Redis is down or slow?
2. How do we count with only `INCR` and `EXPIRE`, so a lost `EXPIRE` can't lock a key out?

## Decision

**Fail open.** If counting fails (Redis unreachable, or no answer within 500 ms), the request goes through uncounted and we log a warning. The client never queues commands while disconnected, so a dead Redis costs a failed command, not a wait.

**A counter per key per minute.** The counter is `rl:{apiKeyId}:{minute number}`. Each request runs `INCR`; the first one in a minute also sets `EXPIRE` 60. `Retry-After` is the seconds left in that minute.

## Why

- **Fail open:**
  - The limiter protects us from a runaway client. It isn't what keeps money correct: idempotency keys, row locks and the ledger do that. Turning a Redis outage into a payments outage would trade a small risk for a certain one.
  - Fail closed (503 while Redis is down) would make Upstash's availability a ceiling on ours, and a free tier gives no guarantees.
- **A counter per minute:**
  - The obvious design, one counter per key with `EXPIRE` set on the first hit, has a trap. If the process dies between `INCR` and `EXPIRE`, the counter never expires; once it passes the limit, that key is rate limited forever.
  - With the minute in the key name, the next minute uses a new key whatever happened to the old one, so nobody is ever locked out. A lost `EXPIRE` only leaves one small key behind.
  - A busy key costs one command per request (`EXPIRE` only on the first), which matters on Upstash's free tier of 500,000 commands a month.
  - It needs nothing but `INCR` and `EXPIRE`, so MiniRedis can serve it.

## Consequences

- **During a Redis outage there is no rate limit.** The warning in the logs is the signal. Something like a circuit breaker could fail closed after a long outage, if that ever matters.
- **Fixed windows allow bursts at the edges.** A client can send 100 requests at 12:00:59 and 100 more at 12:01:00, so 200 within two seconds. A sliding window would prevent that, at the cost of more Redis commands. For protecting a test-mode API, fixed windows are enough, and they are what the spec asks for.
- **Only the merchant API is limited.** It's the only part with an API key to count by. Checkout is called by our own Next.js server, and the internal routes only by the cron.
