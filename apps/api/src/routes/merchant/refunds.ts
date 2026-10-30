import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { createRefundSchema, type CreateRefundInput } from '@gateway/shared';
import type { AppConfig } from '../../config';
import type { BankClient } from '../../fake-bank';
import { merchantIdOf } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { validate } from '../../middleware/validate';
import { createRefund, getRefund, refundResource } from '../../services/refunds';

export function refundsRouter(db: PrismaClient, bank: BankClient, config: AppConfig): Router {
  const router = Router();
  const deps = { db, bank, bankTimeoutMs: config.BANK_TIMEOUT_MS };

  // Waits for the bank (up to BANK_TIMEOUT_MS), then answers with the refund processed, failed,
  // or still pending. 201 in every case: the refund exists either way.
  router.post(
    '/payments/:id/refunds',
    validate({ body: createRefundSchema }),
    idempotent(db, config.APP_ENCRYPTION_KEY, async (req, res) => {
      const input = res.locals.validated.body as CreateRefundInput;
      // Always set: it is part of the route path.
      const paymentId = req.params.id as string;
      const refund = await createRefund(deps, merchantIdOf(res), paymentId, input, req.log);
      return { status: 201, body: refundResource(refund) };
    }),
  );

  router.get('/refunds/:id', async (req, res) => {
    const refund = await getRefund(db, merchantIdOf(res), req.params.id);
    res.json(refundResource(refund));
  });

  return router;
}
