import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { paginationSchema, redeliverEventSchema, type RedeliverEventInput } from '@gateway/shared';
import type { z } from 'zod';
import type { AppConfig } from '../../config';
import { merchantIdOf } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { validate } from '../../middleware/validate';
import { webhookDeliveryResource } from '../../services/webhook-delivery';
import { eventResource, listEvents, redeliverEvent } from '../../services/webhook-events';

export function eventsRouter(db: PrismaClient, config: AppConfig): Router {
  const router = Router();

  router.get('/events', validate({ query: paginationSchema }), async (_req, res) => {
    const query = res.locals.validated.query as z.infer<typeof paginationSchema>;
    const page = await listEvents(db, merchantIdOf(res), {
      limit: query.limit,
      startingAfter: query.starting_after,
    });
    res.json({ data: page.data.map(eventResource), has_more: page.has_more });
  });

  // 202: the deliveries are queued; the sender loop sends them within seconds.
  router.post(
    '/events/:id/redeliver',
    validate({ body: redeliverEventSchema }),
    idempotent(
      db,
      config.APP_ENCRYPTION_KEY,
      async (req, res) => {
        const input = res.locals.validated.body as RedeliverEventInput;
        // Always set: it is part of the route path.
        const eventId = req.params.id as string;
        const deliveries = await redeliverEvent(db, merchantIdOf(res), eventId, {
          endpointId: input.endpoint_id,
        });
        return { status: 202, body: { data: deliveries.map(webhookDeliveryResource) } };
      },
      { optional: true },
    ),
  );

  return router;
}
