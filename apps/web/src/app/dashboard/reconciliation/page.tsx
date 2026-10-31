import Link from 'next/link';
import { Suspense } from 'react';
import type { ReconciliationIssueResponse } from '@gateway/shared';
import { ActionButton } from '@/components/dashboard/action-button';
import { LoadingText } from '@/components/dashboard/loading-text';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { Pager } from '@/components/dashboard/pager';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { listReconciliationIssues } from '@/lib/dashboard-api';
import { formatDateTime, reconciliationKindLabel } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';
import { cn } from '@/lib/utils';
import { resolveIssue } from './actions';

type Status = 'open' | 'resolved';

export default function ReconciliationPage({
  searchParams,
}: PageProps<'/dashboard/reconciliation'>) {
  return (
    <section>
      <PageHeader eyebrow="Money" title="Reconciliation">
        Each day we compare our records with the bank&apos;s settlement file. These are the
        differences: for example a payment the bank approved that we never heard about.
      </PageHeader>
      <Suspense fallback={<LoadingText />}>
        <Issues searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Issues({
  searchParams,
}: Pick<PageProps<'/dashboard/reconciliation'>, 'searchParams'>) {
  const { merchantId } = await requireMerchant();
  const search = await searchParams;
  const status: Status = search.status === 'resolved' ? 'resolved' : 'open';
  const after =
    typeof search.starting_after === 'string' && search.starting_after
      ? search.starting_after
      : undefined;

  const page = await listReconciliationIssues(merchantId, { status, starting_after: after });

  return (
    <>
      <nav aria-label="Issue status" className="mb-6 flex gap-2">
        {(['open', 'resolved'] as const).map((option) => (
          <Link
            key={option}
            href={
              option === 'open'
                ? '/dashboard/reconciliation'
                : '/dashboard/reconciliation?status=resolved'
            }
            aria-current={option === status ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-sm capitalize',
              option === status
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {option}
          </Link>
        ))}
      </nav>
      {!page.ok ? (
        <LoadError message={page.error.message} />
      ) : page.data.data.length === 0 ? (
        <EmptyState>
          {status === 'open'
            ? 'Nothing to look at: our records match the bank.'
            : 'No resolved issues yet.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-4">
            {page.data.data.map((issue) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </ul>
          <Pager
            path="/dashboard/reconciliation"
            params={{ status: status === 'resolved' ? status : undefined, starting_after: after }}
            hasMore={page.data.has_more}
            lastId={page.data.data.at(-1)?.id}
          />
        </>
      )}
    </>
  );
}

function IssueCard({ issue }: { issue: ReconciliationIssueResponse }) {
  const ref = issue.gateway_reference;
  return (
    <li className="flex flex-wrap items-start justify-between gap-4 rounded-card border border-border p-5">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={issue.resolved_at ? 'neutral' : 'danger'}>
            {reconciliationKindLabel(issue.kind)}
          </StatusBadge>
          <span className="text-sm text-muted-foreground">Bank date {issue.bank_date}</span>
        </div>
        <p className="text-sm">
          Ours:{' '}
          {ref?.startsWith('pay_') ? (
            <Link
              href={`/dashboard/payments/${ref}`}
              className="font-mono underline underline-offset-4"
            >
              {ref}
            </Link>
          ) : (
            <span className="font-mono">{ref ?? '—'}</span>
          )}
          {' · '}Bank: <span className="font-mono">{issue.bank_ref ?? '—'}</span>
        </p>
        <pre className="overflow-x-auto rounded-control bg-card px-3 py-2 font-mono text-xs">
          {JSON.stringify(issue.details, null, 2)}
        </pre>
        {issue.resolved_at && (
          <p className="text-xs text-muted-foreground">
            Resolved {formatDateTime(issue.resolved_at)}
          </p>
        )}
      </div>
      {!issue.resolved_at && (
        <ActionButton
          action={resolveIssue.bind(null, issue.id)}
          label="Mark resolved"
          pendingLabel="Saving…"
        />
      )}
    </li>
  );
}
