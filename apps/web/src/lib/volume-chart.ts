// Pure helpers for the overview's 7-day volume chart. Amounts stay integer paise; only the axis
// labels are rounded, for reading.

/** Bars stay thin and leave the rest of their slot as air (dataviz mark spec). */
const MAX_BAR_WIDTH = 24;
/** A day with any volume stays visible, however small next to the biggest day. */
const MIN_BAR_HEIGHT = 2;
/** An empty week still gets an axis: ₹1,000. */
const EMPTY_AXIS_TOP = 100_000;

/** The top of the axis: the smallest 1, 2 or 5 × 10ⁿ paise that fits `max`. */
export function niceCeiling(max: number): number {
  if (max <= 0) return EMPTY_AXIS_TOP;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

const compact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Axis labels: ₹500, ₹1.5K, ₹1.2L. Display only; never for amounts anyone acts on. */
export function compactINR(paise: number): string {
  return compact.format(paise / 100);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Today", or "Thu 29" for another YYYY-MM-DD date. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  const day = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()}`;
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where each bar goes in a plot of `width` × `height`, all growing from the bottom edge. */
export function barGeometry(
  values: readonly number[],
  { width, height, top }: { width: number; height: number; top: number },
): Bar[] {
  const slot = width / values.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, slot * 0.6);
  return values.map((value, i) => {
    const scaled = (value / top) * height;
    const barHeight = value > 0 ? Math.max(MIN_BAR_HEIGHT, scaled) : 0;
    return {
      x: i * slot + (slot - barWidth) / 2,
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
    };
  });
}
