import type { Event, Prisma } from '@gateway/db';
import { newId } from '@gateway/shared';

export type EventType =
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.processed'
  | 'refund.failed'
  | 'settlement.processed'
  | 'ping';

/**
 * Adds an event to the outbox (the events table). Call it inside the transaction that makes the
 * change it describes (rule 4), so the event exists exactly when the change does. The webhook
 * worker sends it later, wrapped as { id, type, created_at, data: { object } }.
 */
export function recordEvent(
  tx: Prisma.TransactionClient,
  merchantId: string,
  type: EventType,
  object: Prisma.InputJsonObject,
): Promise<Event> {
  return tx.event.create({
    data: { id: newId('evt'), merchantId, type, payload: { object } },
  });
}
