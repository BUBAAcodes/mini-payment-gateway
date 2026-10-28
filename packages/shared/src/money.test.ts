import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT, MIN_AMOUNT, formatINR, isValidAmount } from './money';

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
