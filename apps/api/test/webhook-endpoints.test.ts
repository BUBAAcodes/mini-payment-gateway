import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { testPrisma } from '@gateway/db/testing';
import { newId, verifyWebhook } from '@gateway/shared';
import { attemptDelivery } from '../src/services/webhook-delivery';
import { merchantWithKey, testApp, testConfig } from './helpers';

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
/** The same app with ALLOW_PRIVATE_WEBHOOK_URLS off, as when deployed. */
let strictApp: ReturnType<typeof testApp>;
let merchantA: Awaited<ReturnType<typeof merchantWithKey>>;
let merchantB: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = testPrisma();
  app = testApp(db);
  strictApp = testApp(db, { config: { ALLOW_PRIVATE_WEBHOOK_URLS: false } });
  merchantA = await merchantWithKey(db);
  merchantB = await merchantWithKey(db);
});

afterAll(async () => {
  await db.$disconnect();
});

interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: string;
}

interface Receiver {
  url: string;
  received: ReceivedWebhook[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve).closeAllConnections())),
  );
});

/** A merchant's webhook receiver on 127.0.0.1 that records requests and answers with `status`. */
async function startReceiver(
  status = 200,
  extraHeaders: Record<string, string> = {},
): Promise<Receiver> {
  const received: ReceivedWebhook[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(status, extraHeaders).end('ok');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/webhooks`, received };
}

function as(key: string) {
  return { Authorization: `Bearer ${key}` };
}

function createEndpoint(body: object, { key = merchantA.apiKey.key, target = app } = {}) {
  return request(target).post('/v1/webhook_endpoints').set(as(key)).send(body);
}

async function newEndpoint(url: string, key = merchantA.apiKey.key) {
  const res = await createEndpoint({ url }, { key });
  expect(res.status).toBe(201);
  return res.body as { id: string; secret: string };
}

function sendTest(id: string, { key = merchantA.apiKey.key, target = app } = {}) {
  return request(target).post(`/v1/webhook_endpoints/${id}/test`).set(as(key));
}

function listEndpoints(key = merchantA.apiKey.key, query = '') {
  return request(app).get(`/v1/webhook_endpoints${query}`).set(as(key));
}

describe('POST /v1/webhook_endpoints', () => {
  it('creates an endpoint and shows its secret once', async () => {
    const res = await createEndpoint({
      url: 'https://merchant.example/webhooks',
      event_types: ['payment.captured', 'refund.processed'],
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^we_[0-9A-Za-z]{14}$/),
      url: 'https://merchant.example/webhooks',
      event_types: ['payment.captured', 'refund.processed'],
      enabled: true,
      disabled_reason: null,
      created_at: expect.any(String),
      secret: expect.stringMatching(/^whsec_[A-Za-z0-9+/]{43}=$/),
    });

    // Stored encrypted, never as the secret itself.
    const row = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.secret).not.toContain(res.body.secret);
    expect(row.secret).toMatch(/^v1:/);

    // And never shown again.
    const list = await listEndpoints();
    const listed = list.body.data.find((e: { id: string }) => e.id === res.body.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('secret');
  });

  it('subscribes to every event type by default', async () => {
    const res = await createEndpoint({ url: 'https://merchant.example/all' });
    expect(res.status).toBe(201);
    expect(res.body.event_types).toEqual(['*']);
  });

  it.each([
    ['an unknown event type', { url: 'https://merchant.example/w', event_types: ['nope'] }],
    [
      '"*" mixed with other types',
      { url: 'https://merchant.example/w', event_types: ['*', 'ping'] },
    ],
    ['an unknown field', { url: 'https://merchant.example/w', secret: 'whsec_mine' }],
    ['a missing url', {}],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await createEndpoint(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('needs an API key', async () => {
    const res = await request(app)
      .post('/v1/webhook_endpoints')
      .send({ url: 'https://merchant.example/w' });
    expect(res.status).toBe(401);
  });

  it('replays the same endpoint and secret for a repeated Idempotency-Key', async () => {
    const key = randomUUID();
    const url = `https://merchant.example/idem/${key}`;
    const send = () =>
      request(app)
        .post('/v1/webhook_endpoints')
        .set(as(merchantA.apiKey.key))
        .set('Idempotency-Key', key)
        .send({ url });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await db.webhookEndpoint.count({ where: { url } })).toBe(1);
  });

  describe('SSRF checks with ALLOW_PRIVATE_WEBHOOK_URLS off', () => {
    it.each([
      'http://127.0.0.1:3001/webhooks',
      'http://10.0.0.5/webhooks',
      'http://192.168.1.20/webhooks',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:3001/webhooks',
      'http://[::1]:3001/webhooks',
    ])('rejects %s', async (url) => {
      const res = await createEndpoint({ url }, { target: strictApp });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'validation_error', field: 'url' });
      expect(await db.webhookEndpoint.count({ where: { url } })).toBe(0);
    });

    it('rejects non-http schemes', async () => {
      const res = await createEndpoint({ url: 'ftp://merchant.example/w' }, { target: strictApp });
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe('url');
    });

    it('accepts a public address', async () => {
      const res = await createEndpoint(
        { url: 'https://93.184.215.14/hooks' },
        { target: strictApp },
      );
      expect(res.status).toBe(201);
    });

    it('allows private addresses when the flag is on', async () => {
      const res = await createEndpoint({ url: 'http://127.0.0.1:3001/webhooks' });
      expect(res.status).toBe(201);
    });
  });
});

