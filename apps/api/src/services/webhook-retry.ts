const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * How long to wait after each failed attempt (spec section 11): the first retry goes straight
 * away, the last after 10 hours. When the attempt after the last delay fails too, the delivery is
 * `failed`, so a webhook gets at most nine attempts over about 28 hours.
 */
export const RETRY_DELAYS_MS = [
  0,
  5 * SECOND,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  10 * HOUR,
  10 * HOUR,
];

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Each delay moves by up to this fraction either way, so retries after an outage spread out. */
const JITTER = 0.2;

/**
 * The wait before the next attempt, given how many attempts have failed so far (1 or more), with
 * ±20% jitter. Null when no retries are left. `random` returns a number in [0, 1].
 */
export function retryDelayMs(
  failedAttempts: number,
  random: () => number = Math.random,
): number | null {
  const delay = RETRY_DELAYS_MS[failedAttempts - 1];
  if (delay === undefined) return null;
  return Math.round(delay * (1 - JITTER + 2 * JITTER * random()));
}
