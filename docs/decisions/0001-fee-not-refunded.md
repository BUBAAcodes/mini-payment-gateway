# 0001: The fee is not returned on refunds

**Status:** accepted (step 16)

## Context

When a payment is captured, we keep a fee (`FEE_BPS`, 2% by default) and owe the merchant the rest. A ₹500 capture records:

| Debit                     | Credit                                            |
| ------------------------- | ------------------------------------------------- |
| `gateway_clearing` 50,000 | `merchant_balance` 49,000 and `fee_revenue` 1,000 |

Later the merchant may refund some or all of that ₹500 to the customer. We need to decide who pays for the fee on the refunded part.

## Decision

The customer gets back exactly the refunded amount. The merchant pays for all of it, and we keep the whole fee. A refund of ₹200 records:

| Debit                     | Credit                    |
| ------------------------- | ------------------------- |
| `merchant_balance` 20,000 | `gateway_clearing` 20,000 |

Nothing touches `fee_revenue`.

## Why

- The work the fee pays for was done: we ran the checkout, talked to the bank and captured the money. A refund is extra work, not an undo.
- Major gateways do the same: the original transaction fee is not given back on a refund.
- Each refund is one two-line ledger transaction with no fee arithmetic, so partial refunds never leave rounding leftovers in `fee_revenue`.

## Consequences

- A fully refunded payment leaves the merchant owing us its fee. After a ₹500 capture and a ₹500 refund, the merchant's balance is −₹10. We allow negative balances (spec §9.5): settlement skips merchants whose net is zero or negative, so the debt is recovered from later captures. The dashboard should show it.
- A merchant's refunded total can be more than what we owe it for that payment. That is expected, and why `merchant_balance` can't be a database column with a `>= 0` check.
- If we ever wanted to return the fee pro rata, refunds would also debit `fee_revenue`, and we would need a rounding rule for partial refunds. That would be a new decision.
