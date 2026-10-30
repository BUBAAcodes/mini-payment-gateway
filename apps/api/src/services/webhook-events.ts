import type { Event, Prisma, PrismaClient, WebhookDelivery } from '@gateway/db';
import {
  InvalidStateError,
  NotFoundError,
  ValidationError,
  isId,
  newId,
  type EventResponse,
} from '@gateway/shared';
import { olderThan, toPage, type Page } from './pagination';
import { webhookDeliveryResource } from './webhook-delivery';
import { getWebhookEndpoint, liveEndpoints } from './webhook-endpoints';

export type EventWithDeliveries = Event & { deliveries: WebhookDelivery[] };

/** Newest first, each with its deliveries, oldest first. `startingAfter` is the last ID of the previous page. */
export async function listEvents(
  db: PrismaClient,
  merchantId: string,
  { limit, startingAfter }: { limit: number; startingAfter?: string },
): Promise<Page<EventWithDeliveries>> {
  let after: Prisma.EventWhereInput = {};
  if (startingAfter !== undefined) {
    const cursor = isId('evt', startingAfter)
      ? await db.event.findFirst({ where: { id: startingAfter, merchantId } })
      : null;
    if (!cursor) throw new ValidationError('No such event', 'starting_after');
    after = olderThan(cursor);
  }

  const rows = await db.event.findMany({
    where: { merchantId, ...after },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: { deliveries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  return toPage(rows, limit);
}

/**
 * Replay (section 9.6, step 5): queues a fresh `pending` delivery of the event, due now, for the
 * sender loop. It is the same event, so the same webhook-id, and a receiver that already handled
 * it skips it. Goes to `endpointId` if given, even if that endpoint never got the event; otherwise
 * to every live endpoint that got it before.
 */
export async function redeliverEvent(
  db: PrismaClient,
  merchantId: string,
  eventId: string,
  { endpointId }: { endpointId?: string } = {},
): Promise<WebhookDelivery[]> {
  const event = isId('evt', eventId)
    ? await db.event.findFirst({ where: { id: eventId, merchantId } })
    : null;
  if (!event) throw new NotFoundError('Event');
  // Not fanned out yet: the worker is about to send it anyway.
  if (!event.dispatchedAt) throw new InvalidStateError('This event has not been sent yet');

  let endpointIds: string[];
  if (endpointId !== undefined) {
    endpointIds = [(await getWebhookEndpoint(db, merchantId, endpointId)).id];
  } else {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { ...liveEndpoints(merchantId), deliveries: { some: { eventId: event.id } } },
      select: { id: true },
    });
    endpointIds = endpoints.map((e) => e.id);
    if (endpointIds.length === 0) {
      throw new InvalidStateError(
        'No live webhook endpoint has received this event. Pass endpoint_id to pick one.',
      );
    }
  }

  return db.webhookDelivery.createManyAndReturn({
    data: endpointIds.map((id) => ({ id: newId('wd'), eventId: event.id, endpointId: id })),
  });
}

/** The public JSON shape of an event, with the status of each delivery. */
export function eventResource(e: EventWithDeliveries): EventResponse {
  return {
    id: e.id,
    // Only recordEvent writes events, and it takes a WebhookEventType.
    type: e.type as EventResponse['type'],
    created_at: e.createdAt.toISOString(),
    data: e.payload as EventResponse['data'],
    dispatched_at: e.dispatchedAt?.toISOString() ?? null,
    deliveries: e.deliveries.map(webhookDeliveryResource),
  };
}
