import type { Payment, PrismaClient } from '@gateway/db';
import { NotFoundError, isId } from '@gateway/shared';

/**
 * Another merchant's payment is "not found", never "forbidden", so IDs can't be probed.
 * Every merchant-owned lookup follows this shape: filter by id AND merchant_id.
 */
export async function getPayment(
  db: PrismaClient,
  merchantId: string,
  paymentId: string,
): Promise<Payment> {
  const payment = isId('pay', paymentId)
    ? await db.payment.findFirst({ where: { id: paymentId, merchantId } })
    : null;
  if (!payment) throw new NotFoundError('Payment');
  return payment;
}

/** The public JSON shape of a payment. Internal columns (merchant, bank bookkeeping) stay out. */
export function paymentResource(p: Payment) {
  return {
    id: p.id,
    order_id: p.orderId,
    amount: p.amount,
    fee: p.fee,
    amount_refunded: p.amountRefunded,
    currency: p.currency,
    method: p.method,
    vpa: p.vpa,
    card_last4: p.cardLast4,
    card_network: p.cardNetwork,
    status: p.status,
    failure_reason: p.failureReason,
    authorized_at: p.authorizedAt?.toISOString() ?? null,
    captured_at: p.capturedAt?.toISOString() ?? null,
    created_at: p.createdAt.toISOString(),
  };
}
