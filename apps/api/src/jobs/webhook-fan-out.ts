import type { Logger } from 'pino';
import type { PrismaClient } from '@gateway/db';
import { newId } from '@gateway/shared';
import { isSubscribed } from '../services/webhook-endpoints';

export const FAN_OUT_BATCH_SIZE = 100;

export interface FanOutOptions {
  batchSize?: number;
}

export interface FanOutSummary {
  events: number;
  deliveries: number;
}

/**
 * One fan-out pass (section 9.6, step 1), in one transaction: claims undispatched events with
 * SKIP LOCKED, creates a delivery for each live endpoint subscribed to the event's type, and marks
 * the events dispatched. A crash before the commit leaves the events undispatched for the next
 * pass, so no event is lost. SKIP LOCKED lets a second pass take other events instead of waiting.
 */
export async function fanOutEvents(
  db: PrismaClient,
  { batchSize = FAN_OUT_BATCH_SIZE }: FanOutOptions = {},
): Promise<FanOutSummary> {
  return db.$transaction(async (tx) => {
    const events = await tx.$queryRaw<{ id: string; merchant_id: string; type: string }[]>`
      SELECT id, merchant_id, type FROM events
       WHERE dispatched_at IS NULL
       ORDER BY created_at
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED`;
    if (events.length === 0) return { events: 0, deliveries: 0 };

    const endpoints = await tx.webhookEndpoint.findMany({
      where: {
        merchantId: { in: [...new Set(events.map((e) => e.merchant_id))] },
        enabled: true,
        deletedAt: null,
      },
      select: { id: true, merchantId: true, eventTypes: true },
    });
    const deliveries = events.flatMap((event) =>
      endpoints
        .filter(
          (ep) => ep.merchantId === event.merchant_id && isSubscribed(ep.eventTypes, event.type),
        )
        .map((ep) => ({ id: newId('wd'), eventId: event.id, endpointId: ep.id })),
    );

    if (deliveries.length > 0) await tx.webhookDelivery.createMany({ data: deliveries });
    await tx.event.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: { dispatchedAt: new Date() },
    });
    return { events: events.length, deliveries: deliveries.length };
  });
}

/**
 * One run of the fan-out loop: passes until a batch comes back short, so a backlog built up while
 * the server slept is cleared in one run (rule 12).
 */
export async function fanOutAllEvents(
  db: PrismaClient,
  log: Logger,
  options: FanOutOptions = {},
): Promise<FanOutSummary> {
  const { batchSize = FAN_OUT_BATCH_SIZE } = options;
  const total: FanOutSummary = { events: 0, deliveries: 0 };
  for (;;) {
    const batch = await fanOutEvents(db, options);
    total.events += batch.events;
    total.deliveries += batch.deliveries;
    if (batch.events < batchSize) break;
  }
  if (total.events > 0) log.info(total, 'events fanned out');
  return total;
}
