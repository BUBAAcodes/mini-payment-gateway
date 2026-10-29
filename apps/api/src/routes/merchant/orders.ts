import { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { createOrderSchema, type CreateOrderInput } from '@gateway/shared';
import type { AppConfig } from '../../config';
import { merchantIdOf } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { validate } from '../../middleware/validate';
import { checkoutUrl, createOrder, getOrder, orderResource } from '../../services/orders';
import { paymentResource } from '../../services/payments';

export function ordersRouter(db: PrismaClient, config: AppConfig): Router {
  const router = Router();

  router.post(
    '/orders',
    validate({ body: createOrderSchema }),
    idempotent(db, config.APP_ENCRYPTION_KEY, async (_req, res) => {
      const input = res.locals.validated.body as CreateOrderInput;
      const { order, clientSecret } = await createOrder(db, merchantIdOf(res), input);
      return {
        status: 201,
        body: {
          ...orderResource(order),
          client_secret: clientSecret,
          checkout_url: checkoutUrl(config.WEB_BASE_URL, order.id, clientSecret),
        },
      };
    }),
  );

  router.get('/orders/:id', async (req, res) => {
    const order = await getOrder(db, merchantIdOf(res), req.params.id);
    res.json({ ...orderResource(order), payments: order.payments.map(paymentResource) });
  });

  return router;
}
