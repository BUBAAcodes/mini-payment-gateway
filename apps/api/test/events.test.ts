import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { isolatedTestPrisma } from '@gateway/db/testing';
import { newId, type WebhookEventType } from '@gateway/shared';
import { fanOutEvents } from '../src/jobs/webhook-fan-out';
import { sendDueWebhooks } from '../src/jobs/webhook-sender';
import { createLogger } from '../src/logger';
import { createWebhookEndpoint, deleteWebhookEndpoint } from '../src/services/webhook-endpoints';
import { merchantWithKey, testApp, testConfig } from './helpers';
import { startReceiver, stopReceivers } from './receiver';

const log = createLogger('silent');
const options = { encryptionKey: testConfig.APP_ENCRYPTION_KEY, allowPrivate: true };

// A database of this file's own: the sender claims every due delivery, whoever it belongs to.
let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;
let other: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = await isolatedTestPrisma();
  app = testApp(db);
  merchant = await merchantWithKey(db);
  other = await merchantWithKey(db);
});

beforeEach(async () => {
  await db.webhookDelivery.deleteMany();
  await db.event.deleteMany();
  await db.webhookEndpoint.deleteMany();
});

afterEach(stopReceivers);

afterAll(async () => {
  await db.$disconnect();
});

function as(key: string) {
  return { Authorization: `Bearer ${key}` };
}

function newEndpoint(url: string, merchantId = merchant.merchant.id) {
  return createWebhookEndpoint(db, merchantId, { url, event_types: ['*'] }, options).then(
    (created) => created.endpoint,
  );
}

/** An event created at a given time, so the newest-first order is certain. */
function newEvent({
  type = 'payment.captured' as WebhookEventType,
  merchantId = merchant.merchant.id,
  createdAt = new Date(),
} = {}) {
  return db.event.create({
    data: {
      id: newId('evt'),
      merchantId,
      type,
      payload: { object: { id: 'pay_test' } },
      createdAt,
    },
  });
}

const sendAll = () => sendDueWebhooks(db, log, options);

function listEvents(query = '', key = merchant.apiKey.key) {
  return request(app).get(`/v1/events${query}`).set(as(key));
}

function redeliver(eventId: string, body: object = {}, key = merchant.apiKey.key) {
  return request(app).post(`/v1/events/${eventId}/redeliver`).set(as(key)).send(body);
}

