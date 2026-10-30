import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { amountSchema } from '@gateway/shared';
import { createPrismaClient } from '@gateway/db';
import { createApp } from '../app';
import { createFakeBank } from '../fake-bank';
import { createMemoryStore } from './rate-limit';
import { validate } from './validate';

// Never queried: these routes don't touch the database, and the client connects lazily.
const db = createPrismaClient('postgresql://localhost/unused');

const app = createApp({
  db,
  checkDb: async () => {},
  bank: createFakeBank(db, { slowDelayMs: 0 }),
  rateLimit: { store: createMemoryStore() },
  config: {
    WEB_BASE_URL: 'https://web.test',
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    FEE_BPS: 200,
    BANK_TIMEOUT_MS: 1000,
    ALLOW_PRIVATE_WEBHOOK_URLS: false,
    INTERNAL_CRON_SECRET: randomBytes(32).toString('hex'),
    SETTLEMENT_DELAY_DAYS: 0,
    RATE_LIMIT_PER_MINUTE: 100,
  },
  extraRoutes: (router) => {
    router.post(
      '/orders/:id',
      validate({
        params: z.object({ id: z.string().startsWith('order_') }),
        query: z.object({ expand: z.enum(['payments']).optional() }),
        body: z.object({ amount: amountSchema, receipt: z.string().max(40) }),
      }),
      (_req, res) => {
        res.json(res.locals.validated);
      },
    );
  },
});

describe('validate middleware', () => {
  it('passes parsed input on in res.locals.validated', async () => {
    const res = await request(app)
      .post('/orders/order_1?expand=payments')
      .send({ amount: 50_000, receipt: 'rcpt_1', ignored: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      params: { id: 'order_1' },
      query: { expand: 'payments' },
      // Unknown keys are stripped by z.object.
      body: { amount: 50_000, receipt: 'rcpt_1' },
    });
  });

  it('rejects a bad body field with 400 and names the field', async () => {
    const res = await request(app).post('/orders/order_1').send({ amount: 10.5, receipt: 'r' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.field).toBe('amount');
  });

  it('rejects a missing body field', async () => {
    const res = await request(app).post('/orders/order_1').send({ amount: 50_000 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('receipt');
  });

  it('rejects bad params', async () => {
    const res = await request(app).post('/orders/pay_1').send({ amount: 50_000, receipt: 'r' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('id');
  });

  it('rejects bad query values', async () => {
    const res = await request(app)
      .post('/orders/order_1?expand=everything')
      .send({ amount: 50_000, receipt: 'r' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('expand');
  });
});
