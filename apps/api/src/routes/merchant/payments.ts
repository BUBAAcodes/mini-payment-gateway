import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { listPaymentsSchema, type ListPaymentsInput } from '@gateway/shared';
import { merchantIdOf } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { getPayment, listPayments, paymentResource } from '../../services/payments';

export function paymentsRouter(db: PrismaClient): Router {
  const router = Router();

  router.get('/payments', validate({ query: listPaymentsSchema }), async (_req, res) => {
    const query = res.locals.validated.query as ListPaymentsInput;
    const page = await listPayments(db, merchantIdOf(res), query);
    res.json({ data: page.data.map(paymentResource), has_more: page.has_more });
  });

  // Merchants re-fetch this before fulfilling, instead of trusting a webhook or redirect.
  router.get('/payments/:id', async (req, res) => {
    const payment = await getPayment(db, merchantIdOf(res), req.params.id);
    res.json(paymentResource(payment));
  });

  return router;
}
