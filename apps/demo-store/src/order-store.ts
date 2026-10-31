// The store's own records, kept in memory: a restart forgets every order and every processed
// webhook ID. Fine for a demo; a real merchant keeps these in its database (see the README).

/**
 * awaiting_payment → fulfilled, or awaiting_payment → payment_failed → fulfilled (the customer
 * retried). Nothing leaves `fulfilled`: webhooks may arrive out of order, and a late
 * payment.failed from an earlier attempt must not undo a shipped order.
 */
/** The sizes the store sells. */
export const SHIRT_SIZES = ['S', 'M', 'L', 'XL'] as const;
export type ShirtSize = (typeof SHIRT_SIZES)[number];

export type StoreOrderStatus = 'awaiting_payment' | 'payment_failed' | 'fulfilled';

export interface StoreOrder {
  /** The gateway's order ID. */
  id: string;
  /** The store's own reference, sent to the gateway as `receipt`. */
  receipt: string;
  amount: number;
  /** The T-shirt size the customer picked. */
  size: ShirtSize;
  /** Where the customer pays (or tries again after a failure). */
  checkoutUrl: string;
  status: StoreOrderStatus;
  /** The payment that fulfilled the order, or the last one that failed. */
  paymentId: string | null;
  fulfilledAt: Date | null;
  createdAt: Date;
}

export interface OrderStore {
  recordOrder(
    order: Pick<StoreOrder, 'id' | 'receipt' | 'amount' | 'size' | 'checkoutUrl'>,
  ): StoreOrder;
  getOrder(id: string): StoreOrder | undefined;
  /** True if this call fulfilled the order; false if it already was. */
  fulfilOrder(id: string, paymentId: string): boolean;
  /** True if the order moved to payment_failed; false if it was already fulfilled. */
  markPaymentFailed(id: string, paymentId: string): boolean;
  hasProcessedWebhook(webhookId: string): boolean;
  markWebhookProcessed(webhookId: string): void;
}

export function createOrderStore(): OrderStore {
  const orders = new Map<string, StoreOrder>();
  const processedWebhooks = new Set<string>();

  function mustGet(id: string): StoreOrder {
    const order = orders.get(id);
    if (!order) throw new Error(`Unknown order ${id}`);
    return order;
  }

  return {
    recordOrder(fields) {
      const order: StoreOrder = {
        ...fields,
        status: 'awaiting_payment',
        paymentId: null,
        fulfilledAt: null,
        createdAt: new Date(),
      };
      orders.set(order.id, order);
      return order;
    },

    getOrder: (id) => orders.get(id),

    fulfilOrder(id, paymentId) {
      const order = mustGet(id);
      if (order.status === 'fulfilled') return false;
      order.status = 'fulfilled';
      order.paymentId = paymentId;
      order.fulfilledAt = new Date();
      return true;
    },

    markPaymentFailed(id, paymentId) {
      const order = mustGet(id);
      if (order.status === 'fulfilled') return false;
      order.status = 'payment_failed';
      order.paymentId = paymentId;
      return true;
    },

    hasProcessedWebhook: (webhookId) => processedWebhooks.has(webhookId),
    markWebhookProcessed: (webhookId) => void processedWebhooks.add(webhookId),
  };
}
