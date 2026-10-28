/** Smallest order amount in paise (₹1). */
export const MIN_AMOUNT = 100;
/** Largest order amount in paise (₹5,00,000). */
export const MAX_AMOUNT = 50_000_000;

export function isValidAmount(paise: number): boolean {
  return Number.isInteger(paise) && paise >= MIN_AMOUNT && paise <= MAX_AMOUNT;
}

const rupeeGrouping = new Intl.NumberFormat('en-IN');

/** Formats integer paise for display, e.g. 50000000 → "₹5,00,000.00". */
export function formatINR(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`paise must be an integer, got ${paise}`);
  }
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}₹${rupeeGrouping.format(rupees)}.${rest}`;
}
