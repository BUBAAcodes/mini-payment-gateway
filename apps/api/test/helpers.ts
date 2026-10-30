import { randomBytes, randomUUID } from 'node:crypto';
import type { Express, Router } from 'express';
import request from 'supertest';
import type { PrismaClient } from '@gateway/db';
import { createMerchant } from '@gateway/db/testing';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { createFakeBank, type BankClient } from '../src/fake-bank';
import { createApiKey } from '../src/services/api-keys';

export const testConfig: AppConfig = {
  WEB_BASE_URL: 'https://web.test',
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  FEE_BPS: 200,
  // Short, so slow@test times out quickly. Every other fake bank answer in tests takes 0 ms.
  BANK_TIMEOUT_MS: 200,
  // Test webhook receivers listen on 127.0.0.1. Tests of the SSRF checks turn this off.
  ALLOW_PRIVATE_WEBHOOK_URLS: true,
  INTERNAL_CRON_SECRET: randomBytes(32).toString('hex'),
  SETTLEMENT_DELAY_DAYS: 0,
};

export interface TestAppOptions {
  /** Defaults to a fake bank that answers at once, except slow@test, which outlasts our timeout. */
  bank?: BankClient;
  /** Mounts more routes before the 404 handler. */
  extraRoutes?: (router: Router) => void;
  /** Overrides testConfig. The encryption key stays shared, so apps can read each other's data. */
  config?: Partial<AppConfig>;
}

/** The real app wired to the test database. */
export function testApp(db: PrismaClient, { bank, extraRoutes, config }: TestAppOptions = {}) {
  return createApp({
    db,
    checkDb: async () => {},
    bank: bank ?? createFakeBank(db, { normalDelayMs: 0, slowDelayMs: 60_000 }),
    config: { ...testConfig, ...config },
    extraRoutes,
  });
}

/** A fresh merchant and a working API key for it. */
export async function merchantWithKey(db: PrismaClient) {
  const merchant = await createMerchant(db);
  const apiKey = await createApiKey(db, merchant.id);
  return { merchant, apiKey };
}

export interface CheckoutOrder {
  id: string;
  /** The order's client secret: what the checkout page gets in ?cs=. */
  cs: string;
}

/** Creates an order through the merchant API, as a merchant's server would. */
export async function newCheckoutOrder(
  app: Express,
  apiKey: string,
  body: object = {},
): Promise<CheckoutOrder> {
  const res = await request(app)
    .post('/v1/orders')
    .set('Authorization', `Bearer ${apiKey}`)
    .set('Idempotency-Key', randomUUID())
    .send({ amount: 50_000, ...body });
  if (res.status !== 201) {
    throw new Error(`Creating an order failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id, cs: res.body.client_secret };
}
