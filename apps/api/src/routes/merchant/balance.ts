import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import type { BalanceResponse } from '@gateway/shared';
import { merchantIdOf } from '../../middleware/auth';
import { getMerchantBalance } from '../../services/ledger';

export function balanceRouter(db: PrismaClient): Router {
  const router = Router();

  // What we owe the merchant and haven't settled yet, from the ledger. Negative when refunds
  // since the last settlement come to more than new captures (decision 0001).
  router.get('/balance', async (_req, res) => {
    const body: BalanceResponse = {
      balance: await getMerchantBalance(db, merchantIdOf(res)),
      currency: 'INR',
    };
    res.json(body);
  });

  return router;
}
