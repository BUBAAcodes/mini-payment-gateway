import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { testPrisma } from '@gateway/db/testing';
import { getMerchantBalance, merchantBalanceAccount } from '../src/services/ledger';
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
  // A merchant per test, so balances and counts start from zero.
  merchant = await merchantWithKey(db);
});

/** Pays a new order with success@test and returns the captured payment's ID. */
async function capturedPayment(body: object = {}, apiKey = merchant.apiKey.key): Promise<string> {
  const order = await newCheckoutOrder(app, apiKey, body);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa: 'success@test' });
  expect(res.body.status).toBe('captured');
  return res.body.id;
}

function refund(
  paymentId: string,
  body: object = {},
  { key = randomUUID(), apiKey = merchant.apiKey.key } = {},
) {
  return request(app)
    .post(`/v1/payments/${paymentId}/refunds`)
    .set('Authorization', `Bearer ${apiKey}`)
    .set('Idempotency-Key', key)
    .send(body);
}

function getRefund(refundId: string, apiKey = merchant.apiKey.key) {
  return request(app).get(`/v1/refunds/${refundId}`).set('Authorization', `Bearer ${apiKey}`);
}

const paymentRow = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });

const refundRows = (paymentId: string) =>
  db.refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });

/** The refund's ledger transactions and their entries, sorted by account. */
async function refundLedger(refundId: string) {
  const transactions = await db.ledgerTransaction.findMany({
    where: { referenceType: 'refund', referenceId: refundId },
    include: { entries: { include: { account: true } } },
  });
  return transactions.map((t) => ({
    type: t.type,
    entries: t.entries
      .map((e) => ({ account: e.account.code, direction: e.direction, amount: e.amount }))
      .sort((a, b) => a.account.localeCompare(b.account)),
  }));
}

async function eventsFor(id: string) {
  return db.event.findMany({
    where: { payload: { path: ['object', 'id'], equals: id } },
    orderBy: { createdAt: 'asc' },
  });
}

