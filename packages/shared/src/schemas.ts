import { z } from 'zod';
import { isCardExpired, isLuhnValid } from './cards';
import { MAX_AMOUNT, MIN_AMOUNT } from './money';
import { isId, type IdPrefix } from './ids';

export const amountSchema = z.number().int().min(MIN_AMOUNT).max(MAX_AMOUNT);

export const currencySchema = z.literal('INR');

export function idSchema(prefix: IdPrefix) {
  return z.string().refine((value) => isId(prefix, value), { message: `Must be a ${prefix}_ ID` });
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().optional(),
});

/** GET /v1/payments: optional filters on status and creation time ([from, to)), plus a page. */
export const listPaymentsSchema = paginationSchema
  .extend({
    status: z
      .enum(['created', 'otp_required', 'pending', 'authorized', 'captured', 'failed', 'refunded'])
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), {
    message: 'from must be before to',
    path: ['to'],
  });

export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;

const httpUrlSchema = z
  .url({ protocol: /^https?$/, error: 'Must be an http or https URL' })
  .max(2048);

/** Key-value pairs the merchant attaches to an order. Flat, so they stay easy to show and search. */
export const notesSchema = z
  .record(z.string().max(40), z.union([z.string().max(256), z.number(), z.boolean()]))
  .refine((notes) => Object.keys(notes).length <= 15, 'At most 15 notes');

/** POST /v1/orders. Strict, so a typo such as `callbackUrl` fails instead of being dropped. */
export const createOrderSchema = z.strictObject({
  amount: amountSchema,
  currency: currencySchema.default('INR'),
  receipt: z.string().max(40).optional(),
  callback_url: httpUrlSchema.optional(),
  notes: notesSchema.optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** A UPI ID (VPA): name@handle, e.g. success@test. */
const vpaSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^[\w.-]+@[\w.-]+$/, 'Must be a UPI ID like name@bank');

/**
 * Card details as typed on the checkout page. The full number lives only in this request: callers
 * keep cardLast4() and cardNetwork() and drop the rest (rule 9). Error messages never repeat it.
 */
const cardSchema = z
  .strictObject({
    number: z
      .string()
      .transform((number) => number.replace(/[\s-]/g, ''))
      .refine(isLuhnValid, 'Card number is not valid'),
    expiry_month: z.number().int().min(1).max(12),
    expiry_year: z.number().int().min(2000).max(2100),
    name: z.string().trim().min(1).max(100),
  })
  .refine((card) => !isCardExpired(card.expiry_month, card.expiry_year), {
    message: 'Card has expired',
    path: ['expiry_year'],
  });

/** POST /checkout/orders/:id/pay. */
export const payOrderSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('upi'), vpa: vpaSchema }),
  z.strictObject({ method: z.literal('card'), card: cardSchema }),
]);

export type PayOrderInput = z.infer<typeof payOrderSchema>;

/**
 * POST /v1/payments/:id/refunds. Without an amount, the refund is for whatever is left. Any whole
 * number of paise is allowed: the ₹1 minimum is for orders, not partial refunds.
 */
export const createRefundSchema = z.strictObject({
  amount: z.number().int().min(1).max(MAX_AMOUNT).optional(),
});

export type CreateRefundInput = z.infer<typeof createRefundSchema>;

/** POST /checkout/payments/:id/otp. Any short code goes to the bank, which says if it's right. */
export const submitOtpSchema = z.strictObject({
  otp: z.string().min(1).max(12),
});

/** Every event type we send. Endpoints subscribe to some of them, or to all with "*". */
export const WEBHOOK_EVENT_TYPES = [
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
  'settlement.processed',
  'ping',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** POST /v1/webhook_endpoints. event_types is a list of types, or exactly ["*"] for all of them. */
export const createWebhookEndpointSchema = z.strictObject({
  url: httpUrlSchema,
  event_types: z
    .union([
      z.tuple([z.literal('*')]),
      z
        .array(z.enum(WEBHOOK_EVENT_TYPES))
        .min(1)
        .transform((types) => [...new Set(types)]),
    ])
    .default(['*']),
});

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

/**
 * POST /v1/events/:id/redeliver. Without endpoint_id, the event goes again to every live endpoint
 * that got it before.
 */
export const redeliverEventSchema = z.strictObject({
  endpoint_id: idSchema('we').optional(),
});

export type RedeliverEventInput = z.infer<typeof redeliverEventSchema>;

/** A calendar date like 2026-10-29. Rejects dates that don't exist, such as 2026-02-30. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-10-29')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Must be a date that exists');

/**
 * POST /internal/reconcile. Without bank_date, reconciles every day since the last import through
 * yesterday (India time).
 */
export const reconcileSchema = z.strictObject({
  bank_date: dateSchema.optional(),
});

export type ReconcileInput = z.infer<typeof reconcileSchema>;

/** GET /dashboard/reconciliation_issues: open, resolved, or (no filter) both. */
export const listReconciliationIssuesSchema = paginationSchema.extend({
  status: z.enum(['open', 'resolved']).optional(),
});

export type ListReconciliationIssuesInput = z.infer<typeof listReconciliationIssuesSchema>;
