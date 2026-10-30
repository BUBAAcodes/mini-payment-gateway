import type { Logger } from 'pino';
import { Prisma, type Order, type Payment, type PrismaClient } from '@gateway/db';
import {
  ConflictError,
  InvalidStateError,
  NotFoundError,
  cardLast4,
  cardNetwork,
  constantTimeEqual,
  decryptSecret,
  isId,
  newId,
  sha256Hex,
  signCheckoutRedirect,
  type PayOrderInput,
} from '@gateway/shared';
import { moveTo } from './payment-state';
import { authorizeWithBank, type PaymentDeps } from './payments';

/** What the checkout routes need: moving payments, plus the key that signs redirects. */
export interface CheckoutDeps extends PaymentDeps {
  /** APP_ENCRYPTION_KEY: decrypts each merchant's checkout signing secret. */
  encryptionKey: string;
}

// The checkout page's side of the API. Callers prove they may see an order with its client secret
// (cs_...), which only the merchant's checkout URL carries. A wrong secret gets "not found", the
// same as a wrong ID, so neither can be probed.

/** True if `cs` is this order's client secret. Compared as SHA-256 hashes, in constant time. */
function hasClientSecret(order: Pick<Order, 'clientSecretHash'>, cs: string | undefined): boolean {
  return cs !== undefined && constantTimeEqual(sha256Hex(cs), order.clientSecretHash);
}

export interface CheckoutOrder {
  order: Order;
  merchantName: string;
  /** The newest attempt, so a refreshed page can pick up where it left off (e.g. at the OTP). */
  latestPayment: Payment | null;
}

export async function getCheckoutOrder(
  db: PrismaClient,
  orderId: string,
  cs: string | undefined,
): Promise<CheckoutOrder> {
  const order = isId('order', orderId)
    ? await db.order.findUnique({
        where: { id: orderId },
        include: {
          merchant: { select: { name: true } },
          payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
        },
      })
    : null;
  if (!order || !hasClientSecret(order, cs)) throw new NotFoundError('Order');
  return { order, merchantName: order.merchant.name, latestPayment: order.payments[0] ?? null };
}

export async function getCheckoutPayment(
  db: PrismaClient,
  paymentId: string,
  cs: string | undefined,
): Promise<Payment> {
  const payment = isId('pay', paymentId)
    ? await db.payment.findUnique({
        where: { id: paymentId },
        include: { order: { select: { clientSecretHash: true } } },
      })
    : null;
  if (!payment || !hasClientSecret(payment.order, cs)) throw new NotFoundError('Payment');
  return payment;
}

/**
 * Starts a payment attempt (section 9.1, step 3). One transaction locks the order, checks it isn't
 * paid, creates the payment and marks the order attempted. If another attempt is still in
 * progress, the one_active_attempt index turns this one away (rule 5).
 *
 * A UPI payment is committed as pending before the bank call, so if we crash during the call the
 * status-check job still finds it. A card payment stops at otp_required until submitOtp.
 */
export async function startPayment(
  deps: PaymentDeps,
  orderId: string,
  cs: string | undefined,
  input: PayOrderInput,
  log: Logger,
): Promise<Payment> {
  const payment = await deps.db.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order || !hasClientSecret(order, cs)) throw new NotFoundError('Order');
    if (order.status === 'paid') throw new InvalidStateError('This order is already paid');

    const created = await createAttempt(tx, order, input);
    await tx.order.updateMany({
      where: { id: order.id, status: 'created' },
      data: { status: 'attempted' },
    });
    return moveTo(tx, created, input.method === 'card' ? 'otp_required' : 'pending');
  });

  return payment.status === 'pending' ? authorizeWithBank(deps, payment, log) : payment;
}

/**
 * The OTP for a card payment. It goes to the bank with the card's last four digits. If two OTPs
 * arrive at once, only one moves the payment to pending; the other gets invalid_state.
 */
export async function submitOtp(
  deps: PaymentDeps,
  paymentId: string,
  cs: string | undefined,
  otp: string,
  log: Logger,
): Promise<Payment> {
  const payment = await getCheckoutPayment(deps.db, paymentId, cs);
  if (payment.status !== 'otp_required') {
    throw new InvalidStateError('This payment is not waiting for an OTP');
  }
  const pending = await moveTo(deps.db, payment, 'pending');
  return authorizeWithBank(deps, pending, log, otp);
}

/**
 * Where checkout sends the customer once an attempt is over (section 9.1, step 9): the order's
 * callback_url plus order_id, payment_id, status and signature. Null while the payment is still in
 * progress, or if the merchant gave no callback_url. The API builds it, not the web app, because
 * only the API can decrypt the merchant's checkout signing secret.
 */
export async function callbackRedirectUrl(
  db: PrismaClient,
  payment: Payment,
  encryptionKey: string,
): Promise<string | null> {
  if (payment.status !== 'captured' && payment.status !== 'failed') return null;
  const order = await db.order.findUniqueOrThrow({
    where: { id: payment.orderId },
    select: { callbackUrl: true, merchant: { select: { checkoutSigningSecret: true } } },
  });
  if (!order.callbackUrl) return null;

  const secret = decryptSecret(order.merchant.checkoutSigningSecret, encryptionKey);
  // searchParams keeps any query string the merchant already put in its callback_url.
  const url = new URL(order.callbackUrl);
  url.searchParams.set('order_id', payment.orderId);
  url.searchParams.set('payment_id', payment.id);
  url.searchParams.set('status', payment.status);
  url.searchParams.set('signature', signCheckoutRedirect(payment.orderId, payment.id, secret));
  return url.toString();
}

/** SELECT … FOR UPDATE: pay attempts on one order wait for each other instead of racing. */
async function lockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<Order | null> {
  if (!isId('order', orderId)) return null;
  await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${orderId} FOR UPDATE`;
  return tx.order.findUnique({ where: { id: orderId } });
}

/** A new payment in `created`. The full card number stops here: only last4 and network are kept. */
async function createAttempt(
  tx: Prisma.TransactionClient,
  order: Order,
  input: PayOrderInput,
): Promise<Payment> {
  const method =
    input.method === 'upi'
      ? { method: input.method, vpa: input.vpa }
      : {
          method: input.method,
          cardLast4: cardLast4(input.card.number),
          cardNetwork: cardNetwork(input.card.number),
        };
  try {
    return await tx.payment.create({
      data: {
        id: newId('pay'),
        merchantId: order.merchantId,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        ...method,
      },
    });
  } catch (err) {
    // P2002 on one_active_attempt: another attempt for this order is still in progress.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('Another payment attempt for this order is in progress');
    }
    throw err;
  }
}

/** What the checkout page sees of an order. */
export function checkoutOrderResource({ order, merchantName, latestPayment }: CheckoutOrder) {
  return {
    id: order.id,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    merchant_name: merchantName,
    latest_payment: latestPayment && { id: latestPayment.id, status: latestPayment.status },
  };
}

/** What the customer sees of a payment: no fee and no bank bookkeeping. */
export function checkoutPaymentResource(p: Payment) {
  return {
    id: p.id,
    order_id: p.orderId,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    vpa: p.vpa,
    card_last4: p.cardLast4,
    card_network: p.cardNetwork,
    status: p.status,
    failure_reason: p.failureReason,
  };
}
