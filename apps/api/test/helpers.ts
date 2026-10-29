import type { PrismaClient } from '@gateway/db';
import { createMerchant } from '@gateway/db/testing';
import { createApp } from '../src/app';
import { createApiKey } from '../src/services/api-keys';

/** The real app wired to the test database. */
export function testApp(db: PrismaClient) {
  return createApp({ db, checkDb: async () => {} });
}

/** A fresh merchant and a working API key for it. */
export async function merchantWithKey(db: PrismaClient) {
  const merchant = await createMerchant(db);
  const apiKey = await createApiKey(db, merchant.id);
  return { merchant, apiKey };
}
