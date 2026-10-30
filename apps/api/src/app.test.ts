import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { NotFoundError } from '@gateway/shared';
import { createPrismaClient } from '@gateway/db';
import type { Logger } from 'pino';
import { createApp } from './app';
import { createFakeBank } from './fake-bank';
import { createLogger } from './logger';

const dbUp = async () => {};
const dbDown = async () => {
  throw new Error('connect ECONNREFUSED');
};

// These tests never reach the database; the client connects lazily, so it never tries.
const db = createPrismaClient('postgresql://localhost/unused');

function testApp(checkDb = dbUp, logger?: Logger) {
  return createApp({
    db,
    checkDb,
    bank: createFakeBank(db, { slowDelayMs: 0 }),
    logger,
    config: {
      WEB_BASE_URL: 'https://web.test',
      APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      FEE_BPS: 200,
      BANK_TIMEOUT_MS: 1000,
      ALLOW_PRIVATE_WEBHOOK_URLS: false,
      INTERNAL_CRON_SECRET: randomBytes(32).toString('hex'),
      SETTLEMENT_DELAY_DAYS: 0,
    },
    // Extra routes that only exist in tests, to exercise the error handler.
    extraRoutes: (router) => {
      router.post('/echo', (req, res) => {
        res.json(req.body);
      });
      router.get('/boom', () => {
        throw new Error('secret internal detail');
      });
      router.get('/async-boom', async () => {
        throw new Error('secret async detail');
      });
      router.get('/missing', () => {
        throw new NotFoundError('Payment');
      });
    },
  });
}

describe('health', () => {
  it('GET /health returns 200', async () => {
    const res = await request(testApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 200 when the database answers', async () => {
    const res = await request(testApp(dbUp)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('GET /ready returns 503 when the database is unreachable', async () => {
    const res = await request(testApp(dbDown)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });
});

describe('request IDs', () => {
  it('generates an X-Request-Id when none is sent', async () => {
    const res = await request(testApp()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a valid incoming X-Request-Id', async () => {
    const res = await request(testApp()).get('/health').set('X-Request-Id', 'req_abc-123');
    expect(res.headers['x-request-id']).toBe('req_abc-123');
  });

  it('replaces an unsafe incoming X-Request-Id', async () => {
    const res = await request(testApp()).get('/health').set('X-Request-Id', 'bad id with spaces');
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('puts the request ID on error responses too', async () => {
    const res = await request(testApp()).get('/nope').set('X-Request-Id', 'trace-1');
    expect(res.headers['x-request-id']).toBe('trace-1');
  });
});

describe('logging', () => {
  it('never writes the checkout client secret to the logs', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => lines.push(line) });

    // An invalid order ID is refused before any database lookup.
    const res = await request(testApp(dbUp, logger)).get('/checkout/orders/nope?cs=cs_topsecret');

    expect(res.status).toBe(404);
    const logged = lines.join('');
    expect(logged).toContain('/checkout/orders/nope?cs=[redacted]');
    expect(logged).not.toContain('cs_topsecret');
  });
});

describe('errors', () => {
  it('unknown routes return 404 in the error shape', async () => {
    const res = await request(testApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
  });

  it('AppError subclasses keep their status and code', async () => {
    const res = await request(testApp()).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Payment not found' } });
  });

  it('unexpected errors return 500 without leaking the message', async () => {
    const res = await request(testApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('async errors reach the error handler (Express 5)', async () => {
    const res = await request(testApp()).get('/async-boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });

  it('malformed JSON returns 400 validation_error', async () => {
    const res = await request(testApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"amount": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('a JSON body over 100 KB returns 413', async () => {
    const res = await request(testApp())
      .post('/echo')
      .send({ big: 'x'.repeat(101 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('a JSON body under the limit is parsed', async () => {
    const res = await request(testApp()).post('/echo').send({ amount: 50_000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ amount: 50_000 });
  });
});

describe('security headers', () => {
  it('sets helmet headers and hides X-Powered-By', async () => {
    const res = await request(testApp()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
