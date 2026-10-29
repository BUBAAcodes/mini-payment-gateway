import type { BankOutcome } from '@gateway/db';
import type { AuthorizeRequest } from './bank-client';

// The fake bank's test inputs (spec section 10). Anything not listed here is declined, so the
// inputs printed on the checkout page are the complete set.

export const CORRECT_OTP = '123456';

export interface Decision {
  outcome: Exclude<BankOutcome, 'pending'>;
  declineReason: string | null;
  /** normal: about a second. slow: BANK_SLOW_MS, longer than the gateway waits. */
  delay: 'normal' | 'slow';
  /** False for lost@test: the bank approves but never tells the gateway. */
  tellsGateway: boolean;
}

const APPROVE: Decision = {
  outcome: 'approved',
  declineReason: null,
  delay: 'normal',
  tellsGateway: true,
};

function decline(declineReason: string): Decision {
  return { outcome: 'declined', declineReason, delay: 'normal', tellsGateway: true };
}

const UPI_SCENARIOS: Record<string, Decision> = {
  'success@test': APPROVE,
  'fail@test': decline('insufficient_funds'),
  'slow@test': { ...APPROVE, delay: 'slow' },
  'lost@test': { ...APPROVE, tellsGateway: false },
};

export function decideAuthorization(request: AuthorizeRequest): Decision {
  if (request.method === 'upi') {
    return UPI_SCENARIOS[request.vpa.trim().toLowerCase()] ?? decline('invalid_vpa');
  }
  // Like a real issuer, the OTP is checked before the card itself.
  if (request.otp !== CORRECT_OTP) return decline('otp_invalid');
  return request.cardLast4 === '1111' ? APPROVE : decline('card_declined');
}

/** Refunds succeed unless the order's notes contain "fail_refund": true. */
export function decideRefund({ failRefund }: { failRefund: boolean }): Decision {
  return failRefund ? decline('refund_declined') : APPROVE;
}
