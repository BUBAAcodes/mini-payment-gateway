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

const RUPEES_PATTERN = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/**
 * Reads an amount a person typed in rupees ("12.50", "1,00,000") as integer paise, or null if it
 * is not a positive amount up to MAX_AMOUNT. Works on the digits as text, so no float ever holds
 * the money (rule 1): Number("19.99") * 100 would be 1998.9999999999998.
 */
export function parseRupees(input: string): number | null {
  const match = RUPEES_PATTERN.exec(input.trim().replaceAll(',', ''));
  if (!match) return null;
  const [, rupees, fraction = ''] = match;
  const paise = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
  return paise >= 1 && paise <= MAX_AMOUNT ? paise : null;
}
