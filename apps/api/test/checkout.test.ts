import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@gateway/shared';
import type { PrismaClient } from '@gateway/db';
import { testPrisma } from '@gateway/db/testing';
import { merchantWithKey, newCheckoutOrder, testApp, type CheckoutOrder } from './helpers';

let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = testPrisma();
  app = testApp(db);
  merchant = await merchantWithKey(db);
});

afterAll(async () => {
  await db.$disconnect();
});

// Both pass the Luhn check. The last four digits pick the fake bank's answer.
const APPROVED_CARD = '4111111111111111';
const DECLINED_CARD = '4000000000000002';

const newOrder = (body: object = {}) => newCheckoutOrder(app, merchant.apiKey.key, body);

/** cs: null sends no client secret at all. */
function getOrder(order: CheckoutOrder, cs: string | null = order.cs) {
  return request(app)
    .get(`/checkout/orders/${order.id}`)
    .query(cs === null ? {} : { cs });
}

function pay(order: CheckoutOrder, body: object) {
  return request(app).post(`/checkout/orders/${order.id}/pay`).query({ cs: order.cs }).send(body);
}

function submitOtp(order: CheckoutOrder, paymentId: string, otp = '123456') {
  return request(app)
    .post(`/checkout/payments/${paymentId}/otp`)
    .query({ cs: order.cs })
    .send({ otp });
}

function getPayment(order: CheckoutOrder, paymentId: string, cs = order.cs) {
  return request(app).get(`/checkout/payments/${paymentId}`).query({ cs });
}

const upi = (vpa: string) => ({ method: 'upi', vpa });

const card = (number: string) => ({
  method: 'card',
  card: {
    number,
    expiry_month: 12,
    expiry_year: new Date().getUTCFullYear() + 1,
    name: 'Test Customer',
  },
});

async function ledgerFor(paymentId: string) {
  const transactions = await db.ledgerTransaction.findMany({
    where: { referenceType: 'payment', referenceId: paymentId },
    include: { entries: { include: { account: true } } },
  });
  return transactions.map((t) => ({
    type: t.type,
    entries: t.entries
      .map((e) => ({ account: e.account.code, direction: e.direction, amount: e.amount }))
      .sort((a, b) => a.account.localeCompare(b.account)),
  }));
}

function eventsFor(paymentId: string) {
  return db.event.findMany({
    where: { payload: { path: ['object', 'id'], equals: paymentId } },
    orderBy: { createdAt: 'asc' },
  });
}

describe('GET /checkout/orders/:id', () => {
  it('shows the amount, merchant name and status to a caller with the client secret', async () => {
    const order = await newOrder();

    const res = await getOrder(order);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: order.id,
      amount: 50_000,
      currency: 'INR',
      status: 'created',
      merchant_name: 'Test Merchant',
      latest_payment: null,
    });
  });

  it('is "not found" without the right client secret, so order IDs cannot be probed', async () => {
    const order = await newOrder();
    const other = await newOrder();

    for (const cs of ['cs_wrong', other.cs, null]) {
      const res = await getOrder(order, cs);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect((await getOrder({ id: newId('order'), cs: order.cs })).status).toBe(404);
  });
});

