import type { PrismaClient } from '@gateway/db';
import { istDayBounds, type DashboardOverviewResponse } from '@gateway/shared';

/**
 * Today's numbers for the dashboard overview. "Today" is the calendar day in India, and every
 * number counts the payment attempts created that day (decision 0005), so they all come from one
 * query on the (merchant_id, created_at) index. In-progress attempts are in neither count.
 */
export async function getDashboardOverview(
  db: PrismaClient,
  merchantId: string,
  now = new Date(),
): Promise<DashboardOverviewResponse> {
  const { date, start, end } = istDayBounds(now);
  const groups = await db.payment.groupBy({
    by: ['status'],
    where: {
      merchantId,
      createdAt: { gte: start, lt: end },
      status: { in: ['captured', 'refunded', 'failed'] },
    },
    _count: { _all: true },
    _sum: { amount: true },
  });

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
    currency: 'INR',
  };
}
