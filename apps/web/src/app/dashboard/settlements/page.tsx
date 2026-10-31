import { Suspense } from 'react';
import { formatINR } from '@gateway/shared';
import { TableSkeleton } from '@/components/dashboard/skeletons';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { CopyableId } from '@/components/dashboard/copy-button';
import { Pager } from '@/components/dashboard/pager';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listSettlements } from '@/lib/dashboard-api';
import { formatDateTime } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';

export default function SettlementsPage({ searchParams }: PageProps<'/dashboard/settlements'>) {
  return (
    <section>
      <PageHeader eyebrow="Money" title="Settlements">
        What we paid out to you. Each one covers the payments captured and refunds processed since
        the one before: net = gross − our fees − refunds.
      </PageHeader>
      <Suspense fallback={<TableSkeleton />}>
        <Settlements searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Settlements({
  searchParams,
}: Pick<PageProps<'/dashboard/settlements'>, 'searchParams'>) {
  const { merchantId } = await requireMerchant();
  const { starting_after } = await searchParams;
  const after = typeof starting_after === 'string' && starting_after ? starting_after : undefined;

  const page = await listSettlements(merchantId, { starting_after: after });
  if (!page.ok) return <LoadError message={page.error.message} />;
  if (page.data.data.length === 0) {
    return <EmptyState>No settlements yet. They run once a day at 02:00 India time.</EmptyState>;
  }

  return (
    <>
      <ul className="space-y-3 md:hidden">
        {page.data.data.map((settlement) => (
          <li key={settlement.id} className="rounded-card border border-border p-4 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground uppercase">Net paid out</span>
              <span className="text-lg font-semibold tabular-nums">
                {formatINR(settlement.net)}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 tabular-nums">
              <dt className="text-muted-foreground">Gross</dt>
              <dd className="text-right">{formatINR(settlement.gross)}</dd>
              <dt className="text-muted-foreground">Fees</dt>
              <dd className="text-right">−{formatINR(settlement.fees)}</dd>
              <dt className="text-muted-foreground">Refunds</dt>
              <dd className="text-right">−{formatINR(settlement.refunds)}</dd>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {formatDateTime(settlement.period_start)} → {formatDateTime(settlement.period_end)}
            </p>
            <div className="mt-1">
              <CopyableId id={settlement.id} label="settlement ID" />
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Settlement</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Fees</TableHead>
              <TableHead className="text-right">Refunds</TableHead>
              <TableHead className="text-right">Net paid out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.data.data.map((settlement) => (
              <TableRow key={settlement.id}>
                <TableCell>
                  <CopyableId id={settlement.id} label="settlement ID" />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(settlement.period_start)} →{' '}
                  {formatDateTime(settlement.period_end)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatINR(settlement.gross)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  −{formatINR(settlement.fees)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  −{formatINR(settlement.refunds)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatINR(settlement.net)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pager
        path="/dashboard/settlements"
        params={{ starting_after: after }}
        hasMore={page.data.has_more}
        lastId={page.data.data.at(-1)?.id}
      />
    </>
  );
}
