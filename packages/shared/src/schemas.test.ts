import { describe, expect, it } from 'vitest';
import {
  amountSchema,
  createOrderSchema,
  createWebhookEndpointSchema,
  currencySchema,
  idSchema,
  paginationSchema,
  payOrderSchema,
  redeliverEventSchema,
  submitOtpSchema,
} from './schemas';
import { newId } from './ids';

describe('amountSchema', () => {
  it('accepts integer paise in range', () => {
    expect(amountSchema.parse(50_000)).toBe(50_000);
  });

  it('rejects out-of-range, float and string amounts', () => {
    for (const bad of [99, 50_000_001, 100.5, '50000']) {
      expect(amountSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('currencySchema', () => {
  it('accepts only INR', () => {
    expect(currencySchema.parse('INR')).toBe('INR');
    expect(currencySchema.safeParse('USD').success).toBe(false);
  });
});

describe('idSchema', () => {
  it('accepts IDs with the given prefix only', () => {
    const schema = idSchema('pay');
    expect(schema.safeParse(newId('pay')).success).toBe(true);
    expect(schema.safeParse(newId('order')).success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('defaults limit to 20', () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 20 });
  });

  it('coerces limit from a query string', () => {
    expect(paginationSchema.parse({ limit: '50', starting_after: 'pay_x' })).toEqual({
      limit: 50,
      starting_after: 'pay_x',
    });
  });

  it('rejects limits outside 1–100', () => {
    for (const bad of ['0', '101', '2.5']) {
      expect(paginationSchema.safeParse({ limit: bad }).success).toBe(false);
    }
  });
});

describe('createOrderSchema', () => {
  const valid = {
    amount: 50_000,
    currency: 'INR',
    receipt: 'rcpt_1001',
    callback_url: 'https://demo-store.example/payments/callback',
    notes: { sku: 'tshirt-m', qty: 1, gift: false },
  };

  it('accepts a full order body', () => {
    expect(createOrderSchema.parse(valid)).toEqual(valid);
  });

  it('needs only an amount, and defaults currency to INR', () => {
    expect(createOrderSchema.parse({ amount: 100 })).toEqual({ amount: 100, currency: 'INR' });
    expect(createOrderSchema.parse({ amount: 50_000_000 }).amount).toBe(50_000_000);
  });

  it.each([
    ['amount below ₹1', { amount: 99 }, 'amount'],
    ['amount above ₹5,00,000', { amount: 50_000_001 }, 'amount'],
    ['fractional paise', { amount: 100.5 }, 'amount'],
    ['amount as a string', { amount: '500' }, 'amount'],
    ['a missing amount', {}, 'amount'],
    ['a currency other than INR', { amount: 100, currency: 'USD' }, 'currency'],
    ['a receipt over 40 characters', { amount: 100, receipt: 'r'.repeat(41) }, 'receipt'],
    [
      'a non-http callback URL',
      { amount: 100, callback_url: 'ftp://x.example/cb' },
      'callback_url',
    ],
    ['a callback that is not a URL', { amount: 100, callback_url: 'not a url' }, 'callback_url'],
    ['a nested note value', { amount: 100, notes: { a: { b: 1 } } }, 'notes.a'],
    ['a note value over 256 characters', { amount: 100, notes: { a: 'x'.repeat(257) } }, 'notes.a'],
    [
      'more than 15 note keys',
      { amount: 100, notes: Object.fromEntries([...Array(16).keys()].map((i) => [`k${i}`, i])) },
      'notes',
    ],
    ['an unknown field', { amount: 100, callbackUrl: 'https://x.example' }, ''],
  ])('rejects %s', (_name, body, field) => {
    const result = createOrderSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.join('.')).toBe(field);
  });
});

describe('payOrderSchema', () => {
  const now = new Date();
  const card = {
    number: '4111 1111 1111 1111',
    expiry_month: 12,
    expiry_year: now.getUTCFullYear() + 1,
    name: 'Test Customer',
  };

  it('accepts a UPI payment', () => {
    expect(payOrderSchema.parse({ method: 'upi', vpa: ' success@test ' })).toEqual({
      method: 'upi',
      vpa: 'success@test',
    });
  });

  it('rejects a VPA that is not name@handle', () => {
    for (const vpa of ['', 'success', '@test', 'success@', 'a b@test']) {
      expect(payOrderSchema.safeParse({ method: 'upi', vpa }).success).toBe(false);
    }
  });

  it('accepts a card payment and drops the spaces from the number', () => {
    expect(payOrderSchema.parse({ method: 'card', card })).toEqual({
      method: 'card',
      card: { ...card, number: '4111111111111111' },
    });
  });

  it.each([
    ['fails the Luhn check', '4111111111111112'],
    ['is too short', '4111'],
    ['has letters', '4111abcd11111111'],
  ])('rejects a card number that %s', (_name, number) => {
    const result = payOrderSchema.safeParse({ method: 'card', card: { ...card, number } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['card', 'number']);
  });

  it('never puts the card number in an error (rule 9)', () => {
    const number = '4111111111111112';
    const result = payOrderSchema.safeParse({ method: 'card', card: { ...card, number } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(number);
    expect(result.error?.message).not.toContain(number);
  });

  it('rejects an expired card', () => {
    const result = payOrderSchema.safeParse({
      method: 'card',
      card: { ...card, expiry_month: 1, expiry_year: 2020 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Card has expired');
  });

  it('accepts a card until the end of its expiry month', () => {
    const thisMonth = {
      ...card,
      expiry_month: now.getUTCMonth() + 1,
      expiry_year: now.getUTCFullYear(),
    };
    expect(payOrderSchema.safeParse({ method: 'card', card: thisMonth }).success).toBe(true);
  });

  it('rejects an unknown method, extra fields and a missing card name', () => {
    expect(payOrderSchema.safeParse({ method: 'netbanking' }).success).toBe(false);
    expect(payOrderSchema.safeParse({ method: 'upi', vpa: 'a@b', amount: 1 }).success).toBe(false);
    const { name: _, ...noName } = card;
    expect(payOrderSchema.safeParse({ method: 'card', card: noName }).success).toBe(false);
  });
});

describe('submitOtpSchema', () => {
  it('passes any short OTP on, so the bank decides whether it is right', () => {
    expect(submitOtpSchema.parse({ otp: '000000' })).toEqual({ otp: '000000' });
  });

  it('rejects an empty or overlong OTP', () => {
    expect(submitOtpSchema.safeParse({ otp: '' }).success).toBe(false);
    expect(submitOtpSchema.safeParse({ otp: '1'.repeat(13) }).success).toBe(false);
    expect(submitOtpSchema.safeParse({}).success).toBe(false);
  });
});

describe('createWebhookEndpointSchema', () => {
  const url = 'https://merchant.example/webhooks';

  it('defaults to every event type', () => {
    expect(createWebhookEndpointSchema.parse({ url })).toEqual({ url, event_types: ['*'] });
  });

  it('accepts a list of event types and drops duplicates', () => {
    const parsed = createWebhookEndpointSchema.parse({
      url,
      event_types: ['payment.captured', 'refund.processed', 'payment.captured'],
    });
    expect(parsed.event_types).toEqual(['payment.captured', 'refund.processed']);
  });

  it.each([
    ['an unknown event type', { url, event_types: ['payment.authorized'] }],
    ['"*" mixed with other types', { url, event_types: ['*', 'ping'] }],
    ['an empty list', { url, event_types: [] }],
    ['a non-http URL', { url: 'ftp://merchant.example/hook' }],
    ['a missing URL', {}],
    ['an unknown field', { url, enabled: false }],
  ])('rejects %s', (_name, body) => {
    expect(createWebhookEndpointSchema.safeParse(body).success).toBe(false);
  });
});

describe('redeliverEventSchema', () => {
  it('takes an optional webhook endpoint ID', () => {
    const endpointId = newId('we');
    expect(redeliverEventSchema.parse({})).toEqual({});
    expect(redeliverEventSchema.parse({ endpoint_id: endpointId })).toEqual({
      endpoint_id: endpointId,
    });
  });

  it.each([
    ['another kind of ID', { endpoint_id: newId('evt') }],
    ['an unknown field', { endpoint: newId('we') }],
  ])('rejects %s', (_name, body) => {
    expect(redeliverEventSchema.safeParse(body).success).toBe(false);
  });
});
