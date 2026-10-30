import { z } from 'zod';
import type { ErrorCode } from './errors';
import { WEBHOOK_EVENT_TYPES } from './schemas';

// The JSON the API sends back, as Zod schemas. They feed the OpenAPI document (/docs), and the
// API's *Resource() functions use their types as return types, so the type-check fails if a
// response and its documentation drift apart. They are never used to parse at runtime.
//
// Each shape has an `id`, so the docs show it once as a named schema and refer to it everywhere.

/** An ISO 8601 timestamp in UTC, e.g. 2026-10-28T10:00:00.000Z. */
const timestamp = z.string().meta({ format: 'date-time', example: '2026-10-28T10:00:00.000Z' });

/** Paise: ₹500 is 50000. */
const paise = z.number().int().meta({ description: 'Amount in paise (₹1 = 100 paise)' });

const currency = z.string().meta({ example: 'INR' });

const ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'not_found',
  'idempotency_in_progress',
  'conflict',
  'idempotency_mismatch',
  'invalid_state',
  'rate_limited',
  'internal_error',
] as const satisfies readonly ErrorCode[];

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      field: z.string().optional().meta({ description: 'The input field that was wrong, if any' }),
    }),
  })
  .meta({ id: 'Error' });

export const paymentResponseSchema = z
  .object({
    id: z.string().meta({ example: 'pay_8fK2mQx9LpZ3aB' }),
    order_id: z.string(),
    amount: paise,
    fee: paise.nullable().meta({ description: 'Our fee, set when the payment is captured' }),
    amount_refunded: paise,
    currency,
    method: z.enum(['upi', 'card']),
    vpa: z.string().nullable(),
    card_last4: z.string().nullable(),
    card_network: z.string().nullable(),
    status: z.enum([
      'created',
      'otp_required',
      'pending',
      'authorized',
      'captured',
      'failed',
      'refunded',
    ]),
    failure_reason: z.string().nullable(),
    authorized_at: timestamp.nullable(),
    captured_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .meta({ id: 'Payment' });

export const orderResponseSchema = z
  .object({
    id: z.string().meta({ example: 'order_8fK2mQx9LpZ3aB' }),
    amount: paise,
    currency,
    status: z.enum(['created', 'attempted', 'paid']),
    receipt: z.string().nullable(),
    notes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
    callback_url: z.string().nullable(),
    paid_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .meta({ id: 'Order' });

export const createdOrderResponseSchema = orderResponseSchema
  .extend({
    client_secret: z.string().meta({ description: 'Pass to checkout as ?cs=. Shown only here.' }),
    checkout_url: z.string().meta({ description: 'Send the customer here to pay' }),
  })
  .meta({ id: 'CreatedOrder' });

export const orderWithPaymentsResponseSchema = orderResponseSchema
  .extend({ payments: z.array(paymentResponseSchema) })
  .meta({ id: 'OrderWithPayments' });

export const refundResponseSchema = z
  .object({
    id: z.string().meta({ example: 'rfnd_8fK2mQx9LpZ3aB' }),
    payment_id: z.string(),
    amount: paise,
    status: z.enum(['pending', 'processed', 'failed']),
    failure_reason: z.string().nullable(),
    processed_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .meta({ id: 'Refund' });

export const webhookEndpointResponseSchema = z
  .object({
    id: z.string().meta({ example: 'we_8fK2mQx9LpZ3aB' }),
    url: z.string(),
    event_types: z.array(z.string()).meta({ description: 'Subscribed event types, or ["*"]' }),
    enabled: z.boolean(),
    disabled_reason: z.string().nullable(),
    created_at: timestamp,
  })
  .meta({ id: 'WebhookEndpoint' });

export const createdWebhookEndpointResponseSchema = webhookEndpointResponseSchema
  .extend({
    secret: z.string().meta({ description: 'whsec_ signing secret. Shown only here.' }),
  })
  .meta({ id: 'CreatedWebhookEndpoint' });

export const deletedWebhookEndpointResponseSchema = z
  .object({ id: z.string(), deleted: z.literal(true) })
  .meta({ id: 'DeletedWebhookEndpoint' });

export const webhookDeliveryResponseSchema = z
  .object({
    id: z.string().meta({ example: 'wd_8fK2mQx9LpZ3aB' }),
    event_id: z.string(),
    endpoint_id: z.string(),
    status: z.enum(['pending', 'succeeded', 'failed']),
    attempt_count: z.number().int(),
    next_attempt_at: timestamp.nullable(),
    last_attempt_at: timestamp.nullable(),
    last_response_status: z.number().int().nullable(),
    last_response_ms: z.number().int().nullable(),
    last_error: z.string().nullable(),
    created_at: timestamp,
  })
  .meta({ id: 'WebhookDelivery' });

export const eventResponseSchema = z
  .object({
    id: z.string().meta({ example: 'evt_8fK2mQx9LpZ3aB' }),
    type: z.enum(WEBHOOK_EVENT_TYPES),
    created_at: timestamp,
    data: z
      .record(z.string(), z.unknown())
      .meta({ description: '{ object: … }: the resource as it was when the event happened' }),
    dispatched_at: timestamp.nullable(),
    deliveries: z.array(webhookDeliveryResponseSchema),
  })
  .meta({ id: 'Event' });

export const settlementResponseSchema = z
  .object({
    id: z.string().meta({ example: 'stl_8fK2mQx9LpZ3aB' }),
    period_start: timestamp,
    period_end: timestamp,
    gross: paise,
    fees: paise,
    refunds: paise,
    net: paise.meta({ description: 'Paid out: gross − fees − refunds' }),
    status: z.literal('processed'),
    created_at: timestamp,
  })
  .meta({ id: 'Settlement' });

export const balanceResponseSchema = z
  .object({
    balance: paise.meta({
      description: 'What we owe you and have not settled yet. Negative after refunds you owe us.',
    }),
    currency,
  })
  .meta({ id: 'Balance' });

export const checkoutOrderResponseSchema = z
  .object({
    id: z.string(),
    amount: paise,
    currency,
    status: z.enum(['created', 'attempted', 'paid']),
    merchant_name: z.string(),
    latest_payment: z
      .object({ id: z.string(), status: paymentResponseSchema.shape.status })
      .nullable(),
  })
  .meta({ id: 'CheckoutOrder' });

export const checkoutPaymentResponseSchema = paymentResponseSchema
  .pick({
    id: true,
    order_id: true,
    amount: true,
    currency: true,
    method: true,
    vpa: true,
    card_last4: true,
    card_network: true,
    status: true,
    failure_reason: true,
  })
  .meta({ id: 'CheckoutPayment' });

export const checkoutPaymentWithRedirectResponseSchema = checkoutPaymentResponseSchema
  .extend({
    redirect_url: z.string().nullable().meta({
      description:
        "Where to send the customer once the attempt is over: the merchant's signed callback",
    }),
  })
  .meta({ id: 'CheckoutPaymentWithRedirect' });

/** `{ data: [...], has_more }`: one page of a list. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), has_more: z.boolean() });
}

export type ErrorResponse = z.output<typeof errorResponseSchema>;
export type PaymentResponse = z.output<typeof paymentResponseSchema>;
export type OrderResponse = z.output<typeof orderResponseSchema>;
export type RefundResponse = z.output<typeof refundResponseSchema>;
export type WebhookEndpointResponse = z.output<typeof webhookEndpointResponseSchema>;
export type WebhookDeliveryResponse = z.output<typeof webhookDeliveryResponseSchema>;
export type EventResponse = z.output<typeof eventResponseSchema>;
export type SettlementResponse = z.output<typeof settlementResponseSchema>;
export type BalanceResponse = z.output<typeof balanceResponseSchema>;
export type CheckoutOrderResponse = z.output<typeof checkoutOrderResponseSchema>;
export type CheckoutPaymentResponse = z.output<typeof checkoutPaymentResponseSchema>;
