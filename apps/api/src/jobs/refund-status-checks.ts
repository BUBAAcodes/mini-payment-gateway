import type { Logger } from 'pino';
import type { PrismaClient, Refund } from '@gateway/db';
import { applyRefundAnswer, refundWithBank, type RefundDeps } from '../services/refunds';
import type { ClaimOptions } from './payment-status-checks';

/**
 * Claims due pending refunds in one statement, which commits straight away, the same way the
 * payment status checks claim payments: SKIP LOCKED lets two runs split the work, and bumping
 * updated_at keeps a claimed refund away from other runs for minAgeMs, like a lease.
 */
export async function claimPendingRefunds(
  db: PrismaClient,
  { minAgeMs, now = () => new Date(), batchSize = 20 }: ClaimOptions,
): Promise<Refund[]> {
  const at = now();
  const cutoff = new Date(at.getTime() - minAgeMs);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE refunds
       SET updated_at = ${at}
     WHERE id IN (
       SELECT id FROM refunds
        WHERE status = 'pending' AND updated_at <= ${cutoff}
        ORDER BY updated_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  if (rows.length === 0) return [];
  return db.refund.findMany({ where: { id: { in: rows.map((row) => row.id) } } });
}

export interface RefundCheckSummary {
  checked: number;
  /** Refunds that ended processed or failed. */
  resolved: number;
  /** Refunds the bank had never heard of, sent to it again. */
  resent: number;
}

/**
 * One run of the refund status checks: rule 10 applied to refunds. Asks the bank about each
 * claimed refund, outside any transaction (rule 11), and applies final answers the same way the
 * refund request does. A refund the bank has no record of was reserved but never reached it (the
 * server died in between), so it is sent again; the bank keys refunds on our rfnd_ ID, so this
 * can never pay out twice.
 *
 * Unlike payments, refunds never give up: failing one the bank might still pay would leave our
 * ledger wrong, and the bank decides every refund it receives.
 */
export async function checkPendingRefunds(
  deps: RefundDeps,
  log: Logger,
  options: ClaimOptions,
): Promise<RefundCheckSummary> {
  const claimed = await claimPendingRefunds(deps.db, options);
  const summary: RefundCheckSummary = { checked: claimed.length, resolved: 0, resent: 0 };

  for (const refund of claimed) {
    try {
      const answer = await deps.bank.getStatus(refund.id);
      if (answer.status === 'not_found') {
        summary.resent += 1;
        const now = await refundWithBank(deps, refund, log);
        if (now.status !== 'pending') summary.resolved += 1;
      } else if (await applyRefundAnswer(deps.db, refund.id, answer)) {
        summary.resolved += 1;
      }
    } catch (err) {
      // One bad refund doesn't stop the rest. It is claimed again on a later run.
      log.error({ err, refund_id: refund.id }, 'refund status check failed');
    }
  }

  if (summary.resolved > 0 || summary.resent > 0) {
    log.info(summary, 'pending refunds checked');
  }
  return summary;
}
