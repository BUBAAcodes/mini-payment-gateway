import 'server-only';
import { randomUUID } from 'node:crypto';
import { isId, type IdPrefix } from '@gateway/shared';
import type { ActionState } from './action-state';
import type { ApiResult } from './checkout';

// Helpers for the dashboard's Server Actions. An action is a public endpoint: its arguments are
// untrusted whatever their TypeScript types say, so each one checks them before calling the API.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isIdOf(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === 'string' && isId(prefix, value);
}

/** The text of a form field, or '' when it is missing or a file. */
export function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** The Idempotency-Key the page rendered into the form, or null if it was tampered with. */
export function idempotencyKeyOf(formData: FormData): string | null {
  const key = textField(formData, 'idempotency_key');
  return isUuid(key) ? key : null;
}

/** We don't know whether the API did it (it was down, or the first try is still running). */
function outcomeUnknown(result: ApiResult<unknown>): boolean {
  return !result.ok && ['unavailable', 'idempotency_in_progress'].includes(result.error.code);
}

/**
 * The key for the form's next submit. Once the API has answered, it has stored that answer under
 * `used`, so anything new needs a fresh key. If the outcome is unknown, keep `used`: a retry then
 * gets the stored answer instead of doing it twice.
 */
export function nextIdempotencyKey(result: ApiResult<unknown>, used: string): string {
  return outcomeUnknown(result) ? used : randomUUID();
}

export function apiErrorState(result: Extract<ApiResult<unknown>, { ok: false }>): ActionState {
  return { status: 'error', message: result.error.message, field: result.error.field };
}

export const INVALID_REQUEST: ActionState = {
  status: 'error',
  message: 'That request was not valid. Reload the page and try again.',
};
