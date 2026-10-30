import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import type { AppConfig } from '../../config';
import { requireApiKey } from '../../middleware/auth';
import { ordersRouter } from './orders';
import { paymentsRouter } from './payments';
import { webhookEndpointsRouter } from './webhook-endpoints';

/** The merchant API under /v1. Every route here needs a valid API key. */
export function merchantRouter(db: PrismaClient, config: AppConfig): Router {
  const router = Router();
  router.use(requireApiKey(db));
  router.use(ordersRouter(db, config));
  router.use(paymentsRouter(db));
  router.use(webhookEndpointsRouter(db, config));
  return router;
}
