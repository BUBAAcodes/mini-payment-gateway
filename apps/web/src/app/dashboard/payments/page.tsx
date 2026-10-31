import Link from 'next/link';
import { Suspense } from 'react';
import type { PaymentResponse } from '@gateway/shared';
import { TableSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { Pager } from '@/components/dashboard/pager';
import { PaymentsTable } from '@/components/dashboard/payments-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { listPayments } from '@/lib/dashboard-api';
import { paymentDateRange, statusLabel } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';

const STATUSES: PaymentResponse['status'][] = [
  'captured',
  'refunded',
  'failed',
  'pending',
  'otp_required',
  'authorized',
  'created',
];

type Search = Awaited<PageProps<'/dashboard/payments'>['searchParams']>;

function one(value: Search[string]): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export default function PaymentsPage({ searchParams }: PageProps<'/dashboard/payments'>) {
  return (
    <section>
      <PageHeader eyebrow="Payments" title="Payments">
        Every payment attempt, newest first. Open one to see its details or refund it.
      </PageHeader>
      <Suspense fallback={<TableSkeleton />}>
        <Payments searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Payments({ searchParams }: Pick<PageProps<'/dashboard/payments'>, 'searchParams'>) {
  const { merchantId } = await requireMerchant();
  const search = await searchParams;
  const filters: Filters = {
    status: STATUSES.find((s) => s === one(search.status)),
    from: one(search.from),
    to: one(search.to),
    starting_after: one(search.starting_after),
  };
  return (
    <>
      <form method="get" className="mb-6 flex flex-wrap items-end gap-4 rounded-card bg-card p-4">
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue={filters.status ?? ''}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Any status</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            name="from"
            type="date"
            defaultValue={filters.from}
            className="bg-background"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="to">To (inclusive)</Label>
          <Input
            id="to"
            name="to"
            type="date"
            defaultValue={filters.to}
            className="bg-background"
          />
        </div>
        <Button type="submit">Filter</Button>
        <Button asChild variant="outline">
          <Link href="/dashboard/payments">Clear</Link>
        </Button>
        <p className="w-full text-xs text-muted-foreground">Dates are in India time.</p>
      </form>

      <Results merchantId={merchantId} filters={filters} />
    </>
  );
}

interface Filters {
  status: PaymentResponse['status'] | undefined;
  /** YYYY-MM-DD in India time, as the form sends them. */
  from: string | undefined;
  to: string | undefined;
  starting_after: string | undefined;
}

async function Results({ merchantId, filters }: { merchantId: string; filters: Filters }) {
  const range = paymentDateRange(filters.from, filters.to);
  if (!range.ok) return <LoadError message={range.message} />;

  const page = await listPayments(merchantId, {
    status: filters.status,
    from: range.from,
    to: range.to,
    starting_after: filters.starting_after,
  });
  if (!page.ok) return <LoadError message={page.error.message} />;
  if (page.data.data.length === 0) return <EmptyState>No payments match these filters.</EmptyState>;

  return (
    <>
      <PaymentsTable payments={page.data.data} />
      <Pager
        path="/dashboard/payments"
        params={{ ...filters }}
        hasMore={page.data.has_more}
        lastId={page.data.data.at(-1)?.id}
      />
    </>
  );
}