describe('paying with UPI', () => {
  it('success@test: captures the payment, marks the order paid and takes the fee', async () => {
    const order = await newOrder();

    const res = await pay(order, upi('success@test'));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^pay_/),
      order_id: order.id,
      amount: 50_000,
      currency: 'INR',
      method: 'upi',
      vpa: 'success@test',
      card_last4: null,
      card_network: null,
      status: 'captured',
      failure_reason: null,
    });
    expect(await db.payment.findUniqueOrThrow({ where: { id: res.body.id } })).toMatchObject({
      fee: 1_000,
      bankRef: expect.stringMatching(/^bank_/),
      authorizedAt: expect.any(Date),
      capturedAt: expect.any(Date),
    });
    expect((await getOrder(order)).body).toMatchObject({
      status: 'paid',
      latest_payment: { id: res.body.id, status: 'captured' },
    });
  });

  it('writes the capture to the ledger and the outbox along with the payment (rule 4)', async () => {
    const order = await newOrder();

    const { body } = await pay(order, upi('success@test'));

    expect(await ledgerFor(body.id)).toEqual([
      {
        type: 'capture',
        entries: [
          { account: 'fee_revenue', direction: 'credit', amount: 1_000 },
          { account: 'gateway_clearing', direction: 'debit', amount: 50_000 },
          {
            account: `merchant_balance:${merchant.merchant.id}`,
            direction: 'credit',
            amount: 49_000,
          },
        ],
      },
    ]);
    const events = await eventsFor(body.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: expect.stringMatching(/^evt_/),
      merchantId: merchant.merchant.id,
      type: 'payment.captured',
      dispatchedAt: null,
      payload: { object: { id: body.id, status: 'captured', fee: 1_000 } },
    });
  });

  it("fail@test: fails with the bank's reason, and the customer can try again", async () => {
    const order = await newOrder();

    const failed = await pay(order, upi('fail@test'));

    expect(failed.status).toBe(201);
    expect(failed.body).toMatchObject({ status: 'failed', failure_reason: 'insufficient_funds' });
    expect(await ledgerFor(failed.body.id)).toEqual([]);
    expect((await eventsFor(failed.body.id)).map((e) => e.type)).toEqual(['payment.failed']);
    expect((await getOrder(order)).body).toMatchObject({
      status: 'attempted',
      latest_payment: { id: failed.body.id, status: 'failed' },
    });

    const retry = await pay(order, upi('success@test'));

    expect(retry.status).toBe(201);
    expect(retry.body.id).not.toBe(failed.body.id);
    expect(retry.body.status).toBe('captured');
    expect((await getOrder(order)).body).toMatchObject({
      status: 'paid',
      latest_payment: { id: retry.body.id, status: 'captured' },
    });
  });

  it('refuses to pay an order that is already paid', async () => {
    const order = await newOrder();
    await pay(order, upi('success@test'));

    const res = await pay(order, upi('success@test'));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_state');
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('a bank timeout leaves the payment pending, never failed (rule 10)', async () => {
    const order = await newOrder();

    const res = await pay(order, upi('slow@test'));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', failure_reason: null });
  });

  it('rejects a malformed body before creating anything', async () => {
    const order = await newOrder();

    const res = await pay(order, upi('not-a-vpa'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error', field: 'vpa' });
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('paying by card', () => {
  it('asks for an OTP, then captures, storing only the last four digits (rule 9)', async () => {
    const order = await newOrder();

    const started = await pay(order, card(APPROVED_CARD));

    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      method: 'card',
      vpa: null,
      card_last4: '1111',
      card_network: 'visa',
      status: 'otp_required',
    });
    const row = await db.payment.findUniqueOrThrow({ where: { id: started.body.id } });
    expect(JSON.stringify(row)).not.toContain(APPROVED_CARD);

    const done = await submitOtp(order, started.body.id);

    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: started.body.id, status: 'captured' });
    expect((await ledgerFor(started.body.id))[0]?.type).toBe('capture');
  });

  it('a wrong OTP fails the payment with otp_invalid', async () => {
    const order = await newOrder();
    const { body } = await pay(order, card(APPROVED_CARD));

    const res = await submitOtp(order, body.id, '000000');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'failed', failure_reason: 'otp_invalid' });
  });

  it('a card ending in 0002 is declined with card_declined', async () => {
    const order = await newOrder();
    const { body } = await pay(order, card(DECLINED_CARD));

    const res = await submitOtp(order, body.id);

    expect(res.body).toMatchObject({ card_last4: '0002', status: 'failed' });
    expect(res.body.failure_reason).toBe('card_declined');
  });

  it('refuses an OTP for a payment that is not waiting for one', async () => {
    const order = await newOrder();
    const { body } = await pay(order, upi('success@test'));

    const res = await submitOtp(order, body.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_state');
  });

  it('accepts only one of two OTPs sent at the same moment', async () => {
    const order = await newOrder();
    const { body } = await pay(order, card(APPROVED_CARD));

    const responses = await Promise.all([submitOtp(order, body.id), submitOtp(order, body.id)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await ledgerFor(body.id)).toHaveLength(1);
  });

  it('rejects an invalid card number without echoing it back', async () => {
    const order = await newOrder();
    const badNumber = '4111111111111112';

    const res = await pay(order, card(badNumber));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error', field: 'card.number' });
    expect(JSON.stringify(res.body)).not.toContain(badNumber);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('one payment attempt at a time (rule 5)', () => {
  it('two simultaneous card attempts on one order: only one goes through', async () => {
    const order = await newOrder();

    const responses = await Promise.all([
      pay(order, card(APPROVED_CARD)),
      pay(order, card(APPROVED_CARD)),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(responses.find((r) => r.status === 409)?.body.error.code).toBe('conflict');
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('ten simultaneous UPI attempts: one payment, captured once', async () => {
    const order = await newOrder();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => pay(order, upi('success@test'))),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    // The rest arrive while it is in flight (409) or after it is captured (422).
    expect(statuses.every((s) => [201, 409, 422].includes(s))).toBe(true);
    const payments = await db.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe('captured');
    expect(await ledgerFor(payments[0]!.id)).toHaveLength(1);
  });
});

describe('GET /checkout/payments/:id', () => {
  it("shows the payment only to a caller with its order's client secret", async () => {
    const order = await newOrder();
    const other = await newOrder();
    const { body } = await pay(order, upi('success@test'));

    const res = await getPayment(order, body.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect((await getPayment(order, body.id, other.cs)).status).toBe(404);
    expect((await getPayment(order, newId('pay'))).status).toBe(404);
  });
});
