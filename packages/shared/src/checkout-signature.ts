import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './secrets';

// When checkout sends the customer back to the merchant's callback_url, it adds order_id,
// payment_id, status and this signature (section 9.1, step 9). The merchant checks it with its
// checkout signing secret. Status is not signed, so the redirect is only a hint: the merchant
// re-fetches the payment from the API before fulfilling.

/** HMAC-SHA256 over "{order_id}|{payment_id}", keyed with the checkout signing secret, as hex. */
export function signCheckoutRedirect(orderId: string, paymentId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

/** True if `signature` came from signCheckoutRedirect with this secret. Constant-time compare. */
export function verifyCheckoutRedirect(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string,
): boolean {
  return constantTimeEqual(signCheckoutRedirect(orderId, paymentId, secret), signature);
}
