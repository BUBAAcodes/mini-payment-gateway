import { describe, expect, it } from 'vitest';
import { istDate, istDayStart } from './ist';

describe('istDate', () => {
  it('gives the calendar date in India, which is UTC+5:30', () => {
    expect(istDate(new Date('2026-10-30T18:29:59.999Z'))).toBe('2026-10-30');
    expect(istDate(new Date('2026-10-30T18:30:00.000Z'))).toBe('2026-10-31');
    expect(istDate(new Date('2026-10-30T00:00:00.000Z'))).toBe('2026-10-30');
  });
});

describe('istDayStart', () => {
  it('is midnight in India, as a UTC instant', () => {
    expect(istDayStart('2026-10-31').toISOString()).toBe('2026-10-30T18:30:00.000Z');
  });

  it('rejects anything but a real YYYY-MM-DD date', () => {
    for (const input of ['', '2026-10', '2026-13-01', '2026-02-30', '31-10-2026', 'today']) {
      expect(() => istDayStart(input), input).toThrow();
    }
  });
});
