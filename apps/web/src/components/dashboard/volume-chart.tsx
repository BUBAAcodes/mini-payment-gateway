import { formatINR, type DashboardOverviewResponse } from '@gateway/shared';
import { barGeometry, compactINR, dayLabel, niceCeiling } from '@/lib/volume-chart';

type Day = DashboardOverviewResponse['last_7_days'][number];

/**
 * Captured volume for the last 7 days: one series, so no legend; the card's heading names it.
 * Built from HTML boxes instead of SVG so its text stays readable at phone width. Each day's
 * whole column is a focusable hover target that shows the exact numbers; today's bar carries a
 * direct label, and every value is also in the table under the chart.
 */
export function VolumeChart({ days, today }: { days: Day[]; today: string }) {
  const top = niceCeiling(Math.max(...days.map((d) => d.volume)));
  // Heights as percentages of the plot.
  const bars = barGeometry(
    days.map((d) => d.volume),
    { width: 100, height: 100, top },
  );
  const ticks = [0, top / 2, top];
  const empty = days.every((d) => d.volume === 0);

  return (
    <figure className="m-0">
      <div className="relative h-56 pl-12">
        {ticks.map((tick) => (
          <div
            key={tick}
            aria-hidden="true"
            className="absolute right-0 left-12 border-t border-border"
            style={{ bottom: `${(tick / top) * 100}%` }}
          >
            <span className="absolute -left-12 w-10 -translate-y-1/2 text-right text-xs text-muted-foreground tabular-nums">
              {compactINR(tick)}
            </span>
          </div>
        ))}

        <div className="relative grid h-full grid-cols-7">
          {days.map((day, i) => {
            const height = bars[i]!.height;
            const label = dayLabel(day.date, today);
            const summary = `${formatINR(day.volume)} · ${day.captured_count} captured`;
            return (
              <div
                key={day.date}
                tabIndex={0}
                aria-label={`${label}, ${day.date}: ${summary}`}
                className="group relative flex h-full items-end justify-center outline-none focus-visible:bg-muted/60"
              >
                <div
                  role="tooltip"
                  className="pointer-events-none absolute z-10 rounded-control bg-foreground px-2.5 py-1.5 text-center text-xs whitespace-nowrap text-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  style={{ bottom: `calc(${height}% + 10px)` }}
                >
                  <span className="block font-semibold tabular-nums">{formatINR(day.volume)}</span>
                  <span className="block text-background/70">
                    {day.captured_count} captured · {label}
                  </span>
                </div>
                {day.date === today && day.volume > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute text-xs font-semibold tabular-nums transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                    style={{ bottom: `calc(${height}% + 6px)` }}
                  >
                    {compactINR(day.volume)}
                  </span>
                )}
                <div
                  aria-hidden="true"
                  className="w-full max-w-6 rounded-t-[4px] bg-foreground transition-opacity group-hover:opacity-75"
                  style={{ height: `${height}%` }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div
        aria-hidden="true"
        className="mt-2 grid grid-cols-7 pl-12 text-center text-xs text-muted-foreground"
      >
        {days.map((day) => (
          <span
            key={day.date}
            className={day.date === today ? 'font-semibold text-foreground' : undefined}
          >
            {dayLabel(day.date, today)}
          </span>
        ))}
      </div>

      {empty && (
        <figcaption className="mt-3 text-sm text-muted-foreground">
          No captured payments in the last 7 days.
        </figcaption>
      )}

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <table className="mt-3 w-full max-w-md">
          <thead className="text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="py-1 font-medium">Day (IST)</th>
              <th className="py-1 text-right font-medium">Volume</th>
              <th className="py-1 text-right font-medium">Captured</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date} className="border-t border-border">
                <td className="py-1.5">{day.date}</td>
                <td className="py-1.5 text-right tabular-nums">{formatINR(day.volume)}</td>
                <td className="py-1.5 text-right tabular-nums">{day.captured_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
