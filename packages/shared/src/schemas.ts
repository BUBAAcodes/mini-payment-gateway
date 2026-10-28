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
