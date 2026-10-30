import type { ApiKey, Prisma, PrismaClient } from '@gateway/db';
import {
  API_KEY_PREFIX_LENGTH,
  NotFoundError,
  ValidationError,
  constantTimeEqual,
  generateApiKey,
  isId,
  newId,
  sha256Hex,
  type ApiKeyResponse,
} from '@gateway/shared';
import { olderThan, toPage, type Page } from './pagination';

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
  row: ApiKey;
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
  return { id: row.id, key, prefix, createdAt: row.createdAt, row };
}

/** Newest first, revoked keys included. `startingAfter` is the last ID of the previous page. */
export async function listApiKeys(
  db: PrismaClient,
  merchantId: string,
  { limit, startingAfter }: { limit: number; startingAfter?: string },
): Promise<Page<ApiKey>> {
  let after: Prisma.ApiKeyWhereInput = {};
  if (startingAfter !== undefined) {
    const cursor = isId('key', startingAfter)
      ? await db.apiKey.findFirst({ where: { id: startingAfter, merchantId } })
      : null;
    if (!cursor) throw new ValidationError('No such API key', 'starting_after');
    after = olderThan(cursor);
  }

  const rows = await db.apiKey.findMany({
    where: { merchantId, ...after },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit);
}

/** Revoking twice is fine and keeps the first revoked_at. Another merchant's key is "not found". */
export async function revokeApiKey(
  db: PrismaClient,
  merchantId: string,
  apiKeyId: string,
): Promise<ApiKey> {
  // Only sets revoked_at if it isn't set yet, so a second revoke changes nothing.
  await db.apiKey.updateMany({
    where: { id: apiKeyId, merchantId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const row = await db.apiKey.findFirst({ where: { id: apiKeyId, merchantId } });
  if (!row) throw new NotFoundError('API key');
  return row;
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

/** What the dashboard shows for a key: never the key itself, never its hash. */
export function apiKeyResource(k: ApiKey): ApiKeyResponse {
  return {
    id: k.id,
    prefix: k.prefix,
    last_used_at: k.lastUsedAt?.toISOString() ?? null,
    revoked_at: k.revokedAt?.toISOString() ?? null,
    created_at: k.createdAt.toISOString(),
  };
}
