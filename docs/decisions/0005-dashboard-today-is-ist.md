# 0005: The dashboard's "today" is the day in India, counted by when payments were created

**Status:** accepted (step 20)

## Context

The dashboard overview shows today's volume and success rate (spec section 13). Two questions:

1. Which "today"? Servers run in UTC (Render, Docker), browsers anywhere. Midnight UTC is 05:30 in India.
2. Which timestamp puts a payment in a day? A payment has `created_at` and `captured_at`, but a failed one has no `failed_at`.

## Decision

- **Today is the calendar day in India (IST, UTC+5:30).** `istDayBounds()` in `packages/shared` gives its start and end as UTC instants. The API works it out, so it doesn't depend on the server's timezone.
- **Every number counts the payment attempts created that day.** `GET /dashboard/overview` runs one grouped query on `(merchant_id, created_at)`:
  - **volume:** the amount of today's attempts that were captured, including ones refunded since.
  - **captured_count:** those attempts.
  - **failed_count:** today's attempts that failed.
  - **success_rate:** captured ÷ (captured + failed), or `null` when none has finished.
- In-progress attempts (`created`, `otp_required`, `pending`, `authorized`) are in neither count, so a burst of attempts waiting on the bank doesn't drag the rate down.

## Why

- The gateway is INR only, and the merchants and the daily cron (02:00 IST) live by the Indian day. A UTC day would split an Indian shop's evening across two "days".
- One timestamp for every number keeps them consistent: `captured_count + failed_count` is the attempts that finished out of those started today. Mixing `captured_at` for successes with some other time for failures would compare different groups of payments.
- `created_at` is already indexed with `merchant_id`, so the overview is one index range scan.

## Consequences

- A payment started at 23:59 IST and captured at 00:01 counts in the day it started.
- Volume is gross: refunds don't lower it. The balance card shows what is actually owed.
- India has no daylight saving, so a fixed offset is exact. Supporting other countries would need a merchant timezone and real timezone rules.