describe('GET /v1/events', () => {
  it('lists the merchant’s own events, newest first, with their deliveries', async () => {
    const receiver = await startReceiver();
    const endpoint = await newEndpoint(receiver.url);
    const older = await newEvent({ createdAt: new Date(Date.now() - 2000) });
    const newer = await newEvent({
      type: 'payment.failed',
      createdAt: new Date(Date.now() - 1000),
    });
    await newEvent({ merchantId: other.merchant.id });
    await fanOutEvents(db);
    await sendAll();

    const res = await listEvents();

    expect(res.status).toBe(200);
    expect(res.body.has_more).toBe(false);
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([newer.id, older.id]);
    expect(res.body.data[0]).toEqual({
      id: newer.id,
      type: 'payment.failed',
      created_at: newer.createdAt.toISOString(),
      data: { object: { id: 'pay_test' } },
      dispatched_at: expect.any(String),
      deliveries: [
        {
          id: expect.stringMatching(/^wd_/),
          event_id: newer.id,
          endpoint_id: endpoint.id,
          status: 'succeeded',
          attempt_count: 1,
          next_attempt_at: null,
          last_attempt_at: expect.any(String),
          last_response_status: 200,
          last_response_ms: expect.any(Number),
          last_error: null,
          created_at: expect.any(String),
        },
      ],
    });
  });

  it('shows an event not sent yet with no deliveries', async () => {
    const event = await newEvent();

    const res = await listEvents();

    expect(res.body.data).toEqual([
      expect.objectContaining({ id: event.id, dispatched_at: null, deliveries: [] }),
    ]);
  });

  it('returns a page at a time', async () => {
    const now = Date.now();
    const a = await newEvent({ createdAt: new Date(now - 3000) });
    const b = await newEvent({ createdAt: new Date(now - 2000) });
    const c = await newEvent({ createdAt: new Date(now - 1000) });
    const ids = (res: request.Response) => res.body.data.map((e: { id: string }) => e.id);

    const first = await listEvents('?limit=2');
    expect(ids(first)).toEqual([c.id, b.id]);
    expect(first.body.has_more).toBe(true);

    const second = await listEvents(`?limit=2&starting_after=${b.id}`);
    expect(ids(second)).toEqual([a.id]);
    expect(second.body.has_more).toBe(false);
  });

  it('rejects a starting_after that is not one of the merchant’s events', async () => {
    const theirs = await newEvent({ merchantId: other.merchant.id });

    for (const cursor of [theirs.id, 'evt_nope']) {
      const res = await listEvents(`?starting_after=${cursor}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'validation_error', field: 'starting_after' });
    }
  });

  it('filters by event type', async () => {
    const captured = await newEvent({ type: 'payment.captured' });
    await newEvent({ type: 'refund.processed' });

    const res = await listEvents('?type=payment.captured').expect(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([captured.id]);
  });

  it('filters to events with at least one delivery in a given status', async () => {
    const endpoint = await newEndpoint('https://shop.test/hooks');
    const failing = await newEvent();
    const fine = await newEvent();
    await newEvent(); // never sent: no deliveries at all
    for (const [event, status] of [
      [failing, 'failed'],
      [fine, 'succeeded'],
    ] as const) {
      await db.webhookDelivery.create({
        data: { id: newId('wd'), eventId: event.id, endpointId: endpoint.id, status },
      });
    }

    const res = await listEvents('?delivery_status=failed').expect(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([failing.id]);
  });

  it('rejects an unknown type or delivery status', async () => {
    await listEvents('?type=order.made').expect(400);
    await listEvents('?delivery_status=lost').expect(400);
  });

  it('needs an API key', async () => {
    const res = await request(app).get('/v1/events');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/events/:id/redeliver', () => {
  /** An event already delivered once to each of `count` endpoints on one receiver. */
  async function deliveredEvent(count = 1) {
    const receiver = await startReceiver();
    const endpoints = [];
    for (let i = 0; i < count; i++) endpoints.push(await newEndpoint(receiver.url));
    const event = await newEvent();
    await fanOutEvents(db);
    await sendAll();
    expect(receiver.received).toHaveLength(count);
    return { receiver, endpoints, event };
  }

  it('queues a fresh delivery, sent again with the same webhook-id', async () => {
    const { receiver, endpoints, event } = await deliveredEvent();
    const original = await db.webhookDelivery.findFirstOrThrow({ where: { eventId: event.id } });

    const res = await redeliver(event.id);

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        event_id: event.id,
        endpoint_id: endpoints[0]!.id,
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: expect.any(String),
      }),
    ]);
    expect(res.body.data[0].id).not.toBe(original.id);

    await sendAll();
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[1]!.headers['webhook-id']).toBe(event.id);
    // The first delivery's record is left as it was.
    expect(await db.webhookDelivery.findUniqueOrThrow({ where: { id: original.id } })).toEqual(
      original,
    );
  });

  it('goes to every live endpoint that got the event before', async () => {
    const { endpoints, event } = await deliveredEvent(3);
    await deleteWebhookEndpoint(db, merchant.merchant.id, endpoints[2]!.id);
    // Created after the event, so it never got it.
    await newEndpoint('https://merchant.example/later');

    const res = await redeliver(event.id);

    expect(res.status).toBe(202);
    expect(res.body.data.map((d: { endpoint_id: string }) => d.endpoint_id).sort()).toEqual(
      [endpoints[0]!.id, endpoints[1]!.id].sort(),
    );
  });

  it('goes only to the endpoint named in endpoint_id, even one that never got the event', async () => {
    const { event } = await deliveredEvent(2);
    const later = await newEndpoint('https://merchant.example/later');

    const res = await redeliver(event.id, { endpoint_id: later.id });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual([expect.objectContaining({ endpoint_id: later.id })]);
  });

  it('returns 404 for another merchant’s event or endpoint, and queues nothing', async () => {
    const { event } = await deliveredEvent();
    const theirs = await newEvent({ merchantId: other.merchant.id });
    const theirEndpoint = await newEndpoint('https://other.example/hooks', other.merchant.id);
    const before = await db.webhookDelivery.count();

    expect((await redeliver(theirs.id)).status).toBe(404);
    expect((await redeliver('evt_nope')).status).toBe(404);
    const res = await redeliver(event.id, { endpoint_id: theirEndpoint.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');

    expect(await db.webhookDelivery.count()).toBe(before);
  });

  it('returns 422 for an event not sent yet', async () => {
    const event = await newEvent();

    const res = await redeliver(event.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_state');
  });

  it('returns 422 when no endpoint that got the event is left', async () => {
    const { endpoints, event } = await deliveredEvent();
    await deleteWebhookEndpoint(db, merchant.merchant.id, endpoints[0]!.id);

    const res = await redeliver(event.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_state');
  });

  it.each([
    ['a malformed endpoint_id', { endpoint_id: 'nope' }],
    ['an unknown field', { endpoint: 'we_x' }],
  ])('rejects %s with 400', async (_name, body) => {
    const { event } = await deliveredEvent();
    const res = await redeliver(event.id, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('queues one delivery for a repeated Idempotency-Key', async () => {
    const { event } = await deliveredEvent();
    const key = randomUUID();
    const send = () =>
      request(app)
        .post(`/v1/events/${event.id}/redeliver`)
        .set(as(merchant.apiKey.key))
        .set('Idempotency-Key', key)
        .send({});

    const first = await send();
    const second = await send();

    expect(first.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await db.webhookDelivery.count({ where: { eventId: event.id } })).toBe(2);
  });
});
