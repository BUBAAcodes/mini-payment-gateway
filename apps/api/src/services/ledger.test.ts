import { describe, expect, it } from 'vitest';
import { checkBalanced, type LedgerEntryInput } from './ledger';

const MERCHANT = 'merchant_balance:mer_test';

// The three examples from spec section 9.4, in paise.
const CAPTURE: LedgerEntryInput[] = [
  { account: 'gateway_clearing', direction: 'debit', amount: 50_000 },
  { account: MERCHANT, direction: 'credit', amount: 49_000 },
  { account: 'fee_revenue', direction: 'credit', amount: 1_000 },
];
const REFUND: LedgerEntryInput[] = [
  { account: MERCHANT, direction: 'debit', amount: 20_000 },
  { account: 'gateway_clearing', direction: 'credit', amount: 20_000 },
];
const PAYOUT: LedgerEntryInput[] = [
  { account: MERCHANT, direction: 'debit', amount: 29_000 },
  { account: 'payouts', direction: 'credit', amount: 29_000 },
];

describe('checkBalanced', () => {
  it.each([
    ['capture', CAPTURE],
    ['refund', REFUND],
    ['payout', PAYOUT],
  ])('accepts the section 9.4 %s', (_, entries) => {
    expect(() => checkBalanced(entries)).not.toThrow();
  });

  it('refuses a transaction with no entries', () => {
    expect(() => checkBalanced([])).toThrow('A ledger transaction needs at least one entry');
  });

  it('refuses a one-sided transaction', () => {
    expect(() => checkBalanced([CAPTURE[0]!])).toThrow(
      'Ledger entries do not balance: debits 50000, credits 0',
    );
  });

  it('refuses totals that are off by a single paisa', () => {
    const offByOne = [CAPTURE[0]!, { ...CAPTURE[1]!, amount: 48_999 }, CAPTURE[2]!];
    expect(() => checkBalanced(offByOne)).toThrow(
      'Ledger entries do not balance: debits 50000, credits 49999',
    );
  });

  // Each pair balances, so the amount itself is the only thing wrong.
  it.each([0, -1_000, 49_000.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an entry of %s paise',
    (amount) => {
      const entries: LedgerEntryInput[] = [
        { account: 'gateway_clearing', direction: 'debit', amount },
        { account: MERCHANT, direction: 'credit', amount },
      ];
      expect(() => checkBalanced(entries)).toThrow(/must be a positive whole number of paise/);
    },
  );
});
