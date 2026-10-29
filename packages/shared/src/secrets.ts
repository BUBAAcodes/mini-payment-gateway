import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomBase62 } from './ids';

/** How much of an API key we store in the clear, to find its row. "sk_test_" plus 4 characters. */
export const API_KEY_PREFIX_LENGTH = 12;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Compares two strings in constant time, so an attacker can't learn a secret one byte at a time
 * from response timings. Only the length can leak, and hashes and signatures have a fixed length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on different lengths.
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface GeneratedApiKey {
  /** The full key. Show it once, then forget it. */
  key: string;
  /** Stored in the clear and unique, so a request can find its key row. */
  prefix: string;
  /** SHA-256 of the full key: the only form we store. */
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key = `sk_test_${randomBase62(32)}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LENGTH), hash: sha256Hex(key) };
}

/** Returned once when an order is created; we store only its hash. */
export function generateClientSecret(): string {
  return `cs_${randomBase62(24)}`;
}

/** Standard Webhooks format: "whsec_" plus the base64 of the signing key. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/** Signs checkout redirects. One per merchant, encrypted at rest. */
export function generateCheckoutSecret(): string {
  return randomBytes(32).toString('base64url');
}