describe('GET /v1/webhook_endpoints', () => {
  it('lists only the merchant’s own endpoints, newest first, a page at a time', async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await newEndpoint(`https://merchant.example/page/${i}`, apiKey.key)).id);
    }
    await newEndpoint('https://other.example/hook', merchantB.apiKey.key);

    const first = await listEndpoints(apiKey.key, '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.has_more).toBe(true);
    expect(first.body.data.map((e: { id: string }) => e.id)).toEqual([ids[2], ids[1]]);

    const second = await listEndpoints(apiKey.key, `?limit=2&starting_after=${ids[1]}`);
    expect(second.body).toMatchObject({ has_more: false });
    expect(second.body.data.map((e: { id: string }) => e.id)).toEqual([ids[0]]);

    const rows = await db.webhookEndpoint.count({ where: { merchantId: merchant.id } });
    expect(rows).toBe(3);
  });

  it('rejects a starting_after that is not one of the merchant’s endpoints', async () => {
    const other = await newEndpoint('https://other.example/cursor', merchantB.apiKey.key);
    const res = await listEndpoints(merchantA.apiKey.key, `?starting_after=${other.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('starting_after');
  });
});

describe('DELETE /v1/webhook_endpoints/:id', () => {
  it('hides the endpoint but keeps the row and its delivery history', async () => {
    const receiver = await startReceiver();
    const endpoint = await newEndpoint(receiver.url);
    await sendTest(endpoint.id);

    const res = await request(app)
      .delete(`/v1/webhook_endpoints/${endpoint.id}`)
      .set(as(merchantA.apiKey.key));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: endpoint.id, deleted: true });

    const list = await listEndpoints();
    expect(list.body.data.map((e: { id: string }) => e.id)).not.toContain(endpoint.id);

    const row = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.enabled).toBe(false);
    expect(await db.webhookDelivery.count({ where: { endpointId: endpoint.id } })).toBe(1);

    // Gone for every other purpose.
    const again = await request(app)
      .delete(`/v1/webhook_endpoints/${endpoint.id}`)
      .set(as(merchantA.apiKey.key));
    expect(again.status).toBe(404);
    expect((await sendTest(endpoint.id)).status).toBe(404);
  });

  it('returns 404 for another merchant’s endpoint and leaves it alone', async () => {
    const endpoint = await newEndpoint('https://merchant.example/mine');
    const res = await request(app)
      .delete(`/v1/webhook_endpoints/${endpoint.id}`)
      .set(as(merchantB.apiKey.key));
    expect(res.status).toBe(404);
    const row = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.deletedAt).toBeNull();
  });

  it('returns 404 for a malformed ID', async () => {
    const res = await request(app)
      .delete('/v1/webhook_endpoints/not-an-id')
      .set(as(merchantA.apiKey.key));
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/webhook_endpoints/:id/test', () => {
  it('delivers a signed ping event to the endpoint', async () => {
    const receiver = await startReceiver(200);
    const endpoint = await newEndpoint(receiver.url);

    const res = await sendTest(endpoint.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(/^wd_/),
      event_id: expect.stringMatching(/^evt_/),
      endpoint_id: endpoint.id,
      status: 'succeeded',
      attempt_count: 1,
      last_response_status: 200,
      last_response_ms: expect.any(Number),
      last_error: null,
    });

    expect(receiver.received).toHaveLength(1);
    const [webhook] = receiver.received;
    expect(webhook!.headers['webhook-id']).toBe(res.body.event_id);
    expect(webhook!.headers['content-type']).toBe('application/json');
    expect(
      verifyWebhook({ headers: webhook!.headers, body: webhook!.body, secret: endpoint.secret }),
    ).toBe(true);
    expect(JSON.parse(webhook!.body)).toEqual({
      id: res.body.event_id,
      type: 'ping',
      created_at: expect.any(String),
      data: { object: expect.objectContaining({ id: endpoint.id, url: receiver.url }) },
    });
    expect(webhook!.body).not.toContain('whsec_');

    // The event is dispatched (the fan-out loop must not copy it), and the lease is released.
    const event = await db.event.findUniqueOrThrow({ where: { id: res.body.event_id } });
    expect(event).toMatchObject({ type: 'ping', merchantId: merchantA.merchant.id });
    expect(event.dispatchedAt).toBeInstanceOf(Date);
    const delivery = await db.webhookDelivery.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(delivery.lockedUntil).toBeNull();
  });

  it.each([
    ['a 500', 500, {}],
    ['a redirect, which is never followed', 302, { location: '/elsewhere' }],
  ])(
    'records %s as a failed attempt and leaves the delivery pending',
    async (_name, status, headers) => {
      const receiver = await startReceiver(status, headers);
      const endpoint = await newEndpoint(receiver.url);

      const res = await sendTest(endpoint.id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'pending',
        attempt_count: 1,
        last_response_status: status,
        last_error: `HTTP ${status}`,
      });
      expect(receiver.received).toHaveLength(1);
    },
  );

  it('checks the URL again at send time', async () => {
    // Saved while private URLs were allowed, then sent by a server where they are not.
    const receiver = await startReceiver();
    const endpoint = await newEndpoint(receiver.url);

    const res = await sendTest(endpoint.id, { target: strictApp });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_response_status: null,
      last_error: expect.stringMatching(/private/),
    });
    expect(receiver.received).toHaveLength(0);
  });

  it('records an unreachable endpoint as a failed attempt', async () => {
    const receiver = await startReceiver();
    const endpoint = await newEndpoint(receiver.url);
    await new Promise((resolve) => servers.pop()!.close(resolve));

    const res = await sendTest(endpoint.id);
    expect(res.body).toMatchObject({
      status: 'pending',
      last_error: expect.stringMatching(/ECONNREFUSED/),
    });
  });

  it('returns 404 for another merchant’s endpoint and sends nothing', async () => {
    const receiver = await startReceiver();
    const endpoint = await newEndpoint(receiver.url);

    const res = await sendTest(endpoint.id, { key: merchantB.apiKey.key });

    expect(res.status).toBe(404);
    expect(receiver.received).toHaveLength(0);
  });
});

describe('attemptDelivery', () => {
  it('gives up on a receiver that takes longer than the timeout', async () => {
    const server = createServer(() => {
      // Never answers.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = await newEndpoint(`http://127.0.0.1:${port}/slow`);
    const event = await db.event.create({
      data: {
        id: newId('evt'),
        merchantId: merchantA.merchant.id,
        type: 'ping',
        payload: { object: {} },
        dispatchedAt: new Date(),
      },
    });
    const pending = await db.webhookDelivery.create({
      data: { id: newId('wd'), eventId: event.id, endpointId: endpoint.id },
    });

    const delivery = await attemptDelivery(db, pending.id, {
      encryptionKey: testConfig.APP_ENCRYPTION_KEY,
      allowPrivate: true,
      timeoutMs: 100,
    });

    expect(delivery).toMatchObject({
      status: 'pending',
      lastResponseStatus: null,
      lastError: 'Timed out after 100 ms',
    });
  });
});
