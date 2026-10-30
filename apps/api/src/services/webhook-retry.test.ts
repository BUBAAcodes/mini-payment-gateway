import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, retryDelayMs } from './webhook-retry';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('retryDelayMs', () => {
  it('follows the schedule from the spec', () => {
    expect(RETRY_DELAYS_MS).toEqual([
      0,
      5 * SECOND,
      5 * MINUTE,
      30 * MINUTE,
      2 * HOUR,
      5 * HOUR,
      10 * HOUR,
      10 * HOUR,
    ]);
    // With no jitter (random = 0.5), each failure waits exactly its scheduled delay.
    const delays = RETRY_DELAYS_MS.map((_, i) => retryDelayMs(i + 1, () => 0.5));
    expect(delays).toEqual(RETRY_DELAYS_MS);
  });

  it('moves each delay by at most 20% either way', () => {
    expect(retryDelayMs(3, () => 0)).toBe(4 * MINUTE);
    expect(retryDelayMs(3, () => 1)).toBe(6 * MINUTE);

    for (let i = 0; i < 1000; i++) {
      const delay = retryDelayMs(5)!;
      expect(delay).toBeGreaterThanOrEqual(0.8 * 2 * HOUR);
      expect(delay).toBeLessThanOrEqual(1.2 * 2 * HOUR);
    }
  });

  it('retries the first failure straight away', () => {
    expect(retryDelayMs(1, () => 0)).toBe(0);
    expect(retryDelayMs(1, () => 1)).toBe(0);
  });

  it('gives up after the eighth retry fails: nine attempts in all', () => {
    expect(MAX_ATTEMPTS).toBe(9);
    expect(retryDelayMs(8)).not.toBeNull();
    expect(retryDelayMs(9)).toBeNull();
  });
});
