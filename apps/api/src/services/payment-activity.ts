import type { PrismaClient } from '@gateway/db';
import type { PaymentActivityResponse } from '@gateway/shared';
import { getPayment } from './payments';
import { refundResource } from './refunds';
import { eventResource } from './webhook-events';

/** Plenty for one payment: a capture, a few refunds and the odd test of the endpoint. */
const MAX_EVENTS = 50;

/**
 * Everything that happened to a payment after it was made, for the dashboard's payment page: its
 * refunds and the webhook events about it, newest first. Events point at their object only in
 * their JSON payload: a payment event's object is the payment (object.id), a refund event's is the
 * refund (object.payment_id). Scoped by merchant_id like every other query, and another merchant's
 * payment is "not found".
 */
export async function getPaymentActivity(
  db: PrismaClient,
  merchantId: string,
  paymentId: string,
): Promise<PaymentActivityResponse> {
  const payment = await getPayment(db, merchantId, paymentId);

  const [refunds, events] = await Promise.all([
    db.refund.findMany({
      where: { merchantId, paymentId: payment.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.event.findMany({
      where: {
        merchantId,
        OR: [
          { payload: { path: ['object', 'id'], equals: payment.id } },
          { payload: { path: ['object', 'payment_id'], equals: payment.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EVENTS,
      include: { deliveries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    }),
  ]);

  return { refunds: refunds.map(refundResource), events: events.map(eventResource) };
}
