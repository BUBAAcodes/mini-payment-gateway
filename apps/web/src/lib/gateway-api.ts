import 'server-only';
import type { PayOrderInput } from '@gateway/shared';
import { apiUrl, callApi } from './api-client';
import type { ApiResult, CheckoutOrder, CheckoutPayment } from './checkout';

// The checkout API (section 8), called only from Next.js server code. The order's client secret
// (cs) is what authorizes each call.

// A pay or OTP request waits for the bank for up to BANK_TIMEOUT_MS (10 s), so wait longer.
const REQUEST_TIMEOUT_MS = 15_000;

function callCheckoutApi<T>(path: string, cs: string, body?: unknown): Promise<ApiResult<T>> {
  const url = apiUrl(path);
  url.searchParams.set('cs', cs);
  return callApi<T>({
    method: body === undefined ? 'GET' : 'POST',
    url,
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    unavailableMessage:
      'We could not reach the payment service. Refresh the page to check the payment.',
  });
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
