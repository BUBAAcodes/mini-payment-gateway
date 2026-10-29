import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@gateway/shared';
import type { PrismaClient } from '@gateway/db';
import { createOrder, createPayment, testPrisma } from '@gateway/db/testing';
import { revokeApiKey } from '../src/services/api-keys';
import { merchantWithKey, testApp } from './helpers';

const UNAUTHORIZED = { error: { code: 'unauthorized', message: 'Invalid or missing API key' } };

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchantA: Awaited<ReturnType<typeof merchantWithKey>>;
let merchantB: Awaited<ReturnType<typeof merchantWithKey>>;
let paymentA: Awaited<ReturnType<typeof createPayment>>;

beforeAll(async () => {
  db = testPrisma();
  app = testApp(db);
  merchantA = await merchantWithKey(db);
  merchantB = await merchantWithKey(db);
  const order = await createOrder(db, merchantA.merchant.id);
  paymentA = await createPayment(db, order);
});

afterAll(async () => {
  await db.$disconnect();
});

const getPayment = (id: string) => request(app).get(`/v1/payments/${id}`);

describe('Authorization: Bearer', () => {
  it('lets a valid key read its own payment', async () => {
    const res = await getPayment(paymentA.id).set(
      'Authorization',
      `Bearer ${merchantA.apiKey.key}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: paymentA.id,
      order_id: paymentA.orderId,
      amount: 50_000,
      amount_refunded: 0,
      currency: 'INR',
      method: 'upi',
      status: 'created',
    });
    // Internal columns stay internal.
    expect(res.body).not.toHaveProperty('merchant_id');
    expect(res.body).not.toHaveProperty('merchantId');
    expect(res.body).not.toHaveProperty('bank_status_checks');
  });

  it('records last_used_at on the key', async () => {
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: merchantA.apiKey.id } });
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['a scheme other than Bearer', () => `Basic ${merchantA.apiKey.key}`],
    ['Bearer with no key', 'Bearer '],
    ['a malformed key', 'Bearer sk_live_nope'],
    ['an unknown key', `Bearer sk_test_${'Q'.repeat(32)}`],
    [
      'the right prefix with the wrong secret part',
      () => `Bearer ${merchantA.apiKey.key.slice(0, 12)}${'x'.repeat(28)}`,
    ],
  ])('returns 401 for %s', async (_name, header) => {
    let req = getPayment(paymentA.id);
    const value = typeof header === 'function' ? header() : header;
    if (value !== undefined) req = req.set('Authorization', value);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
    expect(JSON.stringify(res.body)).not.toContain('sk_test_');
  });

  it('returns 401 for a revoked key', async () => {
    const merchant = await merchantWithKey(db);
    await revokeApiKey(db, merchant.merchant.id, merchant.apiKey.id);

    const res = await getPayment(paymentA.id).set('Authorization', `Bearer ${merchant.apiKey.key}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });
});

describe('merchant scoping', () => {
  it("returns 404 when merchant B asks for merchant A's payment", async () => {
    const res = await getPayment(paymentA.id).set(
      'Authorization',
      `Bearer ${merchantB.apiKey.key}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Payment not found' } });
  });

  it('looks exactly like a payment that does not exist', async () => {
    const auth = `Bearer ${merchantB.apiKey.key}`;
    const theirs = await getPayment(paymentA.id).set('Authorization', auth);
    const missing = await getPayment(newId('pay')).set('Authorization', auth);
    const malformed = await getPayment('not_a_payment_id').set('Authorization', auth);

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(missing.body).toEqual(theirs.body);
    expect(malformed.body).toEqual(theirs.body);
  });
});
