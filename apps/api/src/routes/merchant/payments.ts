import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { merchantIdOf } from '../../middleware/auth';
import { getPayment, paymentResource } from '../../services/payments';

export function paymentsRouter(db: PrismaClient): Router {
  const router = Router();

  // Merchants re-fetch this before fulfilling, instead of trusting a webhook or redirect.
  router.get('/payments/:id', async (req, res) => {
    const payment = await getPayment(db, merchantIdOf(res), req.params.id);
    res.json(paymentResource(payment));
  });

  return router;
}
