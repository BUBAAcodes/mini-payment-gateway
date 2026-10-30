import { Router, type Request } from 'express';
import type { Payment } from '@gateway/db';
import type { PayOrderInput } from '@gateway/shared';
import { payOrderSchema, submitOtpSchema } from '@gateway/shared';
import { validate } from '../../middleware/validate';
import {
  callbackRedirectUrl,
  checkoutOrderResource,
  checkoutPaymentResource,
  getCheckoutOrder,
  getCheckoutPayment,
  startPayment,
  submitOtp,
  type CheckoutDeps,
} from '../../services/checkout';

/** A route's :id. Handlers behind validate() lose Express's path-param typing, so say it here. */
type WithId = Request<{ id: string }>;

/** The order's client secret, from ?cs=. A missing or repeated one counts as wrong. */
function clientSecretOf(req: Request): string | undefined {
  return typeof req.query.cs === 'string' ? req.query.cs : undefined;
}

/** The payment as the page sees it, plus where to send the customer once the attempt is over. */
async function paymentBody(deps: CheckoutDeps, payment: Payment) {
  return {
    ...checkoutPaymentResource(payment),
    redirect_url: await callbackRedirectUrl(deps.db, payment, deps.encryptionKey),
  };
}

/**
 * The checkout API under /checkout (section 8). Only the Next.js server calls it, never the
 * browser. Every route needs the order's client secret in ?cs=.
 */
export function checkoutRouter(deps: CheckoutDeps): Router {
  const router = Router();

  router.get('/orders/:id', async (req, res) => {
    const checkout = await getCheckoutOrder(deps.db, req.params.id, clientSecretOf(req));
    res.json(checkoutOrderResource(checkout));
  });

  // Waits for the bank (up to BANK_TIMEOUT_MS), then answers captured, failed or pending.
  // Card payments answer otp_required straight away.
  router.post('/orders/:id/pay', validate({ body: payOrderSchema }), async (req: WithId, res) => {
    const input = res.locals.validated.body as PayOrderInput;
    const payment = await startPayment(deps, req.params.id, clientSecretOf(req), input, req.log);
    res.status(201).json(await paymentBody(deps, payment));
  });

  router.post(
    '/payments/:id/otp',
    validate({ body: submitOtpSchema }),
    async (req: WithId, res) => {
      const { otp } = res.locals.validated.body as { otp: string };
      const payment = await submitOtp(deps, req.params.id, clientSecretOf(req), otp, req.log);
      res.json(await paymentBody(deps, payment));
    },
  );

  // The page polls this while a payment is pending.
  router.get('/payments/:id', async (req, res) => {
    const payment = await getCheckoutPayment(deps.db, req.params.id, clientSecretOf(req));
    res.json(await paymentBody(deps, payment));
  });

  return router;
}
