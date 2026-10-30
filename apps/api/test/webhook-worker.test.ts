import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { isolatedTestPrisma } from '@gateway/db/testing';
import { verifyWebhook, type WebhookEventType } from '@gateway/shared';
import { fanOutAllEvents, fanOutEvents } from '../src/jobs/webhook-fan-out';
import { claimDueDeliveries, sendDueWebhooks } from '../src/jobs/webhook-sender';
import { createLogger } from '../src/logger';
import { recordEvent } from '../src/services/events';
import { createWebhookEndpoint, deleteWebhookEndpoint } from '../src/services/webhook-endpoints';
import { merchantWithKey, newCheckoutOrder, testApp, testConfig } from './helpers';
import { startReceiver, stopReceivers } from './receiver';

const MINUTE = 60_000;
const log = createLogger('silent');
const options = { encryptionKey: testConfig.APP_ENCRYPTION_KEY, allowPrivate: true };

// A database of this file's own: the worker claims every due delivery, whoever it belongs to.
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
  // Each test starts with no events or deliveries, so the worker only sees that test's work.
  await db.webhookDelivery.deleteMany();
  await db.event.deleteMany();
  await db.webhookEndpoint.deleteMany();
});

afterEach(stopReceivers);

afterAll(async () => {
  await db.$disconnect();
});

function newEndpoint(
  url: string,
  { merchantId = merchant.merchant.id, eventTypes = ['*'] as ['*'] | WebhookEventType[] } = {},
) {
  return createWebhookEndpoint(db, merchantId, { url, event_types: eventTypes }, options);
}

function newEvent(type: WebhookEventType = 'payment.captured', merchantId = merchant.merchant.id) {
  return recordEvent(db, merchantId, type, { id: 'pay_test' });
}

/** An endpoint at `url` with one event fanned out to it: one pending delivery. */
async function queuedDelivery(url: string) {
  const { endpoint, secret } = await newEndpoint(url);
  const event = await newEvent();
  await fanOutEvents(db);
  const delivery = await db.webhookDelivery.findFirstOrThrow({ where: { eventId: event.id } });
  return { endpoint, secret, event, delivery };
}

/** One run of the sender loop, as if it were `now`. */
function send(now?: Date, extra: { random?: () => number } = {}) {
  return sendDueWebhooks(db, log, { ...options, ...(now && { now: () => now }), ...extra });
}

const deliveryRow = (id: string) => db.webhookDelivery.findUniqueOrThrow({ where: { id } });

describe('fanOutEvents', () => {
  it('creates one delivery per live endpoint subscribed to the event, then marks it dispatched', async () => {
    const all = await newEndpoint('https://merchant.example/all');
    const captures = await newEndpoint('https://merchant.example/captures', {
      eventTypes: ['payment.captured', 'payment.failed'],
    });
    await newEndpoint('https://merchant.example/refunds', { eventTypes: ['refund.processed'] });
    const deleted = await newEndpoint('https://merchant.example/deleted');
    await deleteWebhookEndpoint(db, merchant.merchant.id, deleted.endpoint.id);
    await newEndpoint('https://other.example/all', { merchantId: other.merchant.id });
    const event = await newEvent('payment.captured');

    expect(await fanOutEvents(db)).toEqual({ events: 1, deliveries: 2 });

    const deliveries = await db.webhookDelivery.findMany({ where: { eventId: event.id } });
    expect(deliveries.map((d) => d.endpointId).sort()).toEqual(
      [all.endpoint.id, captures.endpoint.id].sort(),
    );
    for (const d of deliveries) {
      expect(d).toMatchObject({ status: 'pending', attemptCount: 0, lockedUntil: null });
    }
    const row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.dispatchedAt).toBeInstanceOf(Date);

    // Dispatched events are never fanned out again.
    expect(await fanOutEvents(db)).toEqual({ events: 0, deliveries: 0 });
    expect(await db.webhookDelivery.count()).toBe(2);
  });

  it('marks an event no endpoint wants as dispatched, with no deliveries', async () => {
    await newEndpoint('https://merchant.example/refunds', { eventTypes: ['refund.processed'] });
    const event = await newEvent('payment.failed');

    expect(await fanOutEvents(db)).toEqual({ events: 1, deliveries: 0 });
    const row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.dispatchedAt).toBeInstanceOf(Date);
  });

  it('two fan-outs at the same time never fan an event out twice', async () => {
    await newEndpoint('https://merchant.example/all');
    for (let i = 0; i < 30; i++) await newEvent();

    const [first, second] = await Promise.all([
      fanOutAllEvents(db, log, { batchSize: 5 }),
      fanOutAllEvents(db, log, { batchSize: 5 }),
    ]);

    expect(first.events + second.events).toBe(30);
    expect(await db.webhookDelivery.count()).toBe(30);
    const perEvent = await db.webhookDelivery.groupBy({ by: ['eventId'], _count: true });
    expect(perEvent).toHaveLength(30);
    expect(perEvent.every((group) => group._count === 1)).toBe(true);
  });
});

