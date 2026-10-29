import { z } from 'zod';
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
