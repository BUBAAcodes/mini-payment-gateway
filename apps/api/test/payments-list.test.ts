import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { testPrisma } from '@gateway/db/testing';
import { merchantWithKey, newCheckoutOrder, testApp } from './helpers';

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(() => {
  db = testPrisma();
  app = testApp(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  merchant = await merchantWithKey(db);
});

async function pay(vpa = 'success@test', apiKey = merchant.apiKey.key): Promise<string> {
  const order = await newCheckoutOrder(app, apiKey);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa });
  expect(res.status).toBe(201);
  return res.body.id;
}

function get(path: string, query: object = {}, apiKey = merchant.apiKey.key) {
  return request(app).get(path).query(query).set('Authorization', `Bearer ${apiKey}`);
}

const ids = (res: request.Response) => res.body.data.map((p: { id: string }) => p.id);

describe('GET /v1/payments', () => {
  it('lists payments newest first, a page at a time', async () => {
    const first = await pay();
    const second = await pay('fail@test');
    const third = await pay();

    const page = await get('/v1/payments', { limit: 2 });
    expect(page.status).toBe(200);
    expect(page.body.has_more).toBe(true);
    expect(ids(page)).toEqual([third, second]);
    expect(page.body.data[0]).toMatchObject({ id: third, status: 'captured', fee: 1_000 });

    const next = await get('/v1/payments', { limit: 2, starting_after: second });
    expect(next.body).toMatchObject({ has_more: false });
    expect(ids(next)).toEqual([first]);
  });

  it('filters by status', async () => {
    await pay();
    const failed = await pay('fail@test');

    const res = await get('/v1/payments', { status: 'failed' });
    expect(ids(res)).toEqual([failed]);
  });

  it('filters by creation time: from included, to excluded', async () => {
    const [a, b, c] = [await pay(), await pay(), await pay()];
    const at = (id: string, iso: string) =>
      db.payment.update({ where: { id }, data: { createdAt: new Date(iso) } });
    await at(a, '2026-01-01T00:00:00Z');
    await at(b, '2026-01-02T00:00:00Z');
    await at(c, '2026-01-03T00:00:00Z');

    const res = await get('/v1/payments', {
      from: '2026-01-02T00:00:00Z',
      to: '2026-01-03T00:00:00Z',
    });
    expect(ids(res)).toEqual([b]);
  });

  it("never lists another merchant's payments", async () => {
    await pay();
    const other = await merchantWithKey(db);

    const res = await get('/v1/payments', {}, other.apiKey.key);
    expect(res.body).toEqual({ data: [], has_more: false });
  });

  it.each([
    ['an unknown status', { status: 'paid' }, 'status'],
    ['a date without a time', { from: '2026-01-02' }, 'from'],
    ['to before from', { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }, 'to'],
    ['an unknown starting_after', { starting_after: 'pay_nope' }, 'starting_after'],
  ])('rejects %s', async (_name, query, field) => {
    const res = await get('/v1/payments', query);
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe(field);
  });
});

describe('GET /v1/balance', () => {
  it('is what we owe the merchant, from the ledger, and goes negative after a refund', async () => {
    expect((await get('/v1/balance')).body).toEqual({ balance: 0, currency: 'INR' });

    const payment = await pay();
    expect((await get('/v1/balance')).body).toEqual({ balance: 49_000, currency: 'INR' });

    const refund = await request(app)
      .post(`/v1/payments/${payment}/refunds`)
      .set('Authorization', `Bearer ${merchant.apiKey.key}`)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(refund.body.status).toBe('processed');
    // The fee isn't returned on refunds (decision 0001).
    expect((await get('/v1/balance')).body).toEqual({ balance: -1_000, currency: 'INR' });
  });

  it("shows only the caller's own balance", async () => {
    await pay();
    const other = await merchantWithKey(db);
    expect((await get('/v1/balance', {}, other.apiKey.key)).body.balance).toBe(0);
  });
});
