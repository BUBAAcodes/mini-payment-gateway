import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { createOrder, createPayment, isolatedTestPrisma } from '@gateway/db/testing';
import { createFakeBank } from '../src/fake-bank';
import { checkPendingPayments, claimPendingPayments } from '../src/jobs/payment-status-checks';
import { createLogger } from '../src/logger';
import { applyBankAnswer, type PaymentDeps } from '../src/services/payments';
import { merchantWithKey, newCheckoutOrder, testApp, testConfig } from './helpers';

const SLOW_MS = 20_000;
const MINUTE = 60_000;
const log = createLogger('silent');

let db: PrismaClient;
let deps: PaymentDeps;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;
/** The fake bank's clock. Tests move it by hand instead of waiting. */
let clock: Date;

beforeAll(async () => {
  // A database of this file's own: the job claims every pending payment, including ones other
  // test files are in the middle of paying.
  db = await isolatedTestPrisma();
  const bank = createFakeBank(db, { normalDelayMs: 0, slowDelayMs: SLOW_MS, now: () => clock });
  deps = { db, bank, feeBps: testConfig.FEE_BPS, bankTimeoutMs: testConfig.BANK_TIMEOUT_MS };
  app = testApp(db, { bank });
  merchant = await merchantWithKey(db);
});

beforeEach(() => {
  clock = new Date();
});

afterAll(async () => {
  await db.$disconnect();
});

/** One run of the job as if it were `now`. minAgeMs 0: no pay request here is still waiting. */
function runChecks(now = new Date()) {
  return checkPendingPayments(deps, log, { minAgeMs: 0, now: () => now });
}

async function payWithUpi(vpa: string): Promise<string> {
  const order = await newCheckoutOrder(app, merchant.apiKey.key);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa });
  expect(res.status).toBe(201);
  return res.body.id;
}

const paymentRow = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });

const ledgerCount = (id: string) =>
  db.ledgerTransaction.count({ where: { referenceType: 'payment', referenceId: id } });

async function eventTypes(id: string): Promise<string[]> {
  const events = await db.event.findMany({
    where: { payload: { path: ['object', 'id'], equals: id } },
    orderBy: { createdAt: 'asc' },
  });
  return events.map((e) => e.type);
}

/** A pending payment made directly in the database, as if its pay request had died. */
async function pendingPayment() {
  const order = await createOrder(db, merchant.merchant.id);
  await db.order.update({ where: { id: order.id }, data: { status: 'attempted' } });
  return createPayment(db, order, 'pending');
}

describe('checkPendingPayments', () => {
  it('slow@test: the pay request times out, then a status check captures it', async () => {
    const id = await payWithUpi('slow@test');
    expect(await paymentRow(id)).toMatchObject({ status: 'pending', bankStatusChecks: 0 });

    // The bank hasn't decided yet.
    await runChecks();
    expect(await paymentRow(id)).toMatchObject({ status: 'pending', bankStatusChecks: 1 });

    clock = new Date(clock.getTime() + SLOW_MS);
    await runChecks();

    expect(await paymentRow(id)).toMatchObject({
      status: 'captured',
      fee: 1_000,
      bankStatusChecks: 2,
      bankRef: expect.stringMatching(/^bank_/),
    });
    expect(await ledgerCount(id)).toBe(1);
    expect(await eventTypes(id)).toEqual(['payment.captured']);
  });

  it('lost@test: keeps asking, then gives up after 15 minutes with bank_timeout', async () => {
    const id = await payWithUpi('lost@test');

    await runChecks(new Date(Date.now() + 14 * MINUTE));
    expect(await paymentRow(id)).toMatchObject({ status: 'pending', failureReason: null });

    await runChecks(new Date(Date.now() + 16 * MINUTE));

    expect(await paymentRow(id)).toMatchObject({
      status: 'failed',
      failureReason: 'bank_timeout',
      // Kept for reconciliation: the bank did see this payment.
      bankRef: expect.stringMatching(/^bank_/),
    });
    expect(await ledgerCount(id)).toBe(0);
    expect(await eventTypes(id)).toEqual(['payment.failed']);
  });

  it('leaves a payment alone while its pay request may still be waiting on the bank', async () => {
    const id = await payWithUpi('slow@test');

    await checkPendingPayments(deps, log, { minAgeMs: MINUTE });

    expect(await paymentRow(id)).toMatchObject({ status: 'pending', bankStatusChecks: 0 });
  });
});

describe('claimPendingPayments', () => {
  it('two runs at the same time never claim the same payment, and a claim is a lease', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await pendingPayment()).id);
    // Last touched an hour ago, so they are due for a check.
    await db.payment.updateMany({
      where: { id: { in: [...ids] } },
      data: { updatedAt: new Date(Date.now() - 60 * MINUTE) },
    });
    const options = { minAgeMs: MINUTE, now: () => new Date(), batchSize: 100 };

    const [first, second] = await Promise.all([
      claimPendingPayments(db, options),
      claimPendingPayments(db, options),
    ]);

    const claimed = [...first, ...second].map((p) => p.id).filter((id) => ids.has(id));
    expect(claimed.sort()).toEqual([...ids].sort());

    // Claiming touched them, so the next run within minAgeMs skips them.
    const third = await claimPendingPayments(db, options);
    expect(third.filter((p) => ids.has(p.id))).toEqual([]);
  });
});

describe('applyBankAnswer', () => {
  it('captures once, even when two callers apply the same approval at the same moment', async () => {
    const payment = await pendingPayment();
    const approval = { bankRef: 'bank_test', status: 'approved', declineReason: null } as const;

    await Promise.all([
      applyBankAnswer(deps, payment.id, approval),
      applyBankAnswer(deps, payment.id, approval),
    ]);

    expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured' });
    expect(await ledgerCount(payment.id)).toBe(1);
    expect(await eventTypes(payment.id)).toEqual(['payment.captured']);
  });

  it('does nothing to a payment that is no longer pending', async () => {
    const payment = await pendingPayment();
    const decline = { bankRef: 'bank_test', status: 'declined', declineReason: 'x' } as const;
    await applyBankAnswer(deps, payment.id, decline);

    await applyBankAnswer(deps, payment.id, { ...decline, status: 'approved' });

    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', failureReason: 'x' });
    expect(await ledgerCount(payment.id)).toBe(0);
  });
});
