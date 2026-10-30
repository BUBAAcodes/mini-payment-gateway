import type { Event, Prisma } from '@gateway/db';
import { newId, type WebhookEventType } from '@gateway/shared';

/**
 * Adds an event to the outbox (the events table). Call it inside the transaction that makes the
 * change it describes (rule 4), so the event exists exactly when the change does. The webhook
 * worker sends it later, wrapped as { id, type, created_at, data: { object } }.
 * Pass `dispatchedAt` when the caller creates the deliveries itself (a test ping), so the fan-out
 * loop leaves the event alone.
 */
export function recordEvent(
  tx: Prisma.TransactionClient,
  merchantId: string,
  type: WebhookEventType,
  object: Prisma.InputJsonObject,
  { dispatchedAt }: { dispatchedAt?: Date } = {},
): Promise<Event> {
  return tx.event.create({
    data: { id: newId('evt'), merchantId, type, payload: { object }, dispatchedAt },
  });
}
