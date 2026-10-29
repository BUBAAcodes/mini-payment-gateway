import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, sha256Hex } from '@gateway/shared';
import type { PrismaClient } from '@gateway/db';
import { createMerchant, testPrisma } from '@gateway/db/testing';
import { authenticateApiKey, createApiKey, revokeApiKey } from '../src/services/api-keys';

let db: PrismaClient;

beforeAll(() => {
  db = testPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('createApiKey', () => {
  it('returns the full key once and stores only its prefix and hash', async () => {
    const merchant = await createMerchant(db);
    const created = await createApiKey(db, merchant.id);

    expect(created.id).toMatch(/^key_[0-9A-Za-z]{14}$/);
    expect(created.key).toMatch(/^sk_test_[0-9A-Za-z]{32}$/);
    expect(created.prefix).toBe(created.key.slice(0, 12));

    const row = await db.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      merchantId: merchant.id,
      prefix: created.prefix,
      keyHash: sha256Hex(created.key),
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain(created.key);
  });
});

describe('authenticateApiKey', () => {
  it('finds the merchant for a valid key and records last_used_at', async () => {
    const merchant = await createMerchant(db);
    const { id, key } = await createApiKey(db, merchant.id);

    await expect(authenticateApiKey(db, key)).resolves.toEqual({
      merchantId: merchant.id,
      apiKeyId: id,
    });
    const row = await db.apiKey.findUniqueOrThrow({ where: { id } });
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it('does not write last_used_at again within a minute', async () => {
    const merchant = await createMerchant(db);
    const { id, key } = await createApiKey(db, merchant.id);
    await authenticateApiKey(db, key);
    const first = await db.apiKey.findUniqueOrThrow({ where: { id } });

    await authenticateApiKey(db, key);
    const second = await db.apiKey.findUniqueOrThrow({ where: { id } });
    expect(second.lastUsedAt).toEqual(first.lastUsedAt);
  });

  it('rejects malformed, unknown, wrong and revoked keys', async () => {
    const merchant = await createMerchant(db);
    const { id, key } = await createApiKey(db, merchant.id);
    const lastChar = key.at(-1) === 'a' ? 'b' : 'a';

    await expect(authenticateApiKey(db, 'not-a-key')).resolves.toBeNull();
    await expect(authenticateApiKey(db, `sk_test_${'Z'.repeat(32)}`)).resolves.toBeNull();
    // Same prefix (same row), wrong secret part.
    await expect(authenticateApiKey(db, key.slice(0, -1) + lastChar)).resolves.toBeNull();

    await revokeApiKey(db, merchant.id, id);
    await expect(authenticateApiKey(db, key)).resolves.toBeNull();
  });
});

describe('revokeApiKey', () => {
  it('revokes a key and keeps the first revoked_at if revoked again', async () => {
    const merchant = await createMerchant(db);
    const { id } = await createApiKey(db, merchant.id);

    await revokeApiKey(db, merchant.id, id);
    const first = await db.apiKey.findUniqueOrThrow({ where: { id } });
    expect(first.revokedAt).toBeInstanceOf(Date);

    await revokeApiKey(db, merchant.id, id);
    const second = await db.apiKey.findUniqueOrThrow({ where: { id } });
    expect(second.revokedAt).toEqual(first.revokedAt);
  });

  it("can't revoke another merchant's key", async () => {
    const owner = await createMerchant(db);
    const other = await createMerchant(db);
    const { id } = await createApiKey(db, owner.id);

    await expect(revokeApiKey(db, other.id, id)).rejects.toBeInstanceOf(NotFoundError);
    const row = await db.apiKey.findUniqueOrThrow({ where: { id } });
    expect(row.revokedAt).toBeNull();
  });

  it('throws NotFoundError for a key that does not exist', async () => {
    const merchant = await createMerchant(db);
    await expect(revokeApiKey(db, merchant.id, 'key_doesnotexist00')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
