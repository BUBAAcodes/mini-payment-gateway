import type { Logger } from 'pino';
import type { PrismaClient } from '@gateway/db';
import { applyBankAnswer, failTimedOutPayment, type PaymentDeps } from '../services/payments';

/** How often the job runs (section 9.9). */
export const STATUS_CHECK_INTERVAL_MS = 30_000;

/** A payment still without a final answer this long after it was created fails with bank_timeout. */
export const GIVE_UP_AFTER_MS = 15 * 60_000;

export interface ClaimOptions {
  /**
   * Skip payments touched more recently than this: their pay request may still be waiting on the
   * bank. A claim touches the payment, so this is also how long a claim keeps other runs away.
   */
  minAgeMs: number;
  /** The job's clock. Tests pass their own. */
  now?: () => Date;
  batchSize?: number;
}

export interface ClaimedPayment {
  id: string;
  createdAt: Date;
}

/**
 * Claims due pending payments in one statement, which commits straight away. SKIP LOCKED lets two
 * runs split the work instead of waiting on each other; bumping updated_at keeps a claimed payment
 * away from other runs for minAgeMs, which works like a lease.
 */
export async function claimPendingPayments(
  db: PrismaClient,
  { minAgeMs, now = () => new Date(), batchSize = 20 }: ClaimOptions,
): Promise<ClaimedPayment[]> {
  const at = now();
  const cutoff = new Date(at.getTime() - minAgeMs);
  const rows = await db.$queryRaw<{ id: string; created_at: Date }[]>`
    UPDATE payments
       SET bank_status_checks = bank_status_checks + 1, updated_at = ${at}
     WHERE id IN (
       SELECT id FROM payments
        WHERE status = 'pending' AND updated_at <= ${cutoff}
        ORDER BY updated_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, created_at`;
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
}

export interface StatusCheckOptions extends ClaimOptions {
  giveUpAfterMs?: number;
}

export interface StatusCheckSummary {
  checked: number;
  resolved: number;
  timedOut: number;
}

/**
 * One run of the status-check job (section 9.9). Asks the bank about each claimed payment, outside
 * any transaction (rule 11), and applies final answers through the same path as the pay request.
 * "pending" and "not_found" both mean no answer yet; after GIVE_UP_AFTER_MS the payment fails with
 * bank_timeout, and if the bank approved it after all, reconciliation flags it.
 */
export async function checkPendingPayments(
  deps: PaymentDeps,
  log: Logger,
  options: StatusCheckOptions,
): Promise<StatusCheckSummary> {
  const { now = () => new Date(), giveUpAfterMs = GIVE_UP_AFTER_MS } = options;
  const claimed = await claimPendingPayments(deps.db, { ...options, now });
  const summary: StatusCheckSummary = { checked: claimed.length, resolved: 0, timedOut: 0 };

  for (const payment of claimed) {
    try {
      const answer = await deps.bank.getStatus(payment.id);
      if (answer.status === 'approved' || answer.status === 'declined') {
        if (await applyBankAnswer(deps, payment.id, answer)) summary.resolved += 1;
      } else if (now().getTime() - payment.createdAt.getTime() >= giveUpAfterMs) {
        const bankRef = answer.status === 'pending' ? answer.bankRef : null;
        if (await failTimedOutPayment(deps, payment.id, bankRef)) summary.timedOut += 1;
      }
    } catch (err) {
      // One bad payment doesn't stop the rest. It is claimed again on a later run.
      log.error({ err, payment_id: payment.id }, 'payment status check failed');
    }
  }

  if (summary.resolved > 0 || summary.timedOut > 0) {
    log.info(summary, 'pending payments resolved');
  }
  return summary;
}
