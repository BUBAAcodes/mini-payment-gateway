import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { createOrder, createPayment, testPrisma } from '@gateway/db/testing';
import { newId } from '@gateway/shared';
import { getDashboardOverview, lastDaysVolume } from '../src/services/overview';
import { merchantWithKey, newCheckoutOrder, testApp, testConfig } from './helpers';

// The dashboard API: the Next.js server calls it with DASHBOARD_SERVICE_TOKEN and the merchant ID
// from the logged-in session. Every query is still scoped by that merchant, so merchant A's
// session can never read or change merchant B's data.

const TOKEN = testConfig.DASHBOARD_SERVICE_TOKEN;
const UNAUTHORIZED = {
  error: { code: 'unauthorized', message: 'Invalid or missing dashboard credentials' },
};

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let a: Awaited<ReturnType<typeof merchantWithKey>>;
let b: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(() => {
  db = testPrisma();
  app = testApp(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  a = await merchantWithKey(db);
  b = await merchantWithKey(db);
});

type Method = 'get' | 'post' | 'delete';

/** A dashboard request as the web server sends it, for `merchantId`. */
function asDashboard(method: Method, path: string, merchantId: string) {
  return request(app)
    [method](`/dashboard${path}`)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('X-Merchant-Id', merchantId);
}

/** Pays a new order with success@test and returns the captured payment's ID. */
async function capturedPayment(apiKey: string): Promise<string> {
  const order = await newCheckoutOrder(app, apiKey);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa: 'success@test' });
  expect(res.body.status).toBe('captured');
  return res.body.id;
}

function createIssue(merchantId: string, resolvedAt: Date | null = null) {
  return db.reconciliationIssue.create({
    data: {
      merchantId,
      bankDate: new Date('2026-10-29'),
      kind: 'status_mismatch',
      gatewayReference: newId('pay'),
      bankRef: `bank_${randomUUID()}`,
      details: { gateway_status: 'failed', bank_status: 'success' },
      resolvedAt,
    },
  });
}

describe('dashboard authentication', () => {
  it('answers a valid token and merchant ID', async () => {
    const res = await asDashboard('get', '/merchant', a.merchant.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: a.merchant.id,
      name: a.merchant.name,
      created_at: a.merchant.createdAt.toISOString(),
    });
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { Authorization: `Bearer ${'x'.repeat(64)}` }],
    ['a merchant API key instead of the token', 'apiKey'],
    ['no X-Merchant-Id', { Authorization: `Bearer ${TOKEN}` }],
    ['a malformed X-Merchant-Id', { Authorization: `Bearer ${TOKEN}`, 'X-Merchant-Id': 'mer_x' }],
    ['an unknown merchant', { Authorization: `Bearer ${TOKEN}`, 'X-Merchant-Id': newId('mer') }],
  ])('gives the same 401 for %s', async (_name, headers) => {
    const res = await request(app)
      .get('/dashboard/payments')
      .set(
        headers === 'apiKey'
          ? { Authorization: `Bearer ${a.apiKey.key}`, 'X-Merchant-Id': a.merchant.id }
          : headers,
      );
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it('does not let the dashboard token into the merchant API', async () => {
    const res = await request(app)
      .get('/v1/payments')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Merchant-Id', a.merchant.id);
    expect(res.status).toBe(401);
  });
});

describe('merchant scoping', () => {
  it("lists only the session merchant's payments and hides the other merchant's", async () => {
    const paymentA = await createPayment(db, await createOrder(db, a.merchant.id));
    const paymentB = await createPayment(db, await createOrder(db, b.merchant.id));

    const list = await asDashboard('get', '/payments', a.merchant.id);
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([paymentA.id]);

    const own = await asDashboard('get', `/payments/${paymentA.id}`, a.merchant.id);
    expect(own.status).toBe(200);
    const other = await asDashboard('get', `/payments/${paymentB.id}`, a.merchant.id);
    expect(other.status).toBe(404);
  });

  it('shows the balance from the ledger, per merchant', async () => {
    await capturedPayment(a.apiKey.key);

    const balanceA = await asDashboard('get', '/balance', a.merchant.id);
    const balanceB = await asDashboard('get', '/balance', b.merchant.id);
    // ₹500 minus the 2% fee.
    expect(balanceA.body).toEqual({ balance: 49_000, currency: 'INR' });
    expect(balanceB.body).toEqual({ balance: 0, currency: 'INR' });
  });

  it('serves settlements, webhook endpoints and events for the merchant', async () => {
    for (const path of ['/settlements', '/webhook_endpoints', '/events']) {
      const res = await asDashboard('get', path, a.merchant.id);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toEqual({ data: [], has_more: false });
    }
  });

  it('does not expose order creation', async () => {
    const res = await asDashboard('post', '/orders', a.merchant.id)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 50_000 });
    expect(res.status).toBe(404);
  });
});

