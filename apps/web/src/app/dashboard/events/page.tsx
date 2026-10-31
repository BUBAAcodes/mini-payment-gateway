import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { Suspense } from 'react';
import type { EventResponse } from '@gateway/shared';
import { ActionButton } from '@/components/dashboard/action-button';
import { LoadingText } from '@/components/dashboard/loading-text';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { Pager } from '@/components/dashboard/pager';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { listEvents } from '@/lib/dashboard-api';
import { formatDateTime, statusTone } from '@/lib/dashboard-format';
import { requireMerchant } from '@/lib/session';
import { replayEvent } from './actions';

export default function EventsPage({ searchParams }: PageProps<'/dashboard/events'>) {
  return (
    <section>
      <PageHeader eyebrow="Developers" title="Events">
        Everything we told your webhook endpoints, and how each delivery went. Replay sends the same
        event again, with the same webhook-id, so a receiver that already has it can skip it.
      </PageHeader>
      <Suspense fallback={<LoadingText />}>
        <Events searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Events({ searchParams }: Pick<PageProps<'/dashboard/events'>, 'searchParams'>) {
  const { merchantId } = await requireMerchant();
  const { starting_after } = await searchParams;
  const after = typeof starting_after === 'string' && starting_after ? starting_after : undefined;

  const page = await listEvents(merchantId, { starting_after: after });
  if (!page.ok) return <LoadError message={page.error.message} />;
  if (page.data.data.length === 0) {
    return (
      <EmptyState>
        No events yet. They appear when payments, refunds or settlements happen.
      </EmptyState>
    );
  }

  return (
    <>
      <ul className="space-y-4">
        {page.data.data.map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
      </ul>
      <Pager
        path="/dashboard/events"
        params={{ starting_after: after }}
        hasMore={page.data.has_more}
        lastId={page.data.data.at(-1)?.id}
      />
    </>
  );
}

function objectIdOf(event: EventResponse): string | undefined {
  const object = event.data.object as { id?: unknown } | undefined;
  return typeof object?.id === 'string' ? object.id : undefined;
}

function EventCard({ event }: { event: EventResponse }) {
  const objectId = objectIdOf(event);
  return (
    <li className="rounded-card border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="font-mono text-sm font-semibold">{event.type}</p>
          <p className="text-xs text-muted-foreground">
            {event.id} · {formatDateTime(event.created_at)}
            {objectId && (
              <>
                {' · '}
                {objectId.startsWith('pay_') ? (
                  <Link
                    href={`/dashboard/payments/${objectId}`}
                    className="underline underline-offset-4"
                  >
                    {objectId}
                  </Link>
                ) : (
                  objectId
                )}
              </>
            )}
          </p>
        </div>
        <ActionButton
          action={replayEvent.bind(null, event.id)}
          label="Replay"
          pendingLabel="Queueing…"
          // A new key each render: a double click queues one replay, not two.
          idempotencyKey={randomUUID()}
        />
      </div>

      {event.deliveries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {event.dispatched_at ? 'No endpoint was subscribed to this event.' : 'Not sent yet.'}
        </p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="py-1 font-medium">Delivery</th>
              <th className="py-1 font-medium">Status</th>
              <th className="py-1 font-medium">Attempts</th>
              <th className="py-1 font-medium">Last answer</th>
              <th className="py-1 font-medium">Next try</th>
            </tr>
          </thead>
          <tbody>
            {event.deliveries.map((delivery) => (
              <tr key={delivery.id} className="border-t border-border align-top">
                <td className="py-2 font-mono text-xs">{delivery.id}</td>
                <td className="py-2">
                  <StatusBadge tone={statusTone(delivery.status)}>{delivery.status}</StatusBadge>
                </td>
                <td className="py-2 tabular-nums">{delivery.attempt_count}</td>
                <td className="py-2 text-muted-foreground">
                  {delivery.last_response_status
                    ? `HTTP ${delivery.last_response_status} · ${delivery.last_response_ms} ms`
                    : (delivery.last_error ?? '—')}
                </td>
                <td className="py-2 text-muted-foreground">
                  {delivery.status === 'pending' ? formatDateTime(delivery.next_attempt_at) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}
