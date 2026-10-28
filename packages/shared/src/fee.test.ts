import { describe, expect, it } from 'vitest';
import { calculateFee } from './fee';

describe('calculateFee', () => {
  it('takes 2% of ₹500 at 200 bps', () => {
    expect(calculateFee(50_000, 200)).toBe(1_000);
  });

  it('rounds half up', () => {
    expect(calculateFee(125, 200)).toBe(3); // 2.5
    expect(calculateFee(175, 200)).toBe(4); // 3.5
  });

  it('rounds down below half', () => {
    expect(calculateFee(124, 200)).toBe(2); // 2.48
  });

  it('is zero at 0 bps', () => {
    expect(calculateFee(50_000, 0)).toBe(0);
  });

  it('handles the largest order amount exactly', () => {
    expect(calculateFee(50_000_000, 200)).toBe(1_000_000);
    expect(calculateFee(50_000_000, 10_000)).toBe(50_000_000);
  });

  it('rejects non-integer inputs', () => {
    expect(() => calculateFee(100.5, 200)).toThrow();
    expect(() => calculateFee(100, 2.5)).toThrow();
  });

  it('rejects negative inputs', () => {
    expect(() => calculateFee(-100, 200)).toThrow();
    expect(() => calculateFee(100, -1)).toThrow();
  });
});
