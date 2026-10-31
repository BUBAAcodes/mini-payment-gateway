import { randomBytes, randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type Request } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { z } from 'zod';
import { verifyCheckoutRedirect, verifyWebhook } from '@gateway/shared';
import type { StoreConfig } from './config';
import type { GatewayClient } from './gateway-client';
import { assignRequestId } from './logger';
import { SHIRT_SIZES, type OrderStore } from './order-store';
import { PRODUCT, errorPage, orderPage, productPage } from './pages';
import { gatewayEventSchema, handleGatewayWebhook } from './webhooks';

export interface StoreDeps {
  config: Pick<
    StoreConfig,
    'STORE_BASE_URL' | 'GATEWAY_WEBHOOK_SECRET' | 'GATEWAY_CHECKOUT_SECRET'
  >;
  gateway: GatewayClient;
  orders: OrderStore;
  logger: Logger;
}

/** What checkout appends to our callback_url (section 9.1, step 9). */
const callbackQuerySchema = z.object({
  order_id: z.string().min(1).max(64),
  payment_id: z.string().min(1).max(64),
  status: z.string().max(32),
  signature: z.string().max(128),
});

/** The Buy form: just the size, M when none is picked. */
const buyFormSchema = z.object({ size: z.enum(SHIRT_SIZES).default('M') });

function requestIdOf(req: Request): string {
  return String(req.id);
}

export function createStoreApp({ config, gateway, orders, logger }: StoreDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        // CSP form-action also covers where a form's response redirects to, and POST /buy
        // redirects to the gateway's checkout on another origin. Allowing only 'self' (helmet's
        // default) would make the browser block the Buy button.
        // upgrade-insecure-requests is off because the store runs on plain http://localhost, and
        // some browsers would rewrite its own links and form to https.
        directives: { formAction: null, upgradeInsecureRequests: null },
      },
    }),
  );
  app.use(pinoHttp({ logger, genReqId: assignRequestId }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(productPage());
  });

  // Creates the gateway order, then sends the customer to the gateway's checkout page. The
  // idempotency key makes the client's retries safe: a timed-out attempt that actually worked is
  // replayed by the gateway instead of creating a second order.
  app.post('/buy', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
    const form = buyFormSchema.safeParse(req.body ?? {});
    if (!form.success) {
      return res
        .status(400)
        .type('html')
        .send(errorPage('Pick a size', `We sell sizes ${SHIRT_SIZES.join(', ')}.`));
    }
    const { size } = form.data;
    const receipt = `store_${randomBytes(6).toString('hex')}`;
    try {
      const order = await gateway.createOrder(
        {
          amount: PRODUCT.amount,
          currency: 'INR',
          receipt,
          callback_url: `${config.STORE_BASE_URL}/payments/callback`,
          notes: { size },
        },
        randomUUID(),
        requestIdOf(req),
      );
      orders.recordOrder({
        id: order.id,
        receipt,
        amount: order.amount,
        size,
        checkoutUrl: order.checkout_url,
      });
      req.log.info({ orderId: order.id, receipt }, 'order created, sending customer to checkout');
      res.redirect(303, order.checkout_url);
    } catch (err) {
      req.log.error({ err, receipt }, 'could not create the gateway order');
      res
        .status(502)
        .type('html')
        .send(
          errorPage('Checkout unavailable', 'We could not start the payment. Please try again.'),
        );
    }
  });

  // Where checkout sends the customer back. The signature proves the gateway made this link for
  // this order and payment, but `status` isn't signed: it is only passed on as a hint for which
  // message to show. Nothing is fulfilled here; that waits for the webhook and a re-fetch.
  // It answers with a redirect, never a page, so it doesn't become a history entry: pressing Back
  // on the order page goes to the shop instead of bouncing through here.
  app.get('/payments/callback', (req, res) => {
    const query = callbackQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res
        .status(400)
        .type('html')
        .send(errorPage('Invalid link', 'This payment link is missing some details.'));
    }
    const { order_id, payment_id, status, signature } = query.data;
    if (!verifyCheckoutRedirect(order_id, payment_id, signature, config.GATEWAY_CHECKOUT_SECRET)) {
      req.log.warn({ orderId: order_id, paymentId: payment_id }, 'callback signature mismatch');
      return res
        .status(400)
        .type('html')
        .send(errorPage('Invalid link', 'We could not verify this payment link.'));
    }
    const order = orders.getOrder(order_id);
    if (!order) {
      return res
        .status(404)
        .type('html')
        .send(errorPage('Order not found', `We have no order ${order_id}.`));
    }
    const orderUrl = `/orders/${encodeURIComponent(order.id)}`;
    res.redirect(303, status === 'failed' ? `${orderUrl}?payment=failed` : orderUrl);
  });

  // Webhooks are verified against the exact bytes received, so this route reads the raw body
  // (never JSON parsed and re-serialized, which could change the bytes).
  app.post(
    '/webhooks/gateway',
    express.raw({ type: () => true, limit: '100kb' }),
    async (req, res) => {
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyWebhook({ headers: req.headers, body, secret: config.GATEWAY_WEBHOOK_SECRET })) {
        req.log.warn('webhook signature or timestamp invalid');
        return res.status(400).json({ error: 'invalid_signature' });
      }
      // verifyWebhook checked webhook-id is present. It is the event ID, the same on every retry.
      const webhookId = String(req.headers['webhook-id']);
      if (orders.hasProcessedWebhook(webhookId)) {
        req.log.info({ webhookId }, 'webhook already processed, skipping');
        return res.json({ received: true, duplicate: true });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      const event = gatewayEventSchema.safeParse(parsed);
      if (!event.success) {
        return res.status(400).json({ error: 'invalid_event' });
      }

      // Throws if the payment can't be re-fetched: the error handler answers 500 and the ID stays
      // unprocessed, so the gateway's retry gets another go.
      const outcome = await handleGatewayWebhook(event.data, {
        gateway,
        orders,
        requestId: requestIdOf(req),
      });
      orders.markWebhookProcessed(webhookId);
      req.log.info({ webhookId, type: event.data.type, ...outcome }, 'webhook processed');
      res.json({ received: true });
    },
  );

  app.get('/orders/:id', (req, res) => {
    const order = orders.getOrder(req.params.id);
    if (!order) {
      return res
        .status(404)
        .type('html')
        .send(errorPage('Order not found', `We have no order ${req.params.id}.`));
    }
    res.type('html').send(orderPage(order, { checkoutSaidFailed: req.query.payment === 'failed' }));
  });

  app.use((_req, res) => {
    res.status(404).type('html').send(errorPage('Not found', 'There is no such page.'));
  });

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    // Body parser errors (too large, bad encoding) carry a 4xx status; anything else is ours.
    const status: number =
      typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    req.log.error({ err }, 'request failed');
    if (res.headersSent) return;
    res
      .status(status)
      .type('html')
      .send(errorPage('Something went wrong', 'Please try again in a moment.'));
  };
  app.use(onError);

  return app;
}
