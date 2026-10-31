import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import {
  listEventsSchema,
  redeliverEventSchema,
  type ListEventsInput,
  type RedeliverEventInput,
} from '@gateway/shared';
import type { AppConfig } from '../../config';
import { merchantIdOf } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { validate } from '../../middleware/validate';
import { webhookDeliveryResource } from '../../services/webhook-delivery';
import { eventResource, listEvents, redeliverEvent } from '../../services/webhook-events';

export function eventsRouter(db: PrismaClient, config: AppConfig): Router {
  const router = Router();

  router.get('/events', validate({ query: listEventsSchema }), async (_req, res) => {
    const query = res.locals.validated.query as ListEventsInput;
    const page = await listEvents(db, merchantIdOf(res), {
      limit: query.limit,
      startingAfter: query.starting_after,
      type: query.type,
      deliveryStatus: query.delivery_status,
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
