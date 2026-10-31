import type { PrismaClient } from '@gateway/db';
import { istDate, istDayBounds, type DashboardOverviewResponse } from '@gateway/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

export type DayVolume = DashboardOverviewResponse['last_7_days'][number];

/**
 * Numbers for the dashboard overview. "Today" is the calendar day in India, and every number
 * counts the payment attempts created that day (decision 0005), so they all come from queries on
 * the (merchant_id, created_at) index. In-progress attempts are in neither count.
 */
export async function getDashboardOverview(
  db: PrismaClient,
  merchantId: string,
  now = new Date(),
): Promise<DashboardOverviewResponse> {
  const { date, start, end } = istDayBounds(now);
  const [groups, last7Days] = await Promise.all([
    db.payment.groupBy({
      by: ['status'],
      where: {
        merchantId,
        createdAt: { gte: start, lt: end },
        status: { in: ['captured', 'refunded', 'failed'] },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    lastDaysVolume(db, merchantId, now, 7),
  ]);

  let volume = 0;
  let capturedCount = 0;
  let failedCount = 0;
  for (const group of groups) {
    if (group.status === 'failed') {
      failedCount += group._count._all;
    } else {
      // A refunded payment was still captured; the refund shows in the balance, not here.
      capturedCount += group._count._all;
      volume += group._sum.amount ?? 0;
    }
  }

  const finished = capturedCount + failedCount;
  return {
    today: {
      date,
      volume,
      captured_count: capturedCount,
      failed_count: failedCount,
      success_rate: finished === 0 ? null : capturedCount / finished,
    },
    last_7_days: last7Days,
    currency: 'INR',
  };
}

/**
 * Captured volume for each of the last `days` India-time days, today included, oldest first, by
 * the same rule as today's numbers: attempts created that day that were captured (refunded ones
 * included). One query grouped by the IST date; days with nothing come back as 0.
 */
export async function lastDaysVolume(
  db: PrismaClient,
  merchantId: string,
  now: Date,
  days: number,
): Promise<DayVolume[]> {
  const today = istDayBounds(now);
  const start = new Date(today.start.getTime() - (days - 1) * DAY_MS);
  // bigint sums: a busy week could pass the 2.1 billion paise a 32-bit int holds.
  const rows = await db.$queryRaw<{ date: string; volume: bigint; captured_count: bigint }[]>`
    SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS date,
           sum(amount)::bigint AS volume,
           count(*)::bigint AS captured_count
    FROM payments
    WHERE merchant_id = ${merchantId}
      AND created_at >= ${start} AND created_at < ${today.end}
      AND status IN ('captured', 'refunded')
    GROUP BY 1`;
  const byDate = new Map(rows.map((row) => [row.date, row]));

  return Array.from({ length: days }, (_, i) => {
    const date = istDate(new Date(start.getTime() + i * DAY_MS));
    const row = byDate.get(date);
    return {
      date,
      volume: row ? Number(row.volume) : 0,
      captured_count: row ? Number(row.captured_count) : 0,
    };
  });
}
