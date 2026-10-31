import Link from 'next/link';
import { Suspense } from 'react';
import { formatINR } from '@gateway/shared';
import { Eyebrow } from '@/components/checkout/ui';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { getBalance, getMerchant, getOverview, listPayments } from '@/lib/dashboard-api';
import { formatPercent } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';
import { cn } from '@/lib/utils';
import { OverviewSkeleton } from '@/components/dashboard/skeletons';
import { VolumeChart } from '@/components/dashboard/volume-chart';
import { PaymentsTable } from '@/components/dashboard/payments-table';

/** Overview: what we owe the merchant, and how today is going. */
export default function DashboardPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <Overview />
    </Suspense>
  );
}

async function Overview() {
  // The merchant ID comes from the session, and only from there.
  const { merchantId } = await requireMerchant();
  const [merchant, balance, overview, recent] = await Promise.all([
    getMerchant(merchantId),
    getBalance(merchantId),
    getOverview(merchantId),
    listPayments(merchantId, { limit: 5 }),
  ]);

  if (!merchant.ok) return <LoadError message={merchant.error.message} />;

  return (
    <section>
      <PageHeader eyebrow="Merchant" title={merchant.data.name} />

      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          label="Unsettled balance"
          note="What we owe you and have not paid out yet. Negative when refunds since the last settlement are more than new payments."
        >
          {balance.ok ? (
            <span className={cn(balance.data.balance < 0 && 'text-destructive')}>
              {formatINR(balance.data.balance)}
            </span>
          ) : (
            <Unavailable message={balance.error.message} />
          )}
        </Stat>
        <Stat
          label="Today's volume"
          note={
            overview.ok
              ? `Captured on ${overview.data.today.date} (India time), before refunds and fees.`
              : undefined
          }
        >
          {overview.ok ? (
            formatINR(overview.data.today.volume)
          ) : (
            <Unavailable message={overview.error.message} />
          )}
        </Stat>
        <Stat
          label="Success rate today"
          note={
            overview.ok
              ? `${overview.data.today.captured_count} captured, ${overview.data.today.failed_count} failed. Payments still with the bank don't count yet.`
              : undefined
          }
        >
          {overview.ok ? (
            formatPercent(overview.data.today.success_rate)
          ) : (
            <Unavailable message={overview.error.message} />
          )}
        </Stat>
      </div>

      {overview.ok && (
        <div className="mt-4 rounded-card border border-border p-6">
          <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg uppercase">Captured, last 7 days</h2>
            <p className="text-sm text-muted-foreground">
              {formatINR(overview.data.last_7_days.reduce((sum, d) => sum + d.volume, 0))} in total
              · India time
            </p>
          </div>
          <VolumeChart days={overview.data.last_7_days} today={overview.data.today.date} />
        </div>
      )}

      <div className="mt-12 mb-4 flex items-end justify-between gap-4">
        <h2 className="font-display text-xl uppercase">Latest payments</h2>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/payments">All payments</Link>
        </Button>
      </div>
      {!recent.ok ? (
        <LoadError message={recent.error.message} />
      ) : recent.data.data.length === 0 ? (
        <EmptyState>No payments yet. Buy something on the demo store to see one here.</EmptyState>
      ) : (
        <PaymentsTable payments={recent.data.data} />
      )}
    </section>
  );
}

function Stat({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card bg-card p-6">
      <Eyebrow>{label}</Eyebrow>
      <p className="mt-2 text-4xl font-semibold tabular-nums">{children}</p>
      {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
    </div>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <span role="alert" className="text-base font-normal text-destructive">
      {message}
    </span>
  );
}
