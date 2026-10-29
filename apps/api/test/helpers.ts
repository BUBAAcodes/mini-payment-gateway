import { randomBytes } from 'node:crypto';
import type { Router } from 'express';
import type { PrismaClient } from '@gateway/db';
import { createMerchant } from '@gateway/db/testing';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { createApiKey } from '../src/services/api-keys';

export const testConfig: AppConfig = {
  WEB_BASE_URL: 'https://web.test',
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

/** The real app wired to the test database. */
export function testApp(db: PrismaClient, extraRoutes?: (router: Router) => void) {
  return createApp({ db, checkDb: async () => {}, config: testConfig, extraRoutes });
}

/** A fresh merchant and a working API key for it. */
export async function merchantWithKey(db: PrismaClient) {
  const merchant = await createMerchant(db);
  const apiKey = await createApiKey(db, merchant.id);
  return { merchant, apiKey };
}