describe('refunds from the dashboard', () => {
  it('refunds a payment once per Idempotency-Key', async () => {
    const paymentId = await capturedPayment(a.apiKey.key);
    const key = randomUUID();
    const refund = () =>
      asDashboard('post', `/payments/${paymentId}/refunds`, a.merchant.id)
        .set('Idempotency-Key', key)
        .send({ amount: 10_000 });

    const first = await refund();
    const second = await refund();

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      payment_id: paymentId,
      amount: 10_000,
      status: 'processed',
    });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(await db.refund.count({ where: { paymentId } })).toBe(1);

    const fetched = await asDashboard('get', `/refunds/${first.body.id}`, a.merchant.id);
    expect(fetched.body.id).toBe(first.body.id);
  });

  it("cannot refund another merchant's payment", async () => {
    const paymentB = await capturedPayment(b.apiKey.key);
    const res = await asDashboard('post', `/payments/${paymentB}/refunds`, a.merchant.id)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(res.status).toBe(404);
    expect(await db.refund.count({ where: { paymentId: paymentB } })).toBe(0);
  });
});

describe('API keys', () => {
  it('shows a new key once, and lists keys without the key or its hash', async () => {
    const created = await asDashboard('post', '/api_keys', a.merchant.id);
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sk_test_[0-9A-Za-z]{32}$/);
    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^key_/),
      prefix: created.body.key.slice(0, 12),
      last_used_at: null,
      revoked_at: null,
    });

    const list = await asDashboard('get', '/api_keys', a.merchant.id);
    expect(list.status).toBe(200);
    expect(list.body.data.map((k: { id: string }) => k.id)).toEqual([created.body.id, a.apiKey.id]);
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(created.body.key);
    expect(text).not.toMatch(/hash/i);
    for (const key of list.body.data) expect(key).not.toHaveProperty('key');

    // The new key works on the merchant API.
    const res = await request(app)
      .get('/v1/balance')
      .set('Authorization', `Bearer ${created.body.key}`);
    expect(res.status).toBe(200);
  });

  it('revokes a key, keeps the first revoked_at, and the key stops working', async () => {
    const first = await asDashboard('post', `/api_keys/${a.apiKey.id}/revoke`, a.merchant.id);
    const second = await asDashboard('post', `/api_keys/${a.apiKey.id}/revoke`, a.merchant.id);

    expect(first.status).toBe(200);
    expect(first.body.revoked_at).toEqual(expect.any(String));
    expect(second.body.revoked_at).toBe(first.body.revoked_at);

    const res = await request(app)
      .get('/v1/balance')
      .set('Authorization', `Bearer ${a.apiKey.key}`);
    expect(res.status).toBe(401);
  });

  it("does not list or revoke another merchant's keys", async () => {
    const list = await asDashboard('get', '/api_keys', a.merchant.id);
    expect(list.body.data.map((k: { id: string }) => k.id)).not.toContain(b.apiKey.id);

    const res = await asDashboard('post', `/api_keys/${b.apiKey.id}/revoke`, a.merchant.id);
    expect(res.status).toBe(404);
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: b.apiKey.id } });
    expect(row.revokedAt).toBeNull();
  });
});

