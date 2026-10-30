import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { isolatedTestPrisma } from '@gateway/db/testing';
import { newId } from '@gateway/shared';
import { createFakeBank } from '../src/fake-bank';
import { checkPendingRefunds, claimPendingRefunds } from '../src/jobs/refund-status-checks';
import { createLogger } from '../src/logger';
import { applyRefundAnswer, type RefundDeps } from '../src/services/refunds';
import { merchantWithKey, newCheckoutOrder, testApp, testConfig } from './helpers';

const SLOW_MS = 20_000;
const MINUTE = 60_000;
const log = createLogger('silent');

let db: PrismaClient;
let deps: RefundDeps;
/** Its bank answers at once. */
let app: ReturnType<typeof testApp>;
/** Its bank takes SLOW_MS to decide anything, so every refund request outlasts our timeout. */
let slowApp: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;
/** The fake banks' clock. Tests move it by hand instead of waiting. */
let clock: Date;

beforeAll(async () => {
  // A database of this file's own: the job claims every pending refund, including ones other
  // test files are in the middle of making.
  db = await isolatedTestPrisma();
  const now = () => clock;
  const bank = createFakeBank(db, { normalDelayMs: 0, slowDelayMs: SLOW_MS, now });
  const slowBank = createFakeBank(db, { normalDelayMs: SLOW_MS, slowDelayMs: SLOW_MS, now });
  deps = { db, bank, bankTimeoutMs: testConfig.BANK_TIMEOUT_MS };
  app = testApp(db, { bank });
  slowApp = testApp(db, { bank: slowBank });
  merchant = await merchantWithKey(db);
});

beforeEach(() => {
  clock = new Date();
});

afterAll(async () => {
  await db.$disconnect();
});

/** One run of the job as if it were `now`. minAgeMs 0: no refund request here is still waiting. */
function runChecks(now = new Date()) {
  return checkPendingRefunds(deps, log, { minAgeMs: 0, now: () => now });
}

async function capturedPayment(): Promise<string> {
  const order = await newCheckoutOrder(app, merchant.apiKey.key);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa: 'success@test' });
  expect(res.body.status).toBe('captured');
  return res.body.id;
}

function refund(target: ReturnType<typeof testApp>, paymentId: string, body: object = {}) {
  return request(target)
    .post(`/v1/payments/${paymentId}/refunds`)
    .set('Authorization', `Bearer ${merchant.apiKey.key}`)
    .set('Idempotency-Key', randomUUID())
    .send(body);
}

/**
 * A pending refund made directly in the database, with its amount reserved on the payment: as if
 * the server died after reserving it, before the bank heard about it.
 */
async function reservedRefund(paymentId: string, amount: number) {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.update({
      where: { id: paymentId },
      data: { amountRefunded: { increment: amount } },
    });
    return tx.refund.create({
      data: { id: newId('rfnd'), merchantId: payment.merchantId, paymentId, amount },
    });
  });
}

const refundRow = (id: string) => db.refund.findUniqueOrThrow({ where: { id } });
const paymentRow = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });

const ledgerCount = (id: string) =>
  db.ledgerTransaction.count({ where: { referenceType: 'refund', referenceId: id } });

async function eventTypes(id: string): Promise<string[]> {
  const events = await db.event.findMany({
    where: { payload: { path: ['object', 'id'], equals: id } },
    orderBy: { createdAt: 'asc' },
  });
  return events.map((e) => e.type);
}

