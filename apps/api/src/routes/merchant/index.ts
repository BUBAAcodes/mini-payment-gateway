import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import type { AppConfig } from '../../config';
import type { BankClient } from '../../fake-bank';
import { requireApiKey } from '../../middleware/auth';
import { rateLimitPerApiKey, type RateLimitStore } from '../../middleware/rate-limit';
import { balanceRouter } from './balance';
import { eventsRouter } from './events';
import { ordersRouter } from './orders';
import { paymentsRouter } from './payments';
import { refundsRouter } from './refunds';
import { settlementsRouter } from './settlements';
import { webhookEndpointsRouter } from './webhook-endpoints';

export interface MerchantRouterDeps {
  db: PrismaClient;
  /** Refunds go to the bank. */
  bank: BankClient;
  config: AppConfig;
  rateLimit: RateLimitDeps;
}

export interface RateLimitDeps {
  store: RateLimitStore;
  /** The limiter's clock, in milliseconds. Tests pass their own. */
  now?: () => number;
}

/** The merchant API under /v1. Every route here needs a valid API key, and is rate limited per key. */
export function merchantRouter({ db, bank, config, rateLimit }: MerchantRouterDeps): Router {
  const router = Router();
  router.use(requireApiKey(db));
  router.use(rateLimitPerApiKey({ ...rateLimit, limit: config.RATE_LIMIT_PER_MINUTE }));
  router.use(ordersRouter(db, config));
  router.use(paymentsRouter(db));
  router.use(refundsRouter(db, bank, config));
  router.use(webhookEndpointsRouter(db, config));
  router.use(eventsRouter(db, config));
  router.use(settlementsRouter(db));
  router.use(balanceRouter(db));
  return router;
}
