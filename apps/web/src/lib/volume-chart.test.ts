import { describe, expect, it } from 'vitest';
import { barGeometry, compactINR, dayLabel, niceCeiling } from './volume-chart';

describe('niceCeiling', () => {
  it('rounds the top of the axis up to 1, 2 or 5 times a power of ten (in paise)', () => {
    expect(niceCeiling(0)).toBe(100_000); // an empty week still gets a ₹1K axis
    expect(niceCeiling(50_000)).toBe(50_000);
    expect(niceCeiling(50_001)).toBe(100_000);
    expect(niceCeiling(370_000)).toBe(500_000);
    expect(niceCeiling(1_200_000)).toBe(2_000_000);
  });
});

describe('compactINR', () => {
  it('shortens rupees the Indian way for axis ticks', () => {
    expect(compactINR(0)).toBe('₹0');
    expect(compactINR(50_000)).toBe('₹500');
    expect(compactINR(150_000)).toBe('₹1.5K');
    expect(compactINR(12_000_000)).toBe('₹1.2L');
  });
});

describe('dayLabel', () => {
  it('names today, and other days by weekday and date', () => {
    expect(dayLabel('2026-10-30', '2026-10-30')).toBe('Today');
    expect(dayLabel('2026-10-29', '2026-10-30')).toBe('Thu 29');
  });
});

describe('barGeometry', () => {
  it('scales bars to the axis, from a shared baseline', () => {
    const bars = barGeometry([0, 25_000, 50_000], { width: 300, height: 100, top: 50_000 });
    expect(bars.map((b) => b.height)).toEqual([0, 50, 100]);
    expect(bars.map((b) => b.y)).toEqual([100, 50, 0]);
  });

  it('keeps bars thin: at most 24px, centred in their slot', () => {
    const [bar] = barGeometry([1], { width: 100, height: 100, top: 1 });
    expect(bar!.width).toBe(24);
    expect(bar!.x + bar!.width / 2).toBe(50);
  });

  it('gives a tiny non-zero day a visible sliver, and zero days nothing', () => {
    const bars = barGeometry([0, 1], { width: 200, height: 100, top: 1_000_000 });
    expect(bars[0]!.height).toBe(0);
    expect(bars[1]!.height).toBe(2);
  });
});
