/**
 * Our fee on a captured amount: amount × feeBps / 10000, rounded half up.
 * Integer math only, so there is no float rounding error.
 */
export function calculateFee(amount: number, feeBps: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`amount must be a non-negative integer, got ${amount}`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new RangeError(`feeBps must be a non-negative integer, got ${feeBps}`);
  }
  return Math.floor((amount * feeBps + 5_000) / 10_000);
}