describe('checkPendingRefunds', () => {
  it('a refund the bank was too slow to answer stays pending, then a check processes it', async () => {
    const paymentId = await capturedPayment();

    const res = await refund(slowApp, paymentId);

    // No answer in time means unknown, never failed (rule 10): the amount stays reserved.
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: 50_000, status: 'pending' });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 50_000,
    });

    // The bank hasn't decided yet.
    await runChecks();
    expect(await refundRow(res.body.id)).toMatchObject({ status: 'pending' });

    clock = new Date(clock.getTime() + SLOW_MS);
    const summary = await runChecks();

    expect(summary).toEqual({ checked: 1, resolved: 1, resent: 0 });
    expect(await refundRow(res.body.id)).toMatchObject({
      status: 'processed',
      bankRef: expect.stringMatching(/^bank_/),
      processedAt: expect.any(Date),
    });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'refunded',
      amountRefunded: 50_000,
    });
    expect(await ledgerCount(res.body.id)).toBe(1);
    expect(await eventTypes(res.body.id)).toEqual(['refund.processed']);
  });

  it('a refund the bank never received is sent again, and only once', async () => {
    const paymentId = await capturedPayment();
    const pending = await reservedRefund(paymentId, 20_000);

    const summary = await runChecks();

    expect(summary).toEqual({ checked: 1, resolved: 1, resent: 1 });
    expect(await refundRow(pending.id)).toMatchObject({ status: 'processed' });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 20_000,
    });
    expect(await ledgerCount(pending.id)).toBe(1);
    expect(await eventTypes(pending.id)).toEqual(['refund.processed']);

    // Nothing is left to do, and the bank booked the refund once.
    expect(await runChecks()).toEqual({ checked: 0, resolved: 0, resent: 0 });
    expect(
      await db.bankTransaction.count({ where: { gatewayReference: pending.id, type: 'refund' } }),
    ).toBe(1);
  });

  it('leaves a refund alone while its request may still be waiting on the bank', async () => {
    const paymentId = await capturedPayment();
    const res = await refund(slowApp, paymentId);
    clock = new Date(clock.getTime() + SLOW_MS);

    const summary = await checkPendingRefunds(deps, log, { minAgeMs: MINUTE });

    expect(summary.checked).toBe(0);
    expect(await refundRow(res.body.id)).toMatchObject({ status: 'pending' });
  });
});

describe('claimPendingRefunds', () => {
  it('two runs at the same time never claim the same refund, and a claim is a lease', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add((await reservedRefund(await capturedPayment(), 10_000)).id);
    }
    // Last touched an hour ago, so they are due for a check.
    await db.refund.updateMany({
      where: { id: { in: [...ids] } },
      data: { updatedAt: new Date(Date.now() - 60 * MINUTE) },
    });
    const options = { minAgeMs: MINUTE, now: () => new Date(), batchSize: 100 };

    const [first, second] = await Promise.all([
      claimPendingRefunds(db, options),
      claimPendingRefunds(db, options),
    ]);

    const claimed = [...first, ...second].map((r) => r.id).filter((id) => ids.has(id));
    expect(claimed.sort()).toEqual([...ids].sort());

    // Claiming touched them, so the next run within minAgeMs skips them.
    const third = await claimPendingRefunds(db, options);
    expect(third.filter((r) => ids.has(r.id))).toEqual([]);
  });
});

describe('applyRefundAnswer', () => {
  it('processes once, even when two callers apply the same approval at the same moment', async () => {
    const paymentId = await capturedPayment();
    const pending = await reservedRefund(paymentId, 50_000);
    const approval = { bankRef: 'bank_test', status: 'approved', declineReason: null } as const;

    const changed = await Promise.all([
      applyRefundAnswer(db, pending.id, approval),
      applyRefundAnswer(db, pending.id, approval),
    ]);

    expect(changed.sort()).toEqual([false, true]);
    expect(await refundRow(pending.id)).toMatchObject({ status: 'processed' });
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'refunded' });
    expect(await ledgerCount(pending.id)).toBe(1);
    expect(await eventTypes(pending.id)).toEqual(['refund.processed']);
  });

  it('marks the payment refunded only once processed refunds cover it, not reservations', async () => {
    const paymentId = await capturedPayment();
    const big = await reservedRefund(paymentId, 30_000);
    const small = await reservedRefund(paymentId, 20_000);
    const approval = { bankRef: 'bank_test', status: 'approved', declineReason: null } as const;

    // Everything is reserved, but only 30,000 is actually refunded.
    await applyRefundAnswer(db, big.id, approval);
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 50_000,
    });

    // The other one fails, so its 20,000 can be refunded again later.
    await applyRefundAnswer(db, small.id, {
      bankRef: 'bank_test',
      status: 'declined',
      declineReason: 'refund_declined',
    });
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'captured',
      amountRefunded: 30_000,
    });
    expect(await refundRow(small.id)).toMatchObject({
      status: 'failed',
      failureReason: 'refund_declined',
    });
    expect(await eventTypes(small.id)).toEqual(['refund.failed']);
  });

  it('does nothing to a refund that is no longer pending', async () => {
    const paymentId = await capturedPayment();
    const pending = await reservedRefund(paymentId, 20_000);
    const decline = { bankRef: 'bank_test', status: 'declined', declineReason: 'x' } as const;
    await applyRefundAnswer(db, pending.id, decline);

    expect(await applyRefundAnswer(db, pending.id, { ...decline, status: 'approved' })).toBe(false);

    expect(await refundRow(pending.id)).toMatchObject({ status: 'failed', failureReason: 'x' });
    expect(await paymentRow(paymentId)).toMatchObject({ amountRefunded: 0 });
    expect(await ledgerCount(pending.id)).toBe(0);
  });
});
