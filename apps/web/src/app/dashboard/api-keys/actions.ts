'use server';

import { refresh } from 'next/cache';
import type { ActionState, SecretState } from '@/lib/action-state';
import { INVALID_REQUEST, apiErrorState, isIdOf } from '@/lib/dashboard-actions';
import { createApiKey, revokeApiKey } from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

/**
 * Makes a new API key. The full key lives only in this answer: the API stores its hash, and the
 * page shows it once. No Idempotency-Key, on purpose: a repeat makes a second key, which is
 * harmless and shows up in the list to revoke.
 */
export async function createKey(): Promise<SecretState> {
  const { merchantId } = await requireMerchant();
  const result = await createApiKey(merchantId);
  if (!result.ok) return apiErrorState(result);
  refresh();
  return { status: 'done', secret: result.data.key, message: `Created ${result.data.prefix}…` };
}

export async function revokeKey(keyId: unknown): Promise<ActionState> {
  const { merchantId } = await requireMerchant();
  if (!isIdOf('key', keyId)) return INVALID_REQUEST;
  const result = await revokeApiKey(merchantId, keyId);
  if (!result.ok) return apiErrorState(result);
  refresh();
  return { status: 'done', message: 'Revoked. Requests with this key now get 401.' };
}
