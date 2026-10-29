import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { requireApiKey } from '../../middleware/auth';
import { paymentsRouter } from './payments';

/** The merchant API under /v1. Every route here needs a valid API key. */
export function merchantRouter(db: PrismaClient): Router {
  const router = Router();
  router.use(requireApiKey(db));
  router.use(paymentsRouter(db));
  return router;
}
