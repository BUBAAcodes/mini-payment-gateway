import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { reconcileSchema, type ReconcileInput } from '@gateway/shared';
import type { AppConfig } from '../../config';
import type { BankClient } from '../../fake-bank';
import { deleteOldIdempotencyKeys } from '../../jobs/cleanup';
import { requireBearerSecret } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { reconcile } from '../../services/reconciliation';
import { settleAllMerchants, settlementResource } from '../../services/settlements';

export interface InternalRouterDeps {
  db: PrismaClient;
  /** Reconciliation fetches the bank's daily file. */
  bank: BankClient;
  config: AppConfig;
}

/**
 * The daily jobs under /internal, called by the GitHub Actions cron (cron.yml) with
 * INTERNAL_CRON_SECRET. Each one is safe to call again, so the cron can retry while the free
 * server wakes up.
 */
export function internalRouter({ db, bank, config }: InternalRouterDeps): Router {
  const router = Router();
  router.use(requireBearerSecret(config.INTERNAL_CRON_SECRET));

  router.post('/settle', async (req, res) => {
    const result = await settleAllMerchants(db, req.log, {
      delayDays: config.SETTLEMENT_DELAY_DAYS,
    });
    // A 500 makes the cron run fail visibly. Merchants that did settle stay settled, and a retry
    // only picks up the ones that failed.
    if (result.failed.length > 0) {
      throw new Error(`Settlement failed for ${result.failed.length} merchant(s)`);
    }
    res.json({ data: result.settled.map(settlementResource) });
  });

  router.post('/reconcile', validate({ body: reconcileSchema }), async (req, res) => {
    const input = res.locals.validated.body as ReconcileInput;
    const days = await reconcile({ db, bank }, { bankDate: input.bank_date });
    req.log.info({ days }, 'reconciliation finished');
    res.json({
      data: days.map((day) => ({
        bank_date: day.bankDate,
        rows: day.rows,
        issues_created: day.issuesCreated,
      })),
    });
  });

  router.post('/cleanup', async (req, res) => {
    const deleted = await deleteOldIdempotencyKeys(db);
    req.log.info({ deleted }, 'old idempotency keys deleted');
    res.json({ deleted });
  });

  return router;
}
