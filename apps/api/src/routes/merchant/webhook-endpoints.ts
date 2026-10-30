import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import {
  createWebhookEndpointSchema,
  paginationSchema,
  type CreateWebhookEndpointInput,
} from '@gateway/shared';
import type { z } from 'zod';
import type { AppConfig } from '../../config';
import { merchantIdOf } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { validate } from '../../middleware/validate';
import { webhookDeliveryResource } from '../../services/webhook-delivery';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  sendTestWebhook,
  webhookEndpointResource,
} from '../../services/webhook-endpoints';

export function webhookEndpointsRouter(db: PrismaClient, config: AppConfig): Router {
  const router = Router();
  const options = {
    encryptionKey: config.APP_ENCRYPTION_KEY,
    allowPrivate: config.ALLOW_PRIVATE_WEBHOOK_URLS,
  };

  // The secret appears in this response only. An Idempotency-Key is optional here, but honoured
  // when sent; the stored replay is encrypted, like every stored response.
  router.post(
    '/webhook_endpoints',
    validate({ body: createWebhookEndpointSchema }),
    idempotent(
      db,
      config.APP_ENCRYPTION_KEY,
      async (_req, res) => {
        const input = res.locals.validated.body as CreateWebhookEndpointInput;
        const { endpoint, secret } = await createWebhookEndpoint(
          db,
          merchantIdOf(res),
          input,
          options,
        );
        return { status: 201, body: { ...webhookEndpointResource(endpoint), secret } };
      },
      { optional: true },
    ),
  );

  router.get('/webhook_endpoints', validate({ query: paginationSchema }), async (_req, res) => {
    const query = res.locals.validated.query as z.infer<typeof paginationSchema>;
    const page = await listWebhookEndpoints(db, merchantIdOf(res), {
      limit: query.limit,
      startingAfter: query.starting_after,
    });
    res.json({ data: page.data.map(webhookEndpointResource), has_more: page.has_more });
  });

  router.delete('/webhook_endpoints/:id', async (req, res) => {
    await deleteWebhookEndpoint(db, merchantIdOf(res), req.params.id);
    res.json({ id: req.params.id, deleted: true });
  });

  // Sends a ping now and reports how the merchant's server answered.
  router.post('/webhook_endpoints/:id/test', async (req, res) => {
    const delivery = await sendTestWebhook(db, merchantIdOf(res), req.params.id, options);
    res.json(webhookDeliveryResource(delivery));
  });

  return router;
}