describe('reconciliation issues', () => {
  it('lists open and resolved issues for the merchant only', async () => {
    const open = await createIssue(a.merchant.id);
    const resolved = await createIssue(a.merchant.id, new Date());
    await createIssue(b.merchant.id);

    const all = await asDashboard('get', '/reconciliation_issues', a.merchant.id);
    expect(all.status).toBe(200);
    expect(all.body.data.map((i: { id: string }) => i.id)).toEqual([resolved.id, open.id]);
    expect(all.body.data[1]).toEqual({
      id: open.id,
      bank_date: '2026-10-29',
      kind: 'status_mismatch',
      gateway_reference: open.gatewayReference,
      bank_ref: open.bankRef,
      details: { gateway_status: 'failed', bank_status: 'success' },
      resolved_at: null,
      created_at: open.createdAt.toISOString(),
    });

    const onlyOpen = await asDashboard('get', '/reconciliation_issues?status=open', a.merchant.id);
    expect(onlyOpen.body.data.map((i: { id: string }) => i.id)).toEqual([open.id]);
    const onlyResolved = await asDashboard(
      'get',
      '/reconciliation_issues?status=resolved',
      a.merchant.id,
    );
    expect(onlyResolved.body.data.map((i: { id: string }) => i.id)).toEqual([resolved.id]);
  });

  it('pages through issues', async () => {
    const older = await createIssue(a.merchant.id);
    const newer = await createIssue(a.merchant.id);

    const first = await asDashboard('get', '/reconciliation_issues?limit=1', a.merchant.id);
    expect(first.body).toMatchObject({ data: [{ id: newer.id }], has_more: true });
    const second = await asDashboard(
      'get',
      `/reconciliation_issues?limit=1&starting_after=${newer.id}`,
      a.merchant.id,
    );
    expect(second.body).toMatchObject({ data: [{ id: older.id }], has_more: false });
  });

  it('marks an issue resolved once', async () => {
    const issue = await createIssue(a.merchant.id);
    const path = `/reconciliation_issues/${issue.id}/resolve`;

    const first = await asDashboard('post', path, a.merchant.id);
    const second = await asDashboard('post', path, a.merchant.id);

    expect(first.status).toBe(200);
    expect(first.body.resolved_at).toEqual(expect.any(String));
    expect(second.body.resolved_at).toBe(first.body.resolved_at);
  });

  it.each([
    ["another merchant's issue", 'other'],
    ['an unknown issue', randomUUID()],
    ['an ID that is not a UUID', 'nope'],
  ])('answers 404 when resolving %s', async (_name, id) => {
    const other = await createIssue(b.merchant.id);
    const issueId = id === 'other' ? other.id : id;

    const res = await asDashboard(
      'post',
      `/reconciliation_issues/${issueId}/resolve`,
      a.merchant.id,
    );
    expect(res.status).toBe(404);
    const row = await db.reconciliationIssue.findUniqueOrThrow({ where: { id: other.id } });
    expect(row.resolvedAt).toBeNull();
  });

  it('hides issues the bank has but no merchant owns', async () => {
    await db.reconciliationIssue.create({
      data: {
        merchantId: null,
        bankDate: new Date('2026-10-29'),
        kind: 'missing_in_gateway',
        gatewayReference: `unknown_${randomUUID()}`,
        details: {},
      },
    });
    const res = await asDashboard('get', '/reconciliation_issues', a.merchant.id);
    expect(res.body.data).toEqual([]);
  });
});

describe('overview', () => {
  // 2026-10-30 in India runs from 2026-10-29T18:30Z to 2026-10-30T18:30Z.
  const NOW = new Date('2026-10-30T12:00:00.000Z');

  /** A payment for `merchantId`, created at `createdAt`, in `status`. */
  async function paymentAt(
    merchantId: string,
    createdAt: string,
    status: 'captured' | 'refunded' | 'failed' | 'pending',
    amount = 50_000,
  ) {
    const order = await createOrder(db, merchantId, amount);
    const payment = await createPayment(db, order, status);
    await db.payment.update({
      where: { id: payment.id },
      data: { createdAt: new Date(createdAt) },
    });
  }

  it('counts only payments created today in India', async () => {
    await paymentAt(a.merchant.id, '2026-10-29T18:29:59.999Z', 'captured'); // 23:59 IST yesterday
    await paymentAt(a.merchant.id, '2026-10-29T18:31:00.000Z', 'captured', 20_000); // 00:01 IST
    await paymentAt(a.merchant.id, '2026-10-30T18:29:00.000Z', 'captured', 30_000); // 23:59 IST
    await paymentAt(a.merchant.id, '2026-10-30T18:30:00.000Z', 'captured'); // 00:00 IST tomorrow

    const overview = await getDashboardOverview(db, a.merchant.id, NOW);
    expect(overview).toEqual({
      last_7_days: expect.any(Array),
      today: {
        date: '2026-10-30',
        volume: 50_000,
        captured_count: 2,
        failed_count: 0,
        success_rate: 1,
      },
      currency: 'INR',
    });
  });

  it('counts refunded payments as successes and leaves in-progress ones out of the rate', async () => {
    await paymentAt(a.merchant.id, '2026-10-30T05:00:00.000Z', 'captured', 10_000);
    await paymentAt(a.merchant.id, '2026-10-30T05:01:00.000Z', 'refunded', 20_000);
    await paymentAt(a.merchant.id, '2026-10-30T05:02:00.000Z', 'failed', 40_000);
    await paymentAt(a.merchant.id, '2026-10-30T05:03:00.000Z', 'failed', 40_000);
    await paymentAt(a.merchant.id, '2026-10-30T05:04:00.000Z', 'pending', 80_000);

    const { today } = await getDashboardOverview(db, a.merchant.id, NOW);
    expect(today).toMatchObject({
      volume: 30_000,
      captured_count: 2,
      failed_count: 2,
      success_rate: 0.5,
    });
  });

  it('has no success rate when nothing has finished today', async () => {
    await paymentAt(a.merchant.id, '2026-10-30T05:00:00.000Z', 'pending');

    const { today } = await getDashboardOverview(db, a.merchant.id, NOW);
    expect(today).toMatchObject({
      volume: 0,
      captured_count: 0,
      failed_count: 0,
      success_rate: null,
    });
  });

  it("never counts another merchant's payments", async () => {
    await paymentAt(b.merchant.id, '2026-10-30T05:00:00.000Z', 'captured');
    await paymentAt(b.merchant.id, '2026-10-30T05:01:00.000Z', 'failed');

    const { today } = await getDashboardOverview(db, a.merchant.id, NOW);
    expect(today).toMatchObject({ volume: 0, captured_count: 0, failed_count: 0 });
  });

  it('is served at /dashboard/overview for the session merchant, with the service token', async () => {
    await capturedPayment(a.apiKey.key);

    const res = await asDashboard('get', '/overview', a.merchant.id);
    expect(res.status).toBe(200);
    expect(res.body.today).toMatchObject({ volume: 50_000, captured_count: 1, success_rate: 1 });

    const other = await asDashboard('get', '/overview', b.merchant.id);
    expect(other.body.today).toMatchObject({ volume: 0, captured_count: 0 });

    const noToken = await request(app)
      .get('/dashboard/overview')
      .set('X-Merchant-Id', a.merchant.id);
    expect(noToken.status).toBe(401);
  });
});

