'use server';

import { refresh } from 'next/cache';
import type { KeyedState } from '@/lib/action-state';
import {
  INVALID_REQUEST,
  apiErrorState,
  idempotencyKeyOf,
  isIdOf,
  nextIdempotencyKey,
} from '@/lib/dashboard-actions';
import { redeliverEvent } from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

/**
 * Queues the event again for every live endpoint that got it. The delivery has the same
 * webhook-id, so a receiver that already handled it skips it. The form's key stops a double click
 * queueing it twice.
 */
export async function replayEvent(
  eventId: unknown,
  prev: KeyedState,
  formData: FormData,
): Promise<KeyedState> {
  const { merchantId } = await requireMerchant();
  const key = idempotencyKeyOf(formData);
  if (!isIdOf('evt', eventId) || !key)
    return { ...INVALID_REQUEST, idempotencyKey: prev.idempotencyKey };

  const result = await redeliverEvent(merchantId, eventId, key);
  const idempotencyKey = nextIdempotencyKey(result, key);
  if (!result.ok) return { ...apiErrorState(result), idempotencyKey };
  refresh();
  const count = result.data.data.length;
  return {
    status: 'done',
    message:
      count === 0
        ? 'No live endpoint to send it to.'
        : `Queued ${count === 1 ? '1 delivery' : `${count} deliveries`}.`,
    idempotencyKey,
  };
}
