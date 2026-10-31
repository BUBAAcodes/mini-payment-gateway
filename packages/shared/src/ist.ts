// India Standard Time, UTC+5:30 all year (no daylight saving). The gateway works in INR only, so
// "today" on the dashboard means today in India, whatever timezone the server runs in.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date in India at `instant`, as YYYY-MM-DD. */
export function istDate(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight in India at the start of `date` (YYYY-MM-DD). Throws on anything else. */
export function istDayStart(date: string): Date {
  const utcMidnight = new Date(`${date}T00:00:00.000Z`);
  // new Date() rolls 2026-02-30 over to March; reading the date back catches that.
  if (!DATE_PATTERN.test(date) || Number.isNaN(utcMidnight.getTime())) {
    throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  }
  if (utcMidnight.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Not a real date: ${date}`);
  }
  return new Date(utcMidnight.getTime() - IST_OFFSET_MS);
}

/** [start, end) of the Indian calendar day that contains `instant`. */
export function istDayBounds(instant: Date): { date: string; start: Date; end: Date } {
  const date = istDate(instant);
  const start = istDayStart(date);
  return { date, start, end: new Date(start.getTime() + DAY_MS) };
}
