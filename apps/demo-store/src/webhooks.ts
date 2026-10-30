import { z } from 'zod';
import type { GatewayClient } from './gateway-client';
import type { OrderStore } from './order-store';

// What the store does with a webhook that has already passed the signature check (section 11,
// receiver rules). The webhook only says "something happened to pay_123". The store asks the API
// what actually happened before acting, so a stale or out-of-order event can't mislead it.

/** { id, type, created_at, data: { object } }. Only what the store reads is checked. */
export const gatewayEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.looseObject({ id: z.string().optional() }) }),
});

export type GatewayEvent = z.infer<typeof gatewayEventSchema>;

export type WebhookOutcome =
  | { action: 'fulfilled' | 'already_fulfilled' | 'marked_failed'; orderId: string }
  | { action: 'ignored'; reason: string };

export interface WebhookDeps {
  gateway: GatewayClient;
  orders: OrderStore;
  requestId?: string;
}

/**
 * Acts on one verified event. Throws if the payment can't be re-fetched; the caller answers 500 so
 * the gateway retries. Everything else ends in an outcome, so the event isn't retried forever.
 */
export async function handleGatewayWebhook(
  event: GatewayEvent,
  { gateway, orders, requestId }: WebhookDeps,
): Promise<WebhookOutcome> {
  if (event.type !== 'payment.captured' && event.type !== 'payment.failed') {
    return { action: 'ignored', reason: `${event.type} needs nothing from the store` };
  }
  const paymentId = event.data.object.id;
  if (!paymentId) return { action: 'ignored', reason: 'event has no payment ID' };

  const payment = await gateway.getPayment(paymentId, requestId);
  if (!payment) return { action: 'ignored', reason: 'payment not found' };
  const order = orders.getOrder(payment.order_id);
  if (!order) return { action: 'ignored', reason: 'not one of our orders' };

  if (event.type === 'payment.captured') {
    if (payment.status !== 'captured') {
      return { action: 'ignored', reason: `payment is ${payment.status}, not captured` };
    }
    if (payment.amount !== order.amount) {
      return { action: 'ignored', reason: 'captured amount differs from the order' };
    }
    const fulfilled = orders.fulfilOrder(order.id, payment.id);
    return { action: fulfilled ? 'fulfilled' : 'already_fulfilled', orderId: order.id };
  }

  if (payment.status !== 'failed') {
    return { action: 'ignored', reason: `payment is ${payment.status}, not failed` };
  }
  return orders.markPaymentFailed(order.id, payment.id)
    ? { action: 'marked_failed', orderId: order.id }
    : { action: 'already_fulfilled', orderId: order.id };
}
