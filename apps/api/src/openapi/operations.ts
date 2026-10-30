import { z } from 'zod';
import {
  balanceResponseSchema,
  checkoutOrderResponseSchema,
  checkoutPaymentWithRedirectResponseSchema,
  createOrderSchema,
  createRefundSchema,
  createWebhookEndpointSchema,
  createdOrderResponseSchema,
  createdWebhookEndpointResponseSchema,
  deletedWebhookEndpointResponseSchema,
  eventResponseSchema,
  listPaymentsSchema,
  orderWithPaymentsResponseSchema,
  pageOf,
  paginationSchema,
  payOrderSchema,
  paymentResponseSchema,
  reconcileSchema,
  redeliverEventSchema,
  refundResponseSchema,
  settlementResponseSchema,
  submitOtpSchema,
  webhookDeliveryResponseSchema,
  webhookEndpointResponseSchema,
} from '@gateway/shared';

// Every route the API serves, for the OpenAPI document. test/openapi.test.ts checks this list
// against the app's real routes, so a route added without docs fails the tests.

export type Tag = 'Merchant' | 'Checkout' | 'Internal' | 'Health';

/** apiKey: Bearer sk_test_…. clientSecret: the order's ?cs=. cronSecret: Bearer INTERNAL_CRON_SECRET. */
export type Auth = 'apiKey' | 'clientSecret' | 'cronSecret' | 'none';

export interface Operation {
  method: 'get' | 'post' | 'delete';
  /** OpenAPI style: /v1/orders/{id}. */
  path: string;
  operationId: string;
  tag: Tag;
  summary: string;
  description?: string;
  auth: Auth;
  idempotencyKey?: 'required' | 'optional';
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Status → what it means, and its JSON body. Auth, rate-limit and validation errors are added for you. */
  responses: Record<number, { description: string; schema?: z.ZodType }>;
}

const notFound = (what: string) => ({ description: `No such ${what}, or it isn't yours` });

const reconcileDaySchema = z.object({
  bank_date: z.string().meta({ example: '2026-10-29' }),
  rows: z.number().int().meta({ description: "Rows in the bank's file" }),
  issues_created: z
    .number()
    .int()
    .meta({ description: 'New issues; ones already recorded are not counted' }),
});

