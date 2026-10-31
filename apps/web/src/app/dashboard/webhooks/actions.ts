'use server';

import { refresh } from 'next/cache';
import { WEBHOOK_EVENT_TYPES, createWebhookEndpointSchema } from '@gateway/shared';
import type { ActionState, KeyedState, SecretState } from '@/lib/action-state';
import {
  INVALID_REQUEST,
  apiErrorState,
  idempotencyKeyOf,
  isIdOf,
  nextIdempotencyKey,
  textField,
} from '@/lib/dashboard-actions';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  testWebhookEndpoint,
} from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

const KNOWN_TYPES: readonly string[] = WEBHOOK_EVENT_TYPES;

/**
 * Adds a webhook endpoint. Its signing secret is in this answer only; the API keeps it encrypted.
 * The form's Idempotency-Key means a double submit gets the same endpoint and secret back.
 */
export async function createEndpoint(
  prev: KeyedState & SecretState,
  formData: FormData,
): Promise<KeyedState & SecretState> {
  const { merchantId } = await requireMerchant();
  const key = idempotencyKeyOf(formData);
  if (!key) return { ...INVALID_REQUEST, idempotencyKey: prev.idempotencyKey };

  const picked = formData.getAll('event_types').filter((t): t is string => typeof t === 'string');
  const allEvents = formData.get('all_events') !== null;
  if (!allEvents && picked.length === 0) {
    return {
      status: 'error',
      field: 'event_types',
      message: 'Pick at least one event type.',
      idempotencyKey: key,
    };
  }
  if (!allEvents && picked.some((type) => !KNOWN_TYPES.includes(type))) {
    return {
      status: 'error',
      field: 'event_types',
      message: 'Unknown event type.',
      idempotencyKey: key,
    };
  }

  const parsed = createWebhookEndpointSchema.safeParse({
    url: textField(formData, 'url'),
    event_types: allEvents ? ['*'] : picked,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 'error',
      field: String(issue?.path[0] ?? 'url'),
      message: issue?.message ?? 'Check the URL and event types.',
      idempotencyKey: key,
    };
  }

  const result = await createWebhookEndpoint(merchantId, parsed.data, key);
  const idempotencyKey = nextIdempotencyKey(result, key);
  if (!result.ok) return { ...apiErrorState(result), idempotencyKey };
  refresh();
  return {
    status: 'done',
    secret: result.data.secret,
    message: `Added ${result.data.url}`,
    idempotencyKey,
  };
}

export async function deleteEndpoint(endpointId: unknown): Promise<ActionState> {
  const { merchantId } = await requireMerchant();
  if (!isIdOf('we', endpointId)) return INVALID_REQUEST;
  const result = await deleteWebhookEndpoint(merchantId, endpointId);
  if (!result.ok) return apiErrorState(result);
  refresh();
  return { status: 'done', message: 'Deleted.' };
}

/** Sends a `ping` event now and says how the endpoint answered. A failed ping is retried later. */
export async function sendTestEvent(endpointId: unknown): Promise<ActionState> {
  const { merchantId } = await requireMerchant();
  if (!isIdOf('we', endpointId)) return INVALID_REQUEST;
  const result = await testWebhookEndpoint(merchantId, endpointId);
  if (!result.ok) return apiErrorState(result);
  refresh();
  const delivery = result.data;
  if (delivery.status === 'succeeded') {
    return {
      status: 'done',
      message: `Delivered: HTTP ${delivery.last_response_status} in ${delivery.last_response_ms} ms.`,
    };
  }
  const answer = delivery.last_response_status
    ? `HTTP ${delivery.last_response_status}`
    : (delivery.last_error ?? 'no answer');
  return { status: 'error', message: `Not delivered (${answer}). We will retry it.` };
}
