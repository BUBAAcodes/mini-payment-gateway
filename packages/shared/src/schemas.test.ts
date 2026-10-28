import { describe, expect, it } from 'vitest';
import { amountSchema, currencySchema, idSchema, paginationSchema } from './schemas';
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
