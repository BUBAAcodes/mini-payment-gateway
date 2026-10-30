import type { Logger } from 'pino';
import type { PrismaClient } from '@gateway/db';
import {
  DELIVERY_LEASE_MS,
  attemptDelivery,
  type DeliveryOptions,
} from '../services/webhook-delivery';

/** Both webhook loops, fan-out and sender, run this often while the server is awake (section 9.6). */
export const WEBHOOK_POLL_INTERVAL_MS = 2_000;

export const SEND_BATCH_SIZE = 10;

export interface ClaimOptions {
  /** The sender's clock. Tests pass their own. */
  now?: () => Date;
  batchSize?: number;
}

/**
 * Claims due deliveries with a lease (section 9.6, step 2), in one statement that commits straight
 * away. SKIP LOCKED lets two senders split the work instead of waiting on each other; locked_until
 * keeps every other sender off a claimed delivery until the lease runs out. If a sender dies
 * mid-send, its lease expires and another sender sends the delivery again, which is why delivery
 * is at least once.
 */
export async function claimDueDeliveries(
  db: PrismaClient,
  { now = () => new Date(), batchSize = SEND_BATCH_SIZE }: ClaimOptions = {},
): Promise<string[]> {
  const at = now();
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE webhook_deliveries
       SET locked_until = ${new Date(at.getTime() + DELIVERY_LEASE_MS)}, updated_at = ${at}
     WHERE id IN (
       SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${at}
          AND (locked_until IS NULL OR locked_until < ${at})
        ORDER BY next_attempt_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows.map((row) => row.id);
}

export type SenderOptions = ClaimOptions & DeliveryOptions;

export interface SendSummary {
  attempted: number;
  succeeded: number;
}

/**
 * One run of the sender loop. Attempts each claimed batch in parallel, after the claim has
 * committed (rule 11), so the whole batch ends within one webhook timeout (15 s), well inside the
 * 30 s lease. One at a time, ten slow receivers could take 150 s; the lease would run out
 * mid-batch and another sender would send those deliveries again. Claims until a batch comes back
 * short, so a backlog built up while the server slept is cleared in one run (rule 12).
 */
export async function sendDueWebhooks(
  db: PrismaClient,
  log: Logger,
  options: SenderOptions,
): Promise<SendSummary> {
  const { batchSize = SEND_BATCH_SIZE } = options;
  const summary: SendSummary = { attempted: 0, succeeded: 0 };
  for (;;) {
    const ids = await claimDueDeliveries(db, options);
    const results = await Promise.allSettled(ids.map((id) => attemptDelivery(db, id, options)));

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        // Still leased, so it is tried again once the lease runs out.
        log.error({ err: result.reason, delivery_id: ids[i] }, 'webhook attempt crashed');
        return;
      }
      const d = result.value;
      summary.attempted += 1;
      if (d.status === 'succeeded') summary.succeeded += 1;
      log[d.status === 'succeeded' ? 'info' : 'warn'](
        {
          delivery_id: d.id,
          event_id: d.eventId,
          endpoint_id: d.endpointId,
          status: d.status,
          attempt_count: d.attemptCount,
          response_status: d.lastResponseStatus,
          error: d.lastError,
          next_attempt_at: d.status === 'pending' ? d.nextAttemptAt : undefined,
        },
        'webhook attempt',
      );
    });

    if (ids.length < batchSize) return summary;
  }
}
