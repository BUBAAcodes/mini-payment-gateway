import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { createOrder, createPayment, isolatedTestPrisma } from '@gateway/db/testing';
import { newId } from '@gateway/shared';
import { createLogger } from '../src/logger';
import { getMerchantBalance, merchantBalanceAccount } from '../src/services/ledger';
import { settleAllMerchants, settleMerchant } from '../src/services/settlements';
import { merchantWithKey, newCheckoutOrder, testApp } from './helpers';

const DAY = 24 * 60 * 60_000;
const log = createLogger('silent');

// A database of this file's own: settling works across every merchant, so on the shared database
// it would pay out merchants that other test files are in the middle of checking.
let db: PrismaClient;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = await isolatedTestPrisma();
  app = testApp(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  // A merchant per test, so balances and settlements start from zero.
  merchant = await merchantWithKey(db);
});

/** Pays a new order with success@test and returns the captured payment's ID. */
async function capturedPayment(amount = 50_000): Promise<string> {
  const order = await newCheckoutOrder(app, merchant.apiKey.key, { amount });
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa: 'success@test' });
  expect(res.body.status).toBe('captured');
  return res.body.id;
}

async function processedRefund(paymentId: string, amount?: number): Promise<string> {
  const res = await request(app)
    .post(`/v1/payments/${paymentId}/refunds`)
    .set('Authorization', `Bearer ${merchant.apiKey.key}`)
    .set('Idempotency-Key', randomUUID())
    .send(amount === undefined ? {} : { amount });
  expect(res.body.status).toBe('processed');
  return res.body.id;
}

const settle = (now = new Date(), delayDays = 0) =>
  settleMerchant(db, merchant.merchant.id, { now, delayDays });

const balance = () => getMerchantBalance(db, merchant.merchant.id);

describe('settleMerchant', () => {
  it('pays out captures minus fees minus refunds: exactly what the ledger says we owe', async () => {
    const first = await capturedPayment(50_000);
    const second = await capturedPayment(30_000);
    const refund = await processedRefund(first, 20_000);
    // 49,000 + 29,400 owed for the captures, less the 20,000 refunded.
    expect(await balance()).toBe(58_400);

    const now = new Date();
    const settlement = await settle(now);

    expect(settlement).toMatchObject({
      merchantId: merchant.merchant.id,
      gross: 80_000,
      fees: 1_600,
      refunds: 20_000,
      net: 58_400,
      status: 'processed',
      periodEnd: now,
    });

    // The payout is one balanced ledger transaction for exactly the net.
    const payout = await db.ledgerTransaction.findFirstOrThrow({
      where: { referenceType: 'settlement', referenceId: settlement!.id },
      include: { entries: { include: { account: true } } },
    });
    expect(payout.type).toBe('payout');
    expect(payout.entries.map((e) => [e.account.code, e.direction, e.amount]).sort()).toEqual(
      [
        [merchantBalanceAccount(merchant.merchant.id), 'debit', 58_400],
        ['payouts', 'credit', 58_400],
      ].sort(),
    );
    expect(await balance()).toBe(0);

    // Every row it paid for is stamped with it.
    const stamped = await db.payment.findMany({
      where: { id: { in: [first, second] } },
      select: { settlementId: true },
    });
    expect(stamped).toEqual([{ settlementId: settlement!.id }, { settlementId: settlement!.id }]);
    expect(await db.refund.findUniqueOrThrow({ where: { id: refund } })).toMatchObject({
      settlementId: settlement!.id,
    });

    const event = await db.event.findFirstOrThrow({
      where: { merchantId: merchant.merchant.id, type: 'settlement.processed' },
    });
    expect(event.payload).toMatchObject({
      object: { id: settlement!.id, gross: 80_000, fees: 1_600, refunds: 20_000, net: 58_400 },
    });
  });

  it('settles nothing twice: a second run finds nothing to pay', async () => {
    await capturedPayment();
    expect(await settle()).not.toBeNull();
    expect(await settle()).toBeNull();
    expect(await db.settlement.count({ where: { merchantId: merchant.merchant.id } })).toBe(1);
  });

  it('a later run pays only what is new, starting where the last one ended', async () => {
    await capturedPayment(50_000);
    const first = await settle();
    await capturedPayment(30_000);
    const second = await settle();

    expect(second).toMatchObject({ gross: 30_000, fees: 600, refunds: 0, net: 29_400 });
    expect(second!.periodStart).toEqual(first!.periodEnd);
  });

  it('skips a merchant who owes us, and carries the refund into the next settlement', async () => {
    const payment = await capturedPayment(50_000);
    await settle();
    // A full refund of a payment already paid out: the merchant now owes us ₹500.
    const refund = await processedRefund(payment);
    expect(await balance()).toBe(-50_000);

    expect(await settle()).toBeNull();
    expect(await db.refund.findUniqueOrThrow({ where: { id: refund } })).toMatchObject({
      settlementId: null,
    });

    // The next capture pays the debt back first.
    await capturedPayment(100_000);
    expect(await balance()).toBe(48_000);
    const settlement = await settle();
    expect(settlement).toMatchObject({ gross: 100_000, fees: 2_000, refunds: 50_000, net: 48_000 });
    expect(await balance()).toBe(0);
  });

  it('with SETTLEMENT_DELAY_DAYS, waits until captures are old enough', async () => {
    await capturedPayment();
    const now = Date.now();

    expect(await settle(new Date(now), 2)).toBeNull();
    expect(await settle(new Date(now + 2 * DAY + 1_000), 2)).toMatchObject({ net: 49_000 });
  });

  it('two runs at once settle the merchant once', async () => {
    await capturedPayment();
    const results = await Promise.all([settle(), settle()]);

    expect(results.filter((s) => s !== null)).toHaveLength(1);
    expect(await db.settlement.count({ where: { merchantId: merchant.merchant.id } })).toBe(1);
    expect(await balance()).toBe(0);
  });
});

describe('settleAllMerchants', () => {
  it('settles every merchant with money owed, and one failure does not stop the rest', async () => {
    await capturedPayment();
    const idle = await merchantWithKey(db);

    // A merchant without a balance account: its payout can't be posted.
    const broken = await db.merchant.create({
      data: { id: newId('mer'), name: 'Broken', checkoutSigningSecret: 'v1:test' },
    });
    const order = await createOrder(db, broken.id);
    const payment = await createPayment(db, order, 'captured');
    await db.payment.update({
      where: { id: payment.id },
      data: { fee: 1_000, capturedAt: new Date() },
    });

    const result = await settleAllMerchants(db, log, { delayDays: 0 });

    expect(result.settled.map((s) => s.merchantId)).toContain(merchant.merchant.id);
    expect(result.settled.map((s) => s.merchantId)).not.toContain(idle.merchant.id);
    expect(result.failed).toEqual([broken.id]);
    // The broken merchant's rollback left its payment unpaid, for the next run.
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({
      settlementId: null,
    });

    // Fixed, it settles on the next run.
    await db.ledgerAccount.create({
      data: { code: merchantBalanceAccount(broken.id), type: 'liability', merchantId: broken.id },
    });
    const next = await settleAllMerchants(db, log, { delayDays: 0 });
    expect(next.failed).toEqual([]);
    expect(next.settled.map((s) => s.merchantId)).toEqual([broken.id]);
  });
});
