import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import type { AppConfig } from '../../config';
import type { BankClient } from '../../fake-bank';
import { requireApiKey } from '../../middleware/auth';
import { eventsRouter } from './events';
import { ordersRouter } from './orders';
import { paymentsRouter } from './payments';
import { refundsRouter } from './refunds';
import { webhookEndpointsRouter } from './webhook-endpoints';

export interface MerchantRouterDeps {
  db: PrismaClient;
  /** Refunds go to the bank. */
  bank: BankClient;
  config: AppConfig;
}

/** The merchant API under /v1. Every route here needs a valid API key. */
export function merchantRouter({ db, bank, config }: MerchantRouterDeps): Router {
  const router = Router();
  router.use(requireApiKey(db));
  router.use(ordersRouter(db, config));
  router.use(paymentsRouter(db));
  router.use(refundsRouter(db, bank, config));
  router.use(webhookEndpointsRouter(db, config));
  router.use(eventsRouter(db, config));
  return router;
}
