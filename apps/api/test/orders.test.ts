import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, sha256Hex } from '@gateway/shared';
import type { PrismaClient } from '@gateway/db';
import { createPayment, testPrisma } from '@gateway/db/testing';
import { merchantWithKey, testApp } from './helpers';

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchantA: Awaited<ReturnType<typeof merchantWithKey>>;
let merchantB: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = testPrisma();
  app = testApp(db);
  merchantA = await merchantWithKey(db);
  merchantB = await merchantWithKey(db);
});

afterAll(async () => {
  await db.$disconnect();
});

const orderBody = {
  amount: 50_000,
  currency: 'INR',
  receipt: 'rcpt_1001',
  callback_url: 'https://demo-store.example/payments/callback',
  notes: { sku: 'tshirt-m' },
};

function postOrder(body: object, key = merchantA.apiKey.key) {
  return request(app)
    .post('/v1/orders')
    .set('Authorization', `Bearer ${key}`)
    .set('Idempotency-Key', randomUUID())
    .send(body);
}

function getOrder(id: string, key = merchantA.apiKey.key) {
  return request(app).get(`/v1/orders/${id}`).set('Authorization', `Bearer ${key}`);
}

describe('POST /v1/orders', () => {
  it('creates an order and returns its client secret and checkout URL once', async () => {
    const res = await postOrder(orderBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^order_[0-9A-Za-z]{14}$/),
      amount: 50_000,
      currency: 'INR',
      status: 'created',
      receipt: 'rcpt_1001',
      notes: { sku: 'tshirt-m' },
      callback_url: 'https://demo-store.example/payments/callback',
      paid_at: null,
      created_at: expect.any(String),
      client_secret: expect.stringMatching(/^cs_[0-9A-Za-z]{24}$/),
      checkout_url: expect.any(String),
    });
    expect(res.body.checkout_url).toBe(
      `https://web.test/pay/${res.body.id}?cs=${res.body.client_secret}`,
    );
  });

  it('stores only the hash of the client secret', async () => {
    const res = await postOrder(orderBody);
    const row = await db.order.findUniqueOrThrow({ where: { id: res.body.id } });

    expect(row).toMatchObject({
      merchantId: merchantA.merchant.id,
      amount: 50_000,
      status: 'created',
      clientSecretHash: sha256Hex(res.body.client_secret),
    });
    expect(JSON.stringify(row)).not.toContain(res.body.client_secret);
  });

  it('accepts a body with only an amount', async () => {
    const res = await postOrder({ amount: 100 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: 100,
      currency: 'INR',
      receipt: null,
      notes: null,
      callback_url: null,
    });
  });

  it('rejects an invalid body with 400 and names the field', async () => {
    const res = await postOrder({ ...orderBody, amount: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error', field: 'amount' });
  });

  it('requires an API key', async () => {
    const res = await request(app)
      .post('/v1/orders')
      .set('Idempotency-Key', randomUUID())
      .send(orderBody);
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/orders/:id', () => {
  it('returns the order with its payments, oldest first, and no client secret', async () => {
    const created = await postOrder(orderBody);
    const order = { id: created.body.id, merchantId: merchantA.merchant.id, amount: 50_000 };
    const failed = await createPayment(db, order, 'failed');
    const retry = await createPayment(db, order, 'created');
    // Timestamps have millisecond precision; make "oldest first" unambiguous.
    await db.payment.update({
      where: { id: failed.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const res = await getOrder(order.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, amount: 50_000, status: 'created' });
    expect(res.body).not.toHaveProperty('client_secret');
    expect(res.body).not.toHaveProperty('checkout_url');
    expect(JSON.stringify(res.body)).not.toContain('client_secret_hash');
    expect(res.body.payments.map((p: { id: string }) => p.id)).toEqual([failed.id, retry.id]);
    expect(res.body.payments[0]).toMatchObject({ order_id: order.id, status: 'failed' });
  });

  it("returns 404 for another merchant's order, a missing order and a malformed ID", async () => {
    const created = await postOrder(orderBody);

    const theirs = await getOrder(created.body.id, merchantB.apiKey.key);
    const missing = await getOrder(newId('order'), merchantB.apiKey.key);
    const malformed = await getOrder('pay_notanorder', merchantB.apiKey.key);

    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual({ error: { code: 'not_found', message: 'Order not found' } });
    expect(missing.body).toEqual(theirs.body);
    expect(malformed.body).toEqual(theirs.body);
  });
});
