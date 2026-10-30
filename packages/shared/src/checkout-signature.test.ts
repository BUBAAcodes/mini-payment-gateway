import { describe, expect, it } from 'vitest';
import { signCheckoutRedirect, verifyCheckoutRedirect } from './checkout-signature';

const ORDER_ID = 'order_8fK2mQx9LpZ3aB';
const PAYMENT_ID = 'pay_29QQoc7LqYzBn8';
const SECRET = 'test_checkout_secret';
// printf '%s' 'order_8fK2mQx9LpZ3aB|pay_29QQoc7LqYzBn8' | openssl dgst -sha256 -hmac 'test_checkout_secret'
const EXPECTED = 'a3eaa7f5e784240b71454541a8bfcda516ef9addab5c74b9bf10bb53cce6e6f7';

describe('signCheckoutRedirect', () => {
  it('is HMAC-SHA256 hex over "{order_id}|{payment_id}"', () => {
    expect(signCheckoutRedirect(ORDER_ID, PAYMENT_ID, SECRET)).toBe(EXPECTED);
  });
});

describe('verifyCheckoutRedirect', () => {
  it('accepts the signature for the same order, payment and secret', () => {
    expect(verifyCheckoutRedirect(ORDER_ID, PAYMENT_ID, EXPECTED, SECRET)).toBe(true);
  });

  it('rejects a signature moved to another order or payment', () => {
    expect(verifyCheckoutRedirect('order_otherOrder0000', PAYMENT_ID, EXPECTED, SECRET)).toBe(
      false,
    );
    expect(verifyCheckoutRedirect(ORDER_ID, 'pay_otherPayment00', EXPECTED, SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyCheckoutRedirect(ORDER_ID, PAYMENT_ID, EXPECTED, 'another_secret')).toBe(false);
  });

  it('rejects truncated, padded and non-hex signatures without throwing', () => {
    for (const signature of [EXPECTED.slice(0, -2), `${EXPECTED}00`, 'z'.repeat(64), '']) {
      expect(verifyCheckoutRedirect(ORDER_ID, PAYMENT_ID, signature, SECRET)).toBe(false);
    }
  });
});
