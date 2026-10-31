import Link from 'next/link';
import { Suspense } from 'react';
import { WEBHOOK_EVENT_TYPES, type EventResponse } from '@gateway/shared';
import { EventCard } from '@/components/dashboard/event-card';
import { EmptyState, LoadError, PageHeader } from '@/components/dashboard/page-header';
import { Pager } from '@/components/dashboard/pager';
import { CardsSkeleton } from '@/components/dashboard/skeletons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { listEvents } from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

const DELIVERY_STATUSES = ['failed', 'pending', 'succeeded'] as const;
type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

type Search = Awaited<PageProps<'/dashboard/events'>['searchParams']>;

function one(value: Search[string]): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const selectStyles = 'h-9 rounded-md border border-input bg-background px-3 text-sm';

export default function EventsPage({ searchParams }: PageProps<'/dashboard/events'>) {
  return (
    <section>
      <PageHeader eyebrow="Developers" title="Events">
        Everything we told your webhook endpoints, and how each delivery went. Replay sends the same
        event again, with the same webhook-id, so a receiver that already has it can skip it.
      </PageHeader>
      <Suspense fallback={<CardsSkeleton />}>
        <Events searchParams={searchParams} />
      </Suspense>
    </section>
  );
}

async function Events({ searchParams }: Pick<PageProps<'/dashboard/events'>, 'searchParams'>) {
  const { merchantId } = await requireMerchant();
  const search = await searchParams;
  // Anything not on these lists is ignored rather than sent to the API.
  const type = WEBHOOK_EVENT_TYPES.find((t) => t === one(search.type)) as
    EventResponse['type'] | undefined;
  const status = DELIVERY_STATUSES.find((s) => s === one(search.delivery_status)) as
    DeliveryStatus | undefined;
  const after = one(search.starting_after);

  const page = await listEvents(merchantId, {
    type,
    delivery_status: status,
    starting_after: after,
  });

  return (
    <>
      <form method="get" className="mb-6 flex flex-wrap items-end gap-4 rounded-card bg-card p-4">
        <div className="space-y-2">
          <Label htmlFor="type">Event type</Label>
          <select id="type" name="type" defaultValue={type ?? ''} className={selectStyles}>
            <option value="">Any type</option>
            {WEBHOOK_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="delivery_status">Has a delivery that</Label>
          <select
            id="delivery_status"
            name="delivery_status"
            defaultValue={status ?? ''}
            className={selectStyles}
          >
            <option value="">Any status</option>
            <option value="failed">Failed</option>
            <option value="pending">Is pending (retrying)</option>
            <option value="succeeded">Succeeded</option>
          </select>
        </div>
        <Button type="submit">Filter</Button>
        <Button asChild variant="outline">
          <Link href="/dashboard/events">Clear</Link>
        </Button>
      </form>

      {!page.ok ? (
        <LoadError message={page.error.message} />
      ) : page.data.data.length === 0 ? (
        <EmptyState>
          {type || status
            ? 'No events match these filters.'
            : 'No events yet. They appear when payments, refunds or settlements happen.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-4">
            {page.data.data.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </ul>
          <Pager
            path="/dashboard/events"
            params={{ type, delivery_status: status, starting_after: after }}
            hasMore={page.data.has_more}
            lastId={page.data.data.at(-1)?.id}
          />
        </>
      )}
    </>
  );
}
