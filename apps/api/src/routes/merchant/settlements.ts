import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { paginationSchema } from '@gateway/shared';
import type { z } from 'zod';
import { merchantIdOf } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { listSettlements, settlementResource } from '../../services/settlements';

export function settlementsRouter(db: PrismaClient): Router {
  const router = Router();

  router.get('/settlements', validate({ query: paginationSchema }), async (_req, res) => {
    const query = res.locals.validated.query as z.infer<typeof paginationSchema>;
    const page = await listSettlements(db, merchantIdOf(res), {
      limit: query.limit,
      startingAfter: query.starting_after,
    });
    res.json({ data: page.data.map(settlementResource), has_more: page.has_more });
  });

  return router;
}