describe('7-day volume', () => {
  const NOW = new Date('2026-10-30T12:00:00.000Z'); // 30 Oct, 17:30 IST

  async function capturedAt(
    merchantId: string,
    createdAt: string,
    amount: number,
    status = 'captured',
  ) {
    const order = await createOrder(db, merchantId, amount);
    const payment = await createPayment(db, order, status as 'captured');
    await db.payment.update({
      where: { id: payment.id },
      data: { createdAt: new Date(createdAt) },
    });
  }

  it('totals captured payments per India-time day, oldest first, with empty days as 0', async () => {
    await capturedAt(a.merchant.id, '2026-10-24T18:30:00.000Z', 10_000); // 25 Oct 00:00 IST
    await capturedAt(a.merchant.id, '2026-10-23T18:29:59.000Z', 99_000); // 23 Oct 23:59: too old
    await capturedAt(a.merchant.id, '2026-10-29T20:00:00.000Z', 20_000); // 30 Oct 01:30 IST
    await capturedAt(a.merchant.id, '2026-10-30T10:00:00.000Z', 30_000, 'refunded'); // 30 Oct
    await capturedAt(a.merchant.id, '2026-10-30T11:00:00.000Z', 40_000, 'failed'); // not volume
    await capturedAt(b.merchant.id, '2026-10-30T11:00:00.000Z', 70_000); // other merchant

    const days = await lastDaysVolume(db, a.merchant.id, NOW, 7);
    expect(days).toEqual([
      { date: '2026-10-24', volume: 0, captured_count: 0 },
      { date: '2026-10-25', volume: 10_000, captured_count: 1 },
      { date: '2026-10-26', volume: 0, captured_count: 0 },
      { date: '2026-10-27', volume: 0, captured_count: 0 },
      { date: '2026-10-28', volume: 0, captured_count: 0 },
      { date: '2026-10-29', volume: 0, captured_count: 0 },
      { date: '2026-10-30', volume: 50_000, captured_count: 2 },
    ]);
  });

  it('comes with the overview', async () => {
    const overview = await getDashboardOverview(db, a.merchant.id, NOW);
    expect(overview.last_7_days).toHaveLength(7);
    expect(overview.last_7_days.at(-1)).toEqual({
      date: '2026-10-30',
      volume: 0,
      captured_count: 0,
    });
  });
});

describe('payment activity', () => {
  it("lists a payment's refunds and the events about it, newest first", async () => {
    const paymentId = await capturedPayment(a.apiKey.key);
    const otherPaymentId = await capturedPayment(a.apiKey.key);
    for (const amount of [10_000, 5_000]) {
      await asDashboard('post', `/payments/${paymentId}/refunds`, a.merchant.id)
        .set('Idempotency-Key', randomUUID())
        .send({ amount })
        .expect(201);
    }

    const res = await asDashboard('get', `/payments/${paymentId}/activity`, a.merchant.id).expect(
      200,
    );

    expect(res.body.refunds.map((r: { amount: number }) => r.amount)).toEqual([5_000, 10_000]);
    expect(res.body.refunds.every((r: { payment_id: string }) => r.payment_id === paymentId)).toBe(
      true,
    );
    expect(res.body.events.map((e: { type: string }) => e.type)).toEqual([
      'refund.processed',
      'refund.processed',
      'payment.captured',
    ]);
    expect(res.body.events[0]).toHaveProperty('deliveries');
    const ids = JSON.stringify(res.body);
    expect(ids).not.toContain(otherPaymentId);
  });

  it("returns 404 for another merchant's payment", async () => {
    const paymentId = await capturedPayment(a.apiKey.key);
    await asDashboard('get', `/payments/${paymentId}/activity`, b.merchant.id).expect(404);
  });
});
