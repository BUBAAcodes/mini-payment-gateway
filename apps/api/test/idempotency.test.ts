import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidStateError } from '@gateway/shared';
import type { PrismaClient } from '@gateway/db';
import { testPrisma } from '@gateway/db/testing';
import { requireApiKey } from '../src/middleware/auth';
import { idempotent, requestHash } from '../src/middleware/idempotency';
import { merchantWithKey, testApp, testConfig } from './helpers';

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let flakyCalls = 0;

beforeAll(() => {
  db = testPrisma();
  // Test-only routes, to reach outcomes the orders route can't produce on demand.
  app = testApp(db, {
    extraRoutes: (router) => {
      const key = testConfig.APP_ENCRYPTION_KEY;
      router.post(
        '/test/echo',
        requireApiKey(db),
        idempotent(db, key, async (req) => ({ status: 200, body: { echo: req.body } })),
      );
      router.post(
        '/test/invalid-state',
        requireApiKey(db),
        idempotent(db, key, async () => {
          throw new InvalidStateError('Payment is not captured');
        }),
      );
      // Crashes on the first call only, like a database blip.
      router.post(
        '/test/flaky',
        requireApiKey(db),
        idempotent(db, key, async () => {
          flakyCalls += 1;
          if (flakyCalls === 1) throw new Error('connection reset');
          return { status: 201, body: { attempt: flakyCalls } };
        }),
      );
    },
  });
});

afterAll(async () => {
  await db.$disconnect();
});

const orderBody = { amount: 50_000, currency: 'INR', receipt: 'rcpt_1001' };

function post(path: string, apiKey: string, idempotencyKey: string | undefined, body: object) {
  const req = request(app).post(path).set('Authorization', `Bearer ${apiKey}`);
  if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
}

const ordersOf = (merchantId: string) => db.order.count({ where: { merchantId } });

describe('Idempotency-Key on POST /v1/orders', () => {
  it('20 parallel requests with one key create exactly one order', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => post('/v1/orders', apiKey.key, key, orderBody)),
    );

    expect(await ordersOf(merchant.id)).toBe(1);
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);

    const created = responses.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const res of created) expect(res.body).toEqual(created[0]!.body);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(res.body.error.code).toBe('idempotency_in_progress');
    }
  });

  it('replays the stored response, client secret included, without a second order', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const first = await post('/v1/orders', apiKey.key, key, orderBody);
    const second = await post('/v1/orders', apiKey.key, key, orderBody);

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await ordersOf(merchant.id)).toBe(1);
  });

  it('treats the same fields in a different order as the same body', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const first = await post('/v1/orders', apiKey.key, key, orderBody);
    const reordered = { receipt: 'rcpt_1001', currency: 'INR', amount: 50_000 };
    const second = await post('/v1/orders', apiKey.key, key, reordered);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await ordersOf(merchant.id)).toBe(1);
  });

  it('returns 422 for the same key with a different body', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    await post('/v1/orders', apiKey.key, key, orderBody);
    const res = await post('/v1/orders', apiKey.key, key, { ...orderBody, amount: 60_000 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_mismatch');
    expect(await ordersOf(merchant.id)).toBe(1);
  });

  it('returns 422 for the same key on a different endpoint', async () => {
    const { apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    await post('/v1/orders', apiKey.key, key, orderBody);
    const res = await post('/test/echo', apiKey.key, key, orderBody);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_mismatch');
  });

  it('returns 409 while the first request with the key is still running', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();
    // What the table holds while another request is mid-flight.
    await db.idempotencyKey.create({
      data: {
        merchantId: merchant.id,
        key,
        method: 'POST',
        path: '/v1/orders',
        requestHash: requestHash(orderBody),
        state: 'in_progress',
      },
    });

    const res = await post('/v1/orders', apiKey.key, key, orderBody);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('idempotency_in_progress');
    expect(await ordersOf(merchant.id)).toBe(0);
  });

  it('stores the response encrypted, so the client secret is never at rest in plain text', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const res = await post('/v1/orders', apiKey.key, key, orderBody);
    const row = await db.idempotencyKey.findUniqueOrThrow({
      where: { merchantId_key: { merchantId: merchant.id, key } },
    });

    expect(row).toMatchObject({ state: 'completed', responseStatus: 201, method: 'POST' });
    const stored = JSON.stringify(row.responseBody);
    expect(stored).not.toContain(res.body.client_secret);
    expect(stored).not.toContain(res.body.id);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['longer than 255 characters', 'k'.repeat(256)],
    ['not printable ASCII', 'key with spaces'],
  ])('rejects an Idempotency-Key that is %s', async (_name, key) => {
    const { merchant, apiKey } = await merchantWithKey(db);

    const res = await post('/v1/orders', apiKey.key, key, orderBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error', field: 'Idempotency-Key' });
    expect(await ordersOf(merchant.id)).toBe(0);
  });

  it('does not use up the key when the body is invalid', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const bad = await post('/v1/orders', apiKey.key, key, { ...orderBody, amount: 1 });
    const good = await post('/v1/orders', apiKey.key, key, orderBody);

    expect(bad.status).toBe(400);
    expect(good.status).toBe(201);
    expect(good.headers['idempotent-replayed']).toBeUndefined();
    expect(await ordersOf(merchant.id)).toBe(1);
  });

  it('scopes keys to the merchant', async () => {
    const a = await merchantWithKey(db);
    const b = await merchantWithKey(db);
    const key = randomUUID();

    const resA = await post('/v1/orders', a.apiKey.key, key, orderBody);
    const resB = await post('/v1/orders', b.apiKey.key, key, orderBody);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resB.headers['idempotent-replayed']).toBeUndefined();
    expect(resB.body.id).not.toBe(resA.body.id);
  });
});

describe('idempotent() outcomes', () => {
  it('stores and replays an AppError, because it is a final answer', async () => {
    const { apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const first = await post('/test/invalid-state', apiKey.key, key, {});
    const second = await post('/test/invalid-state', apiKey.key, key, {});

    expect(first.status).toBe(422);
    expect(first.body.error).toEqual({ code: 'invalid_state', message: 'Payment is not captured' });
    expect(second.status).toBe(422);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });

  it('releases the key after an unexpected error, so a retry runs again', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const first = await post('/test/flaky', apiKey.key, key, {});
    expect(first.status).toBe(500);
    const afterCrash = await db.idempotencyKey.findUnique({
      where: { merchantId_key: { merchantId: merchant.id, key } },
    });
    expect(afterCrash).toBeNull();

    const retry = await post('/test/flaky', apiKey.key, key, {});
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ attempt: 2 });
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  it('replays a non-order response too', async () => {
    const { apiKey } = await merchantWithKey(db);
    const key = randomUUID();

    const first = await post('/test/echo', apiKey.key, key, { hello: 'world' });
    const second = await post('/test/echo', apiKey.key, key, { hello: 'world' });

    expect(first.body).toEqual({ echo: { hello: 'world' } });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});