export const OPERATIONS: Operation[] = [
  // ---------- Merchant API ----------
  {
    method: 'post',
    path: '/v1/orders',
    operationId: 'createOrder',
    tag: 'Merchant',
    summary: 'Create an order',
    description:
      'Returns the order with its `client_secret` and the `checkout_url` to send the customer to. Retrying with the same Idempotency-Key returns the first response, with `Idempotent-Replayed: true`.',
    auth: 'apiKey',
    idempotencyKey: 'required',
    body: createOrderSchema,
    responses: {
      201: { description: 'Order created', schema: createdOrderResponseSchema },
      409: { description: 'A request with this Idempotency-Key is still in progress' },
      422: { description: 'This Idempotency-Key was used for a different request' },
    },
  },
  {
    method: 'get',
    path: '/v1/orders/{id}',
    operationId: 'getOrder',
    tag: 'Merchant',
    summary: 'Get an order, with its payment attempts',
    auth: 'apiKey',
    responses: {
      200: { description: 'The order', schema: orderWithPaymentsResponseSchema },
      404: notFound('order'),
    },
  },
  {
    method: 'get',
    path: '/v1/payments',
    operationId: 'listPayments',
    tag: 'Merchant',
    summary: 'List payments',
    description: 'Newest first. `from` is inclusive and `to` exclusive, on `created_at`.',
    auth: 'apiKey',
    query: listPaymentsSchema,
    responses: {
      200: { description: 'One page of payments', schema: pageOf(paymentResponseSchema) },
    },
  },
  {
    method: 'get',
    path: '/v1/payments/{id}',
    operationId: 'getPayment',
    tag: 'Merchant',
    summary: 'Get a payment',
    description:
      'Re-fetch the payment here before fulfilling, instead of trusting a webhook or redirect.',
    auth: 'apiKey',
    responses: {
      200: { description: 'The payment', schema: paymentResponseSchema },
      404: notFound('payment'),
    },
  },
  {
    method: 'post',
    path: '/v1/payments/{id}/refunds',
    operationId: 'createRefund',
    tag: 'Merchant',
    summary: 'Refund a captured payment, in full or in part',
    description:
      'Without an amount, refunds whatever is left. Waits for the bank, then answers with the refund `processed`, `failed`, or still `pending` (finished later by a status check). Our fee is not returned.',
    auth: 'apiKey',
    idempotencyKey: 'required',
    body: createRefundSchema,
    responses: {
      201: { description: 'Refund created', schema: refundResponseSchema },
      404: notFound('payment'),
      409: { description: 'A request with this Idempotency-Key is still in progress' },
      422: {
        description:
          'The payment is not captured, the amount is more than is left, or this Idempotency-Key was used for a different request',
      },
    },
  },
  {
    method: 'get',
    path: '/v1/refunds/{id}',
    operationId: 'getRefund',
    tag: 'Merchant',
    summary: 'Get a refund',
    auth: 'apiKey',
    responses: {
      200: { description: 'The refund', schema: refundResponseSchema },
      404: notFound('refund'),
    },
  },
  {
    method: 'post',
    path: '/v1/webhook_endpoints',
    operationId: 'createWebhookEndpoint',
    tag: 'Merchant',
    summary: 'Add a webhook endpoint',
    description: 'The signing `secret` is in this response only. Private addresses are refused.',
    auth: 'apiKey',
    idempotencyKey: 'optional',
    body: createWebhookEndpointSchema,
    responses: {
      201: { description: 'Endpoint created', schema: createdWebhookEndpointResponseSchema },
      409: { description: 'A request with this Idempotency-Key is still in progress' },
      422: { description: 'This Idempotency-Key was used for a different request' },
    },
  },
  {
    method: 'get',
    path: '/v1/webhook_endpoints',
    operationId: 'listWebhookEndpoints',
    tag: 'Merchant',
    summary: 'List webhook endpoints',
    auth: 'apiKey',
    query: paginationSchema,
    responses: {
      200: { description: 'One page of endpoints', schema: pageOf(webhookEndpointResponseSchema) },
    },
  },
  {
    method: 'delete',
    path: '/v1/webhook_endpoints/{id}',
    operationId: 'deleteWebhookEndpoint',
    tag: 'Merchant',
    summary: 'Delete a webhook endpoint',
    description: 'It gets no more deliveries. Its delivery history is kept.',
    auth: 'apiKey',
    responses: {
      200: { description: 'Deleted', schema: deletedWebhookEndpointResponseSchema },
      404: notFound('webhook endpoint'),
    },
  },
  {
    method: 'post',
    path: '/v1/webhook_endpoints/{id}/test',
    operationId: 'testWebhookEndpoint',
    tag: 'Merchant',
    summary: 'Send a ping event now',
    description: "Reports how your server answered: the delivery's status and response code.",
    auth: 'apiKey',
    responses: {
      200: { description: 'The ping delivery', schema: webhookDeliveryResponseSchema },
      404: notFound('webhook endpoint'),
    },
  },
  {
    method: 'get',
    path: '/v1/events',
    operationId: 'listEvents',
    tag: 'Merchant',
    summary: 'List events, with their webhook deliveries',
    auth: 'apiKey',
    query: paginationSchema,
    responses: { 200: { description: 'One page of events', schema: pageOf(eventResponseSchema) } },
  },
  {
    method: 'post',
    path: '/v1/events/{id}/redeliver',
    operationId: 'redeliverEvent',
    tag: 'Merchant',
    summary: 'Send an event again',
    description:
      'Queues a new delivery with the same webhook-id, to `endpoint_id` or to every live endpoint that got it before.',
    auth: 'apiKey',
    idempotencyKey: 'optional',
    body: redeliverEventSchema,
    responses: {
      202: {
        description: 'Deliveries queued',
        schema: z.object({ data: z.array(webhookDeliveryResponseSchema) }),
      },
      404: notFound('event or endpoint'),
      422: { description: 'The event has not been sent yet' },
    },
  },
  {
    method: 'get',
    path: '/v1/balance',
    operationId: 'getBalance',
    tag: 'Merchant',
    summary: 'Get your unsettled balance',
    auth: 'apiKey',
    responses: { 200: { description: 'Your balance', schema: balanceResponseSchema } },
  },
  {
    method: 'get',
    path: '/v1/settlements',
    operationId: 'listSettlements',
    tag: 'Merchant',
    summary: 'List settlements (payouts to you)',
    auth: 'apiKey',
    query: paginationSchema,
    responses: {
      200: { description: 'One page of settlements', schema: pageOf(settlementResponseSchema) },
    },
  },

  // ---------- Checkout API ----------
  {
    method: 'get',
    path: '/checkout/orders/{id}',
    operationId: 'getCheckoutOrder',
    tag: 'Checkout',
    summary: 'Get an order to pay',
    auth: 'clientSecret',
    responses: {
      200: { description: 'The order', schema: checkoutOrderResponseSchema },
      404: { description: 'No such order, or the client secret is wrong' },
    },
  },
  {
    method: 'post',
    path: '/checkout/orders/{id}/pay',
    operationId: 'payOrder',
    tag: 'Checkout',
    summary: 'Start a payment attempt',
    description:
      'UPI waits for the bank and answers `captured`, `failed` or `pending`. Cards answer `otp_required` at once. Test inputs: `success@test`, `fail@test`, `slow@test`, `lost@test`; cards ending 1111 (approve) or 0002 (decline), OTP 123456.',
    auth: 'clientSecret',
    body: payOrderSchema,
    responses: {
      201: { description: 'The attempt', schema: checkoutPaymentWithRedirectResponseSchema },
      404: { description: 'No such order, or the client secret is wrong' },
      409: { description: 'Another attempt for this order is in progress' },
      422: { description: 'The order is already paid' },
    },
  },
  {
    method: 'post',
    path: '/checkout/payments/{id}/otp',
    operationId: 'submitOtp',
    tag: 'Checkout',
    summary: "Submit a card payment's OTP",
    auth: 'clientSecret',
    body: submitOtpSchema,
    responses: {
      200: { description: 'The attempt', schema: checkoutPaymentWithRedirectResponseSchema },
      404: { description: 'No such payment, or the client secret is wrong' },
      422: { description: 'The payment is not waiting for an OTP' },
    },
  },
  {
    method: 'get',
    path: '/checkout/payments/{id}',
    operationId: 'getCheckoutPayment',
    tag: 'Checkout',
    summary: 'Get a payment attempt (polled while pending)',
    auth: 'clientSecret',
    responses: {
      200: { description: 'The attempt', schema: checkoutPaymentWithRedirectResponseSchema },
      404: { description: 'No such payment, or the client secret is wrong' },
    },
  },

  // ---------- Internal API ----------
  {
    method: 'post',
    path: '/internal/settle',
    operationId: 'settle',
    tag: 'Internal',
    summary: 'Settle every merchant',
    description:
      'Pays out each merchant whose captures minus fees minus refunds are positive. Safe to retry.',
    auth: 'cronSecret',
    responses: {
      200: {
        description: 'Settlements made',
        schema: z.object({ data: z.array(settlementResponseSchema) }),
      },
      500: { description: 'Settling some merchant failed; the rest were settled' },
    },
  },
  {
    method: 'post',
    path: '/internal/reconcile',
    operationId: 'reconcile',
    tag: 'Internal',
    summary: "Reconcile the bank's daily files",
    description:
      'Without `bank_date`, every day from the last one imported through yesterday (India time), at most 7. Safe to repeat.',
    auth: 'cronSecret',
    body: reconcileSchema,
    responses: {
      200: {
        description: 'Days reconciled',
        schema: z.object({ data: z.array(reconcileDaySchema) }),
      },
    },
  },
  {
    method: 'post',
    path: '/internal/cleanup',
    operationId: 'cleanup',
    tag: 'Internal',
    summary: 'Delete idempotency keys older than 24 hours',
    auth: 'cronSecret',
    responses: {
      200: { description: 'Keys deleted', schema: z.object({ deleted: z.number().int() }) },
    },
  },

  // ---------- Health ----------
  {
    method: 'get',
    path: '/health',
    operationId: 'health',
    tag: 'Health',
    summary: 'The process is up',
    auth: 'none',
    responses: { 200: { description: 'Up', schema: z.object({ status: z.literal('ok') }) } },
  },
  {
    method: 'get',
    path: '/ready',
    operationId: 'ready',
    tag: 'Health',
    summary: 'The database answers',
    auth: 'none',
    responses: {
      200: { description: 'Ready', schema: z.object({ status: z.literal('ready') }) },
      503: {
        description: 'The database is unreachable',
        schema: z.object({ status: z.literal('unavailable') }),
      },
    },
  },
];
