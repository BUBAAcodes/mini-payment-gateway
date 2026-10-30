import 'server-only';
import { randomUUID } from 'node:crypto';
import { connection } from 'next/server';
import type { ApiError, ApiResult } from './checkout';

// The one way this app's server code calls the API. The browser never talks to the API, so the
// API's CORS stays closed (section 12). `server-only` makes importing this file from a Client
// Component a build error.

const UNAVAILABLE_MESSAGE = 'We could not reach the payment service. Try again in a moment.';

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Path and query on the API, e.g. /checkout/orders/order_x?cs=… */
  url: URL;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** What to tell the user when the API can't be reached. */
  unavailableMessage?: string;
}

/** Where the API lives. Read per call, so tests can change it. */
export function apiUrl(path: string): URL {
  return new URL(path, process.env.API_BASE_URL || 'http://localhost:4000');
}

/**
 * Calls the API and returns its JSON, or its error. A network failure or a timeout comes back as
 * `unavailable`, never as a throw, so pages can show a message instead of crashing.
 */
export async function callApi<T>({
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs,
  unavailableMessage = UNAVAILABLE_MESSAGE,
}: ApiRequest): Promise<ApiResult<T>> {
  const unavailable: ApiError = { code: 'unavailable', message: unavailableMessage };

  // API data is always per request. This stops Cache Components prerendering here, before the
  // random request ID below (which would otherwise be flagged as an unstable value).
  await connection();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-request-id': randomUUID(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, error: unavailable };
  }

  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: json as T };
  const error = (json as { error?: ApiError } | null)?.error;
  return { ok: false, error: error?.code ? error : unavailable };
}
