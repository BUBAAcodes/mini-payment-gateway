'use server';

import { isId, type IdPrefix } from '@gateway/shared';
import { parseExpiry, type ApiResult, type CheckoutPayment } from '@/lib/checkout';
import * as gateway from '@/lib/gateway-api';

// Server Actions for the checkout page. Each is a public endpoint, so the arguments are untrusted
// whatever their TypeScript types say: check them before passing anything on. The client secret
// (cs) is what the API checks; these only forward it.

type PaymentResult = ApiResult<CheckoutPayment>;

const INVALID_LINK: PaymentResult = {
  ok: false,
  error: { code: 'not_found', message: 'This payment link is not valid.' },
};

function isText(value: unknown, maxLength = 200): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isIdOf(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === 'string' && isId(prefix, value);
}

function isClientSecret(cs: unknown): cs is string {
  return isText(cs, 100) && cs.startsWith('cs_');
}

export async function payWithUpi(orderId: unknown, cs: unknown, vpa: unknown) {
  if (!isIdOf('order', orderId) || !isClientSecret(cs) || !isText(vpa)) return INVALID_LINK;
  return gateway.payOrder(orderId, cs, { method: 'upi', vpa });
}

export interface CardDetails {
  number: string;
  /** As typed: MM/YY. */
  expiry: string;
  name: string;
}

/** The card number only passes through here on its way to the API. It is never logged (rule 9). */
export async function payWithCard(orderId: unknown, cs: unknown, card: unknown) {
  if (!isIdOf('order', orderId) || !isClientSecret(cs)) return INVALID_LINK;
  const { number, expiry, name } = (card ?? {}) as Partial<CardDetails>;
  if (!isText(number, 40) || !isText(expiry, 10) || !isText(name)) return INVALID_LINK;

  const parsed = parseExpiry(expiry);
  if (!parsed) {
    return {
      ok: false,
      error: {
        code: 'validation_error',
        message: 'Enter the expiry as MM/YY.',
        field: 'card.expiry',
      },
    } satisfies PaymentResult;
  }
  return gateway.payOrder(orderId, cs, {
    method: 'card',
    card: { number, expiry_month: parsed.month, expiry_year: parsed.year, name },
  });
}

export async function submitOtpCode(paymentId: unknown, cs: unknown, otp: unknown) {
  if (!isIdOf('pay', paymentId) || !isClientSecret(cs) || !isText(otp, 12)) return INVALID_LINK;
  return gateway.submitOtp(paymentId, cs, otp);
}

/** Polled by the processing screen while the bank decides. */
export async function refreshPayment(paymentId: unknown, cs: unknown) {
  if (!isIdOf('pay', paymentId) || !isClientSecret(cs)) return INVALID_LINK;
  return gateway.getCheckoutPayment(paymentId, cs);
}
