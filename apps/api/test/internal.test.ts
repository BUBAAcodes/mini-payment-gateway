import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { isolatedTestPrisma } from '@gateway/db/testing';
import { istDate } from '../src/fake-bank/settlement-file';
import { settleMerchant } from '../src/services/settlements';
import { merchantWithKey, newCheckoutOrder, testApp, testConfig } from './helpers';

const HOUR = 60 * 60_000;
const SECRET = testConfig.INTERNAL_CRON_SECRET;

// A database of this file's own: the internal jobs work across every merchant.
let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = await isolatedTestPrisma();
  app = testApp(db);
  merchant = await merchantWithKey(db);
});

afterAll(async () => {
  await db.$disconnect();
});

async function capturedPayment(): Promise<string> {
  const order = await newCheckoutOrder(app, merchant.apiKey.key);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa: 'success@test' });
  expect(res.body.status).toBe('captured');
  return res.body.id;
}

const internal = (path: string) =>
  request(app).post(`/internal/${path}`).set('Authorization', `Bearer ${SECRET}`);

describe('internal routes', () => {
  it.each(['settle', 'reconcile', 'cleanup'])(
    '/internal/%s needs the cron secret: missing, wrong or an API key all get 401',
    async (path) => {
      for (const authorization of [
        undefined,
        `Bearer ${SECRET.slice(0, -1)}x`,
        SECRET,
        `Bearer ${merchant.apiKey.key}`,
      ]) {
        const req = request(app).post(`/internal/${path}`);
        if (authorization) req.set('Authorization', authorization);
        const res = await req;
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('unauthorized');
      }
    },
  );

  it('POST /internal/settle pays out every merchant and returns the settlements', async () => {
    await capturedPayment();

    const res = await internal('settle');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ gross: 50_000, fees: 1_000, refunds: 0, net: 49_000 }),
    ]);
    expect(res.body.data[0].id).toMatch(/^stl_/);
  });

  it('POST /internal/reconcile reconciles the day asked for', async () => {
    await capturedPayment();
    const bankDate = istDate(new Date());

    const res = await internal('reconcile').send({ bank_date: bankDate });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ bank_date: bankDate, rows: expect.any(Number), issues_created: 0 }],
    });
    expect(res.body.data[0].rows).toBeGreaterThan(0);
  });

  it('POST /internal/reconcile with no body catches up to yesterday', async () => {
    const res = await internal('reconcile');
    expect(res.status).toBe(200);
    expect(res.body.data.at(-1).bank_date).toBe(istDate(new Date(Date.now() - 24 * HOUR)));
  });

  it('POST /internal/reconcile rejects a bad bank_date', async () => {
    for (const bank_date of ['2026-02-30', '30-10-2026', '2999-01-01']) {
      const res = await internal('reconcile').send({ bank_date });
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe('bank_date');
    }
  });

  it('POST /internal/cleanup deletes idempotency keys older than 24 hours, and only those', async () => {
    const key = (name: string, createdAt: Date) => ({
      merchantId: merchant.merchant.id,
      key: `${name}-${createdAt.getTime()}`,
      method: 'POST',
      path: '/v1/orders',
      requestHash: 'hash',
      createdAt,
    });
    const old = key('old', new Date(Date.now() - 25 * HOUR));
    const recent = key('recent', new Date(Date.now() - 23 * HOUR));
    await db.idempotencyKey.createMany({ data: [old, recent] });

    const res = await internal('cleanup');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBeGreaterThanOrEqual(1);
    const left = await db.idempotencyKey.findMany({
      where: { key: { in: [old.key, recent.key] } },
      select: { key: true },
    });
    expect(left).toEqual([{ key: recent.key }]);
  });
});

describe('GET /v1/settlements', () => {
  it("lists the merchant's settlements, newest first, a page at a time", async () => {
    const own = await merchantWithKey(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const order = await newCheckoutOrder(app, own.apiKey.key);
      await request(app)
        .post(`/checkout/orders/${order.id}/pay`)
        .query({ cs: order.cs })
        .send({ method: 'upi', vpa: 'success@test' });
      const settlement = await settleMerchant(db, own.merchant.id, {
        now: new Date(),
        delayDays: 0,
      });
      ids.push(settlement!.id);
    }
    const list = (query: object) =>
      request(app)
        .get('/v1/settlements')
        .set('Authorization', `Bearer ${own.apiKey.key}`)
        .query(query);

    const first = await list({ limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.has_more).toBe(true);
    expect(first.body.data.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1]]);
    expect(first.body.data[0]).toEqual({
      id: ids[2],
      period_start: expect.any(String),
      period_end: expect.any(String),
      gross: 50_000,
      fees: 1_000,
      refunds: 0,
      net: 49_000,
      status: 'processed',
      created_at: expect.any(String),
    });

    const second = await list({ limit: 2, starting_after: ids[1] });
    expect(second.body).toMatchObject({ has_more: false, data: [{ id: ids[0] }] });
  });

  it("never shows another merchant's settlements", async () => {
    const other = await merchantWithKey(db);
    const res = await request(app)
      .get('/v1/settlements')
      .set('Authorization', `Bearer ${other.apiKey.key}`);
    expect(res.body).toEqual({ data: [], has_more: false });
  });

  it('rejects a starting_after that is not one of its settlements', async () => {
    const res = await request(app)
      .get('/v1/settlements')
      .query({ starting_after: 'stl_nope' })
      .set('Authorization', `Bearer ${merchant.apiKey.key}`);
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('starting_after');
  });
});
