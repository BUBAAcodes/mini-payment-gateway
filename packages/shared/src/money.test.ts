import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT, MIN_AMOUNT, formatINR, isValidAmount, parseRupees } from './money';

describe('isValidAmount', () => {
  it('accepts the range edges', () => {
    expect(isValidAmount(MIN_AMOUNT)).toBe(true);
    expect(isValidAmount(MAX_AMOUNT)).toBe(true);
  });

  it('rejects amounts just outside the range', () => {
    expect(isValidAmount(99)).toBe(false);
    expect(isValidAmount(50_000_001)).toBe(false);
  });

  it('rejects floats and non-finite numbers', () => {
    expect(isValidAmount(100.5)).toBe(false);
    expect(isValidAmount(Number.NaN)).toBe(false);
    expect(isValidAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('formatINR', () => {
  it('formats paise as rupees with two decimals', () => {
    expect(formatINR(50_000)).toBe('₹500.00');
    expect(formatINR(105)).toBe('₹1.05');
    expect(formatINR(0)).toBe('₹0.00');
  });

  it('uses Indian digit grouping', () => {
    expect(formatINR(50_000_000)).toBe('₹5,00,000.00');
    expect(formatINR(1_234_567_89)).toBe('₹12,34,567.89');
  });

  it('formats negative balances', () => {
    expect(formatINR(-20_050)).toBe('-₹200.50');
  });

  it('rejects non-integer paise', () => {
    expect(() => formatINR(10.5)).toThrow();
  });
});

describe('parseRupees', () => {
  it('turns rupees typed by a person into integer paise', () => {
    expect(parseRupees('500')).toBe(50_000);
    expect(parseRupees('12.50')).toBe(1_250);
    expect(parseRupees('0.5')).toBe(50);
    expect(parseRupees('0.01')).toBe(1);
    expect(parseRupees(' 1,00,000.00 ')).toBe(10_000_000);
  });

  it('never goes through floats', () => {
    // 0.1 + 0.2 style errors: 19.99 * 100 is 1998.9999999999998 as a float.
    expect(parseRupees('19.99')).toBe(1_999);
    expect(parseRupees('1.10')).toBe(110);
  });

  it('rejects anything that is not a plain positive amount', () => {
    for (const input of ['', ' ', 'abc', '1.234', '-5', '1e3', '₹500', '5.', '.5.', '0', '0.00']) {
      expect(parseRupees(input), input).toBeNull();
    }
  });

  it('rejects amounts above the maximum', () => {
    expect(parseRupees('500000')).toBe(MAX_AMOUNT);
    expect(parseRupees('500000.01')).toBeNull();
  });
});
