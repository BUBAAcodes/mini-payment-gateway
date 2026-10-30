import 'server-only';
import { randomUUID } from 'node:crypto';
import { connection } from 'next/server';
import type { PayOrderInput } from '@gateway/shared';
import type { ApiError, ApiResult, CheckoutOrder, CheckoutPayment } from './checkout';

// The checkout API (section 8), called only from Next.js server code. The browser never talks to
// the API, so the API's CORS stays closed (section 12). `server-only` makes importing this file
// from a Client Component a build error.

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';

// A pay or OTP request waits for the bank for up to BANK_TIMEOUT_MS (10 s), so wait longer.
const REQUEST_TIMEOUT_MS = 15_000;

const UNAVAILABLE: ApiError = {
  code: 'unavailable',
  message: 'We could not reach the payment service. Refresh the page to check the payment.',
};

async function callCheckoutApi<T>(path: string, cs: string, body?: unknown): Promise<ApiResult<T>> {
  // Checkout data is always per request. This stops Cache Components prerendering here, before the
  // random request ID below (which would otherwise be flagged as an unstable value).
  await connection();
  const url = new URL(path, API_BASE_URL);
  url.searchParams.set('cs', cs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: UNAVAILABLE };
  }

  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: json as T };
  const error = (json as { error?: ApiError } | null)?.error;
  return { ok: false, error: error?.code ? error : UNAVAILABLE };
}

const segment = encodeURIComponent;

export function getCheckoutOrder(orderId: string, cs: string) {
  return callCheckoutApi<CheckoutOrder>(`/checkout/orders/${segment(orderId)}`, cs);
}

export function getCheckoutPayment(paymentId: string, cs: string) {
  return callCheckoutApi<CheckoutPayment>(`/checkout/payments/${segment(paymentId)}`, cs);
}

/** Starts a payment attempt. The body may hold a full card number: never log it (rule 9). */
export function payOrder(orderId: string, cs: string, input: PayOrderInput) {
  return callCheckoutApi<CheckoutPayment>(`/checkout/orders/${segment(orderId)}/pay`, cs, input);
}

export function submitOtp(paymentId: string, cs: string, otp: string) {
  return callCheckoutApi<CheckoutPayment>(`/checkout/payments/${segment(paymentId)}/otp`, cs, {
    otp,
  });
}
