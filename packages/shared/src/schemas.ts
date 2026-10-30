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

/** POST /checkout/payments/:id/otp. Any short code goes to the bank, which says if it's right. */
export const submitOtpSchema = z.strictObject({
  otp: z.string().min(1).max(12),
});
