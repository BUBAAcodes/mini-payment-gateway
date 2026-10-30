import type { PrismaClient } from '@gateway/db';

/** How long an Idempotency-Key is remembered. A retry after this is a new request. */
export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60_000;

/** Deletes idempotency keys older than 24 hours (POST /internal/cleanup). Returns how many. */
export async function deleteOldIdempotencyKeys(
  db: PrismaClient,
  { now = new Date() }: { now?: Date } = {},
): Promise<number> {
  const { count } = await db.idempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_KEY_TTL_MS) } },
  });
  return count;
}