describe('POST /v1/payments/:id/refunds', () => {
  it('a full refund (no amount) returns what is left and marks the payment refunded', async () => {
    const paymentId = await capturedPayment();

    const res = await refund(paymentId);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^rfnd_[0-9A-Za-z]{14}$/),
      payment_id: paymentId,
      amount: 50_000,
      status: 'processed',
      failure_reason: null,
      processed_at: expect.any(String),
      created_at: expect.any(String),
    });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'refunded',
      amountRefunded: 50_000,
    });

    // Section 9.4: the merchant gives back the full amount; we keep our fee.
    expect(await refundLedger(res.body.id)).toEqual([
      {
        type: 'refund',
        entries: [
          { account: 'gateway_clearing', direction: 'credit', amount: 50_000 },
          {
            account: merchantBalanceAccount(merchant.merchant.id),
            direction: 'debit',
            amount: 50_000,
          },
        ],
      },
    ]);
    // 49,000 owed for the capture, minus 50,000 refunded: negative is allowed (section 9.5).
    expect(await getMerchantBalance(db, merchant.merchant.id)).toBe(-1_000);

    const events = await eventsFor(res.body.id);
    expect(events.map((e) => e.type)).toEqual(['refund.processed']);
    expect(events[0]?.payload).toEqual({ object: res.body });
  });

  it('partial refunds keep the payment captured until they add up to the amount', async () => {
    const paymentId = await capturedPayment();

    const first = await refund(paymentId, { amount: 20_000 });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ amount: 20_000, status: 'processed' });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 20_000,
    });

    // No amount: whatever is left.
    const rest = await refund(paymentId);
    expect(rest.status).toBe(201);
    expect(rest.body).toMatchObject({ amount: 30_000, status: 'processed' });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'refunded',
      amountRefunded: 50_000,
    });

    expect(await getMerchantBalance(db, merchant.merchant.id)).toBe(-1_000);
    const payment = await request(app)
      .get(`/v1/payments/${paymentId}`)
      .set('Authorization', `Bearer ${merchant.apiKey.key}`);
    expect(payment.body).toMatchObject({ status: 'refunded', amount_refunded: 50_000 });
  });

  it('refuses more than is left to refund, and changes nothing', async () => {
    const paymentId = await capturedPayment();
    await refund(paymentId, { amount: 20_000 });

    const res = await refund(paymentId, { amount: 30_001 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid_state' });
    expect(res.body.error.message).toContain('30000');
    expect(await paymentRow(paymentId)).toMatchObject({ amountRefunded: 20_000 });
    expect(await refundRows(paymentId)).toHaveLength(1);
  });

  it('refuses a payment that is already fully refunded', async () => {
    const paymentId = await capturedPayment();
    await refund(paymentId);

    for (const body of [{}, { amount: 1 }]) {
      const res = await refund(paymentId, body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_state');
    }
    expect(await refundRows(paymentId)).toHaveLength(1);
  });

  it('refuses a payment that was never captured', async () => {
    const order = await newCheckoutOrder(app, merchant.apiKey.key);
    const failed = await request(app)
      .post(`/checkout/orders/${order.id}/pay`)
      .query({ cs: order.cs })
      .send({ method: 'upi', vpa: 'fail@test' });
    expect(failed.body.status).toBe('failed');

    const res = await refund(failed.body.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_state');
    expect(await refundRows(failed.body.id)).toHaveLength(0);
  });

  it("treats another merchant's payment, or a made-up ID, as not found", async () => {
    const other = await merchantWithKey(db);
    const othersPayment = await capturedPayment({}, other.apiKey.key);

    for (const id of [othersPayment, 'pay_doesnotexist00', 'order_12345678901234']) {
      const res = await refund(id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect(await paymentRow(othersPayment)).toMatchObject({ amountRefunded: 0 });
  });

  it('needs an Idempotency-Key and a valid amount', async () => {
    const paymentId = await capturedPayment();

    const noKey = await request(app)
      .post(`/v1/payments/${paymentId}/refunds`)
      .set('Authorization', `Bearer ${merchant.apiKey.key}`)
      .send({});
    expect(noKey.status).toBe(400);
    expect(noKey.body.error).toMatchObject({ code: 'validation_error', field: 'Idempotency-Key' });

    const badAmount = await refund(paymentId, { amount: 0 });
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.error).toMatchObject({ code: 'validation_error', field: 'amount' });

    expect(await refundRows(paymentId)).toHaveLength(0);
  });
});

describe('idempotency (rule 2)', () => {
  it('the same key twice refunds once and replays the first response', async () => {
    const paymentId = await capturedPayment();
    const key = randomUUID();

    const first = await refund(paymentId, { amount: 20_000 }, { key });
    const second = await refund(paymentId, { amount: 20_000 }, { key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await refundRows(paymentId)).toHaveLength(1);
    expect(await paymentRow(paymentId)).toMatchObject({ amountRefunded: 20_000 });
  });

  it('the same key with a different amount is refused', async () => {
    const paymentId = await capturedPayment();
    const key = randomUUID();
    await refund(paymentId, { amount: 20_000 }, { key });

    const res = await refund(paymentId, { amount: 10_000 }, { key });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_mismatch');
    expect(await refundRows(paymentId)).toHaveLength(1);
  });
});

describe('no over-refunds (rule 6)', () => {
  it('two simultaneous refunds that together exceed the amount: only one succeeds', async () => {
    const paymentId = await capturedPayment();

    const responses = await Promise.all([
      refund(paymentId, { amount: 30_000 }),
      refund(paymentId, { amount: 30_000 }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(responses.find((r) => r.status === 201)?.body.status).toBe('processed');
    expect(responses.find((r) => r.status === 422)?.body.error.code).toBe('invalid_state');

    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 30_000,
    });
    const refunds = await refundRows(paymentId);
    expect(refunds).toHaveLength(1);
    expect(await refundLedger(refunds[0]!.id)).toHaveLength(1);
  });

  it('ten simultaneous refunds never add up to more than the payment', async () => {
    const paymentId = await capturedPayment();

    // 7 × 7,000 = 49,000 fits in 50,000; an 8th would not.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => refund(paymentId, { amount: 7_000 })),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(7);
    expect(statuses.filter((s) => s === 422)).toHaveLength(3);

    const refunds = await refundRows(paymentId);
    expect(refunds).toHaveLength(7);
    expect(refunds.every((r) => r.status === 'processed')).toBe(true);
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 49_000,
    });
    expect(await getMerchantBalance(db, merchant.merchant.id)).toBe(49_000 - 49_000);
  });
});

describe('when the bank declines', () => {
  it('fails the refund, releases the amount and sends refund.failed', async () => {
    // Section 10's test hook: refunds on this order fail.
    const paymentId = await capturedPayment({ notes: { fail_refund: true } });

    const res = await refund(paymentId, { amount: 20_000 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: 20_000,
      status: 'failed',
      failure_reason: 'refund_declined',
      processed_at: null,
    });
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'captured', amountRefunded: 0 });
    expect(await refundLedger(res.body.id)).toEqual([]);
    expect(await getMerchantBalance(db, merchant.merchant.id)).toBe(49_000);
    expect((await eventsFor(res.body.id)).map((e) => e.type)).toEqual(['refund.failed']);

    // The whole amount can be asked for again: nothing stayed reserved.
    const again = await refund(paymentId);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ amount: 50_000, status: 'failed' });
  });
});

describe('GET /v1/refunds/:id', () => {
  it('shows the refund to its merchant only', async () => {
    const paymentId = await capturedPayment();
    const created = await refund(paymentId, { amount: 5_000 });
    const other = await merchantWithKey(db);

    const res = await getRefund(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);

    expect((await getRefund(created.body.id, other.apiKey.key)).status).toBe(404);
    expect((await getRefund('rfnd_doesnotexist00')).status).toBe(404);
    expect((await getRefund(paymentId)).status).toBe(404);
  });
});

describe('the ledger after refunds', () => {
  it('has no unbalanced transaction anywhere', async () => {
    const unbalanced = await db.$queryRaw<{ transaction_id: string }[]>`
      SELECT transaction_id
        FROM ledger_entries
       GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`;
    expect(unbalanced).toEqual([]);
  });
});
