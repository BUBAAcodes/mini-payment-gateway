import { randomInt } from 'node:crypto';

export const ID_PREFIXES = {
  merchant: 'mer',
  apiKey: 'key',
  order: 'order',
  payment: 'pay',
  refund: 'rfnd',
  event: 'evt',
  webhookEndpoint: 'we',
  webhookDelivery: 'wd',
  settlement: 'stl',
  ledgerTransaction: 'ltx',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;

/** Cryptographically random base62 string. randomInt is unbiased, unlike byte % 62. */
export function randomBase62(length: number): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`length must be a positive integer, got ${length}`);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE62[randomInt(BASE62.length)];
  }
  return out;
}

/** A new prefixed ID, e.g. newId('pay') → "pay_8fK2mQx9LpZ3aB". */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBase62(ID_RANDOM_LENGTH)}`;
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return new RegExp(`^${prefix}_[0-9A-Za-z]{${ID_RANDOM_LENGTH}}$`).test(value);
}