describe('claimDueDeliveries', () => {
  it('two claims at the same moment never take the same delivery, and a claim is a lease', async () => {
    await newEndpoint('https://merchant.example/all');
    for (let i = 0; i < 6; i++) await newEvent();
    await fanOutEvents(db);

    const [first, second] = await Promise.all([
      claimDueDeliveries(db, { batchSize: 100 }),
      claimDueDeliveries(db, { batchSize: 100 }),
    ]);

    expect(first.length + second.length).toBe(6);
    expect(new Set([...first, ...second]).size).toBe(6);
    // Leased for 30 seconds: nobody else can claim them in the meantime.
    expect(await claimDueDeliveries(db, { batchSize: 100 })).toEqual([]);
    const rows = await db.webhookDelivery.findMany();
    for (const row of rows) expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('sendDueWebhooks', () => {
  it('retries a receiver that answered 500, then marks the delivery succeeded', async () => {
    const receiver = await startReceiver({ statuses: [500, 200] });
    const { secret, event, delivery } = await queuedDelivery(receiver.url);

    await send();
    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastResponseStatus: 500,
      lastError: 'HTTP 500',
      lockedUntil: null,
    });

    // The first retry is due straight away.
    await send();
    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: 'succeeded',
      attemptCount: 2,
      lastResponseStatus: 200,
      lastError: null,
      lockedUntil: null,
    });

    expect(receiver.received).toHaveLength(2);
    for (const webhook of receiver.received) {
      // The same webhook-id every time, so the receiver can skip one it already handled.
      expect(webhook.headers['webhook-id']).toBe(event.id);
      expect(verifyWebhook({ headers: webhook.headers, body: webhook.body, secret })).toBe(true);
    }
  });

  it('schedules the next attempt from the retry schedule, with jitter', async () => {
    const receiver = await startReceiver({ statuses: [503] });
    const { delivery } = await queuedDelivery(receiver.url);
    // Two attempts already failed, so this third failure waits 5 minutes, give or take 20%.
    await db.webhookDelivery.update({ where: { id: delivery.id }, data: { attemptCount: 2 } });
    const now = new Date();

    await send(now);

    const row = await deliveryRow(delivery.id);
    expect(row).toMatchObject({
      status: 'pending',
      attemptCount: 3,
      lastResponseStatus: 503,
      lastError: 'HTTP 503',
      lastAttemptAt: now,
      lockedUntil: null,
    });
    const wait = row.nextAttemptAt.getTime() - now.getTime();
    expect(wait).toBeGreaterThanOrEqual(4 * MINUTE);
    expect(wait).toBeLessThanOrEqual(6 * MINUTE);

    // Not sent again before it is due; sent once it is.
    await send(new Date(now.getTime() + 4 * MINUTE - 1));
    expect(receiver.received).toHaveLength(1);
    await send(new Date(now.getTime() + 6 * MINUTE));
    expect(receiver.received).toHaveLength(2);
  });

  it('marks the delivery failed when the last attempt fails', async () => {
    const receiver = await startReceiver({ statuses: [500] });
    const { delivery } = await queuedDelivery(receiver.url);
    await db.webhookDelivery.update({ where: { id: delivery.id }, data: { attemptCount: 8 } });

    await send();

    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: 'failed',
      attemptCount: 9,
      lastError: 'HTTP 500',
      lockedUntil: null,
    });
    // Never tried again.
    await send(new Date(Date.now() + 24 * 60 * MINUTE));
    expect(receiver.received).toHaveLength(1);
  });

  it('leaves a delivery leased to another sender alone until the lease runs out', async () => {
    const receiver = await startReceiver();
    const { delivery } = await queuedDelivery(receiver.url);
    const now = new Date();
    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: { lockedUntil: new Date(now.getTime() + 30_000) },
    });

    await send(now);
    expect(receiver.received).toHaveLength(0);

    // The other sender died mid-send: once its lease expires, this one takes over.
    await send(new Date(now.getTime() + 31_000));
    expect(receiver.received).toHaveLength(1);
    expect(await deliveryRow(delivery.id)).toMatchObject({ status: 'succeeded' });
  });

  it('two senders running at the same time never send the same delivery twice', async () => {
    // Slow enough that the two senders' batches overlap.
    const receiver = await startReceiver({ delayMs: 50 });
    await newEndpoint(receiver.url);
    const eventIds: string[] = [];
    for (let i = 0; i < 25; i++) eventIds.push((await newEvent()).id);
    await fanOutEvents(db);

    await Promise.all([send(), send()]);

    const sentIds = receiver.received.map((w) => w.headers['webhook-id']);
    expect(sentIds).toHaveLength(25);
    expect(new Set(sentIds)).toEqual(new Set(eventIds));
    const rows = await db.webhookDelivery.findMany();
    expect(rows).toHaveLength(25);
    for (const row of rows) expect(row).toMatchObject({ status: 'succeeded', attemptCount: 1 });
  });

  it('delivers payment.captured from a real payment, through the outbox', async () => {
    const receiver = await startReceiver();
    const { secret } = await newEndpoint(receiver.url, { eventTypes: ['payment.captured'] });
    const order = await newCheckoutOrder(app, merchant.apiKey.key);
    const paid = await request(app)
      .post(`/checkout/orders/${order.id}/pay`)
      .query({ cs: order.cs })
      .send({ method: 'upi', vpa: 'success@test' });
    expect(paid.body.status).toBe('captured');

    await fanOutAllEvents(db, log);
    await send();

    expect(receiver.received).toHaveLength(1);
    const [webhook] = receiver.received;
    expect(verifyWebhook({ headers: webhook!.headers, body: webhook!.body, secret })).toBe(true);
    expect(JSON.parse(webhook!.body)).toEqual({
      id: webhook!.headers['webhook-id'],
      type: 'payment.captured',
      created_at: expect.any(String),
      data: {
        object: expect.objectContaining({
          id: paid.body.id,
          order_id: order.id,
          status: 'captured',
        }),
      },
    });
  });
});
