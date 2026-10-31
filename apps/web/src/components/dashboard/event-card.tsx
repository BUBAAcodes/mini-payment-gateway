import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import type { EventResponse } from '@gateway/shared';
import { replayEvent } from '@/app/dashboard/events/actions';
import { ActionButton } from './action-button';
import { CopyButton } from './copy-button';
import { StatusBadge } from './status-badge';
import { formatDateTime, statusLabel, statusTone } from '@/lib/dashboard-format';

function objectIdOf(event: EventResponse): string | undefined {
  const object = event.data.object as { id?: unknown } | undefined;
  return typeof object?.id === 'string' ? object.id : undefined;
}

function lastAnswer(delivery: EventResponse['deliveries'][number]): string {
  return delivery.last_response_status
    ? `HTTP ${delivery.last_response_status} · ${delivery.last_response_ms} ms`
    : (delivery.last_error ?? '—');
}

/** One webhook event with its deliveries and a Replay button. Server Component. */
export function EventCard({ event }: { event: EventResponse }) {
  const objectId = objectIdOf(event);
  return (
    <li className="rounded-card border border-border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-sm font-semibold">{event.type}</p>
          <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            <span>{event.id}</span>
            <CopyButton value={event.id} label="event ID" />
            <span>· {formatDateTime(event.created_at)}</span>
            {objectId && (
              <span>
                ·{' '}
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
              </span>
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
        <>
          {/* Phones: one small block per delivery. */}
          <ul className="mt-4 space-y-2 md:hidden">
            {event.deliveries.map((delivery) => (
              <li key={delivery.id} className="rounded-control bg-card p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <StatusBadge tone={statusTone(delivery.status)}>
                    {statusLabel(delivery.status)}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    {delivery.attempt_count} {delivery.attempt_count === 1 ? 'attempt' : 'attempts'}
                  </span>
                </div>
                <p className="mt-2 text-muted-foreground">{lastAnswer(delivery)}</p>
                {delivery.status === 'pending' && (
                  <p className="text-xs text-muted-foreground">
                    Next try {formatDateTime(delivery.next_attempt_at)}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {/* Wider screens: a table. */}
          <table className="mt-4 hidden w-full text-sm md:table">
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
                    <StatusBadge tone={statusTone(delivery.status)}>
                      {statusLabel(delivery.status)}
                    </StatusBadge>
                  </td>
                  <td className="py-2 tabular-nums">{delivery.attempt_count}</td>
                  <td className="py-2 text-muted-foreground">{lastAnswer(delivery)}</td>
                  <td className="py-2 text-muted-foreground">
                    {delivery.status === 'pending' ? formatDateTime(delivery.next_attempt_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </li>
  );
}
