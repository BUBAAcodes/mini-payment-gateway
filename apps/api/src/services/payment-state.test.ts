import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '@gateway/db';
import { InvalidStateError } from '@gateway/shared';
import { transition } from './payment-state';

type Move = [from: PaymentStatus, to: PaymentStatus];

// Spec section 9.2, written out again here so that changing the table means changing this test.
const ALLOWED: Move[] = [
  ['created', 'otp_required'],
  ['created', 'pending'],
  ['otp_required', 'pending'],
  ['pending', 'authorized'],
  ['pending', 'failed'],
  ['authorized', 'captured'],
  ['captured', 'refunded'],
];

const STATUSES = Object.values(PaymentStatus);
const isAllowed = (from: PaymentStatus, to: PaymentStatus) =>
  ALLOWED.some(([f, t]) => f === from && t === to);
const ILLEGAL: Move[] = STATUSES.flatMap((from) =>
  STATUSES.filter((to) => !isAllowed(from, to)).map((to): Move => [from, to]),
);

describe('transition', () => {
  it.each(ALLOWED)('allows %s → %s', (from, to) => {
    expect(transition({ id: 'pay_test', status: from }, to)).toBe(to);
  });

  it.each(ILLEGAL)('refuses %s → %s', (from, to) => {
    expect(() => transition({ id: 'pay_test', status: from }, to)).toThrow(InvalidStateError);
  });

  it('checks every pair of statuses: 7 allowed, the other 42 refused', () => {
    expect(STATUSES).toHaveLength(7);
    expect(ILLEGAL).toHaveLength(42);
  });

  it('names the payment and both statuses in the error', () => {
    expect(() => transition({ id: 'pay_test', status: 'failed' }, 'captured')).toThrow(
      'Payment pay_test cannot move from failed to captured',
    );
  });
});
