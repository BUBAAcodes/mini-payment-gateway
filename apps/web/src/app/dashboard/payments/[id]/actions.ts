'use server';

import { refresh } from 'next/cache';
import { formatINR, parseRupees } from '@gateway/shared';
import {
  INVALID_REQUEST,
  idempotencyKeyOf,
  isIdOf,
  nextIdempotencyKey,
  textField,
} from '@/lib/dashboard-actions';
import type { KeyedState } from '@/lib/action-state';
import { createRefund } from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

/**
 * Refunds a payment, in full when the amount is empty. The form carries an Idempotency-Key that
 * the page made, so submitting the same form twice refunds once (rule 2); the API's row lock
 * stops two different refunds adding up to more than was paid (rule 6).
 */
export async function refundPayment(
  paymentId: unknown,
  prev: KeyedState,
  formData: FormData,
): Promise<KeyedState> {
  const { merchantId } = await requireMerchant();
  const key = idempotencyKeyOf(formData);
  if (!isIdOf('pay', paymentId) || !key)
    return { ...INVALID_REQUEST, idempotencyKey: prev.idempotencyKey };

  const typed = textField(formData, 'amount');
  const amount = typed === '' ? undefined : parseRupees(typed);
  if (amount === null) {
    return {
      status: 'error',
      field: 'amount',
      message:
        'Enter an amount in rupees, like 200 or 12.50, or leave it empty to refund the rest.',
      idempotencyKey: key,
    };
  }

  const result = await createRefund(
    merchantId,
    paymentId,
    amount === undefined ? {} : { amount },
    key,
  );
  const idempotencyKey = nextIdempotencyKey(result, key);
  if (!result.ok) {
    return {
      status: 'error',
      message: result.error.message,
      field: result.error.field,
      idempotencyKey,
    };
  }

  refresh();
  const refund = result.data;
  const money = formatINR(refund.amount);
  if (refund.status === 'failed') {
    return {
      status: 'error',
      message: `The bank refused the refund of ${money} (${refund.failure_reason ?? 'no reason given'}). Nothing was returned.`,
      idempotencyKey,
    };
  }
  return {
    status: 'done',
    message:
      refund.status === 'processed'
        ? `Refunded ${money}.`
        : `The refund of ${money} is with the bank. Check back in a minute.`,
    idempotencyKey,
  };
}
