import { describe, expect, it } from 'vitest';
import {
  amountSchema,
  createOrderSchema,
  currencySchema,
  idSchema,
  paginationSchema,
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
