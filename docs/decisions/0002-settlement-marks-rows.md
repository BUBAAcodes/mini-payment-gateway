# 0002: Settlements stamp the rows they pay out

**Status:** accepted (step 17)

## Context

Once a day, settlement pays each merchant what we owe it: its captures, minus our fees, minus its processed refunds (spec §9.7). The spec says to take everything "since the last settlement", which suggests a time window: from where the last settlement ended up to now.

A time window has a gap. A capture sets `captured_at` inside its transaction, a moment before it commits. Suppose a capture sets `captured_at = 02:00:00.000` and commits 50 ms later. If a settlement run reads the payments at 02:00:00.020 and ends its window at 02:00:00.030, it doesn't see the capture, because it isn't committed yet. The next window starts at 02:00:00.030, after the capture's `captured_at`. Nothing would ever pay the merchant for that capture.

## Decision

`payments` and `refunds` get a nullable `settlement_id`. A settlement, in one transaction:

1. locks the merchant row, so two runs for the same merchant take turns;
2. locks (`FOR UPDATE`) every captured or refunded payment and every processed refund with no `settlement_id` that is older than `SETTLEMENT_DELAY_DAYS`;
3. if the net is positive: inserts the settlement, stamps those rows with its ID, posts the ledger payout for the net and records `settlement.processed`.

`period_start` and `period_end` are kept for people to read. What a settlement covers is decided by the stamps.

## Why

- A capture that commits late has no stamp, so the next settlement picks it up. No row can be missed, whatever the timing.
- A stamped row is never picked up again, so no row is paid twice, even when the cron retries or two runs overlap.
- You can ask "which settlement paid this payment?" and get an answer from the row itself.

## Consequences

- **A negative net is carried forward.** If refunds outweigh captures (decision 0001 lets a balance go negative), the run writes nothing and stamps nothing. Those refunds wait for a later settlement and come out of the merchant's next captures.
- **Settlement net equals what the ledger says we owe.** Every capture, refund and payout is in the ledger, and every stamped row was paid out exactly once. So after a settlement with no delay, the merchant's balance is 0. The tests check this.
- **Settlements briefly lock captured payments**, which refunds lock too, so a refund may wait a moment. It can't deadlock: a refund locks its payment before anything else, so while it waits it holds nothing the settlement needs.
- **One migration:** the two columns and their indexes.
