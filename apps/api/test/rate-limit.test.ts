import { randomUUID } from 'node:crypto';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { testPrisma } from '@gateway/db/testing';
import { createLogger } from '../src/logger';
import { createRedisStore } from '../src/middleware/rate-limit';
import { createRedisClient } from '../src/redis';
import { createApiKey } from '../src/services/api-keys';
import { merchantWithKey, testApp } from './helpers';

const MINUTE = 60_000;

// A real Redis, as in production: the limiter is INCR + EXPIRE on it.
let container: StartedRedisContainer;
let redis: Redis;
let db: PrismaClient;
/** The limit from the spec: 100 requests a minute. */
let app: ReturnType<typeof testApp>;
/** The same limiter with a limit of 3, so tests don't need 100 requests each. */
let small: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;
/** The limiter's clock. Tests move it by hand instead of waiting a minute. */
let now: number;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = createRedisClient(container.getConnectionUrl(), createLogger('silent'));
  db = testPrisma();
  const rateLimit = { store: createRedisStore(redis), now: () => now };
  app = testApp(db, { rateLimit, config: { RATE_LIMIT_PER_MINUTE: 100 } });
  small = testApp(db, { rateLimit, config: { RATE_LIMIT_PER_MINUTE: 3 } });
});

afterAll(async () => {
  redis?.disconnect();
  await container?.stop().catch(() => {}); // The last test stops it already.
  await db?.$disconnect();
});

beforeEach(async () => {
  // A fresh key per test, one second into a minute: 59 seconds left in the window.
  now = 29_000_000 * MINUTE + 1_000;
  merchant = await merchantWithKey(db);
});

function balance(target = small, key = merchant.apiKey.key) {
  return request(target).get('/v1/balance').set('Authorization', `Bearer ${key}`);
}

/** Uses up the small app's 3 requests for `key`. */
async function useUpLimit(key = merchant.apiKey.key) {
  for (let i = 0; i < 3; i++) expect((await balance(small, key)).status).toBe(200);
}

describe('rate limit per API key', () => {
  it('request 101 within a minute gets a 429 with Retry-After', async () => {
    for (let i = 1; i <= 100; i++) {
      const res = await balance(app);
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('100');
      expect(res.headers['ratelimit-remaining']).toBe(String(100 - i));
      expect(res.headers['ratelimit-reset']).toBe('59');
    }

    const res = await balance(app);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Rate limit of 100 requests per minute exceeded. Retry in 59 s.',
      },
    });
    expect(res.headers['retry-after']).toBe('59');
    expect(res.headers['ratelimit-remaining']).toBe('0');
  });

  it('counts each API key on its own, even for the same merchant', async () => {
    await useUpLimit();
    expect((await balance()).status).toBe(429);

    const second = await createApiKey(db, merchant.merchant.id);
    const res = await balance(small, second.key);
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-remaining']).toBe('2');
  });

  it('starts counting again in the next minute', async () => {
    await useUpLimit();
    now += 58_000; // One second left.
    const blocked = await balance();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');

    now += 1_000;
    const res = await balance();
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-remaining']).toBe('2');
  });

  it('a 429 never reaches the route: no order and no idempotency key', async () => {
    await useUpLimit();
    const key = randomUUID();

    const res = await request(small)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${merchant.apiKey.key}`)
      .set('Idempotency-Key', key)
      .send({ amount: 50_000 });

    expect(res.status).toBe(429);
    expect(await db.order.count({ where: { merchantId: merchant.merchant.id } })).toBe(0);
    expect(
      await db.idempotencyKey.findUnique({
        where: { merchantId_key: { merchantId: merchant.merchant.id, key } },
      }),
    ).toBeNull();
  });

  it('does not limit requests without an API key: checkout and health', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(small).get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
  });

  // Last: it stops Redis.
  it('lets requests through when Redis is down (fails open), without waiting on it', async () => {
    await container.stop();

    const started = Date.now();
    for (let i = 0; i < 5; i++) {
      const res = await balance();
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
