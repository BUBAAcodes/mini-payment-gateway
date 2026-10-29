import type { PrismaClient } from '@gateway/db';
import {
  API_KEY_PREFIX_LENGTH,
  NotFoundError,
  constantTimeEqual,
  generateApiKey,
  newId,
  sha256Hex,
} from '@gateway/shared';

const API_KEY_FORMAT = /^sk_test_[0-9A-Za-z]{32}$/;

// Writing last_used_at on every request would cost a database write per API call.
// A minute of precision is plenty for "when was this key last used?".
const LAST_USED_PRECISION_MS = 60_000;

export interface CreatedApiKey {
  id: string;
  /** The full key. This is the only time anyone sees it. */
  key: string;
  prefix: string;
  createdAt: Date;
}

export interface ApiKeyIdentity {
  merchantId: string;
  apiKeyId: string;
}

export async function createApiKey(db: PrismaClient, merchantId: string): Promise<CreatedApiKey> {
  const { key, prefix, hash } = generateApiKey();
  const row = await db.apiKey.create({
    data: { id: newId('key'), merchantId, prefix, keyHash: hash },
  });
  return { id: row.id, key, prefix, createdAt: row.createdAt };
}

/** Revoking twice is fine and keeps the first revoked_at. Another merchant's key is "not found". */
export async function revokeApiKey(
  db: PrismaClient,
  merchantId: string,
  apiKeyId: string,
): Promise<void> {
  const { count } = await db.apiKey.updateMany({
    where: { id: apiKeyId, merchantId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count > 0) return;

  const exists = await db.apiKey.findFirst({ where: { id: apiKeyId, merchantId } });
  if (!exists) throw new NotFoundError('API key');
}

/**
 * Finds the merchant behind a raw API key, or null. The prefix finds the row; the SHA-256 of the
 * full key must then match the stored hash, compared in constant time.
 */
export async function authenticateApiKey(
  db: PrismaClient,
  rawKey: string,
): Promise<ApiKeyIdentity | null> {
  if (!API_KEY_FORMAT.test(rawKey)) return null;

  const row = await db.apiKey.findUnique({
    where: { prefix: rawKey.slice(0, API_KEY_PREFIX_LENGTH) },
  });
  if (!row || !constantTimeEqual(sha256Hex(rawKey), row.keyHash) || row.revokedAt) return null;

  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_PRECISION_MS) {
    await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } });
  }
  return { merchantId: row.merchantId, apiKeyId: row.id };
}
