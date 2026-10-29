import type { Order, Payment, PrismaClient } from '@gateway/db';
import {
  NotFoundError,
  generateClientSecret,
  isId,
  newId,
  sha256Hex,
  type CreateOrderInput,
} from '@gateway/shared';

export interface CreatedOrder {
  order: Order;
  /** Lets the checkout page open this order. Only its hash is stored; this is the one copy. */
  clientSecret: string;
}

export type OrderWithPayments = Order & { payments: Payment[] };

export async function createOrder(
  db: PrismaClient,
  merchantId: string,
  input: CreateOrderInput,
): Promise<CreatedOrder> {
  const clientSecret = generateClientSecret();
  const order = await db.order.create({
    data: {
      id: newId('order'),
      merchantId,
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt ?? null,
      notes: input.notes,
      callbackUrl: input.callback_url ?? null,
      clientSecretHash: sha256Hex(clientSecret),
    },
  });
  return { order, clientSecret };
}

/** The order and its payment attempts, oldest first. Another merchant's order is "not found". */
export async function getOrder(
  db: PrismaClient,
  merchantId: string,
  orderId: string,
): Promise<OrderWithPayments> {
  const order = isId('order', orderId)
    ? await db.order.findFirst({
        where: { id: orderId, merchantId },
        include: { payments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      })
    : null;
  if (!order) throw new NotFoundError('Order');
  return order;
}

/** Where the customer pays: the web app's /pay/{orderId}, carrying the client secret. */
export function checkoutUrl(webBaseUrl: string, orderId: string, clientSecret: string): string {
  const url = new URL(`/pay/${orderId}`, webBaseUrl);
  url.searchParams.set('cs', clientSecret);
  return url.toString();
}

/** The public JSON shape of an order. The client secret hash never leaves the database. */
export function orderResource(o: Order) {
  return {
    id: o.id,
    amount: o.amount,
    currency: o.currency,
    status: o.status,
    receipt: o.receipt,
    notes: o.notes,
    callback_url: o.callbackUrl,
    paid_at: o.paidAt?.toISOString() ?? null,
    created_at: o.createdAt.toISOString(),
  };
}
