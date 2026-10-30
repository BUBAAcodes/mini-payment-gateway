import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { isolatedTestPrisma } from '@gateway/db/testing';
import { ValidationError } from '@gateway/shared';
import { createFakeBank, type BankClient } from '../src/fake-bank';
import { istDate, istDayBounds, SETTLEMENT_CSV_HEADER } from '../src/fake-bank/settlement-file';
import { checkPendingPayments } from '../src/jobs/payment-status-checks';
import { createLogger } from '../src/logger';
import { reconcile, reconcileDay } from '../src/services/reconciliation';
import { merchantWithKey, newCheckoutOrder, testApp, testConfig } from './helpers';

const log = createLogger('silent');

// A database of this file's own: a bank file holds every merchant's transactions for the day.
let db: PrismaClient;
let bank: BankClient;
let app: ReturnType<typeof testApp>;
let merchant: Awaited<ReturnType<typeof merchantWithKey>>;

beforeAll(async () => {
  db = await isolatedTestPrisma();
  bank = createFakeBank(db, { normalDelayMs: 0, slowDelayMs: 60_000 });
  app = testApp(db, { bank });
  merchant = await merchantWithKey(db);
});

afterAll(async () => {
  await db.$disconnect();
});

const today = () => istDate(new Date());

async function pay(vpa: string): Promise<string> {
  const order = await newCheckoutOrder(app, merchant.apiKey.key);
  const res = await request(app)
    .post(`/checkout/orders/${order.id}/pay`)
    .query({ cs: order.cs })
    .send({ method: 'upi', vpa });
  expect(res.status).toBe(201);
  return res.body.id;
}

const issuesFor = (gatewayReference: string) =>
  db.reconciliationIssue.findMany({ where: { gatewayReference } });

describe('reconcileDay', () => {
  it('lost@test: the bank approved a payment we gave up on → status_mismatch', async () => {
    const id = await pay('lost@test');
    expect(await db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'pending',
    });

    // Status checks hear nothing but "pending", then give up (section 9.9).
    const deps = {
      db,
      bank,
      feeBps: testConfig.FEE_BPS,
      bankTimeoutMs: testConfig.BANK_TIMEOUT_MS,
    };
    await checkPendingPayments(deps, log, { minAgeMs: 0, giveUpAfterMs: 0 });
    expect(await db.payment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'failed',
      failureReason: 'bank_timeout',
    });

    await reconcileDay({ db, bank }, today());

    const issues = await issuesFor(id);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'status_mismatch',
      merchantId: merchant.merchant.id,
      details: { type: 'payment', bank_status: 'success', gateway_status: 'failed' },
      resolvedAt: null,
    });
    expect(issues[0]!.bankRef).toMatch(/^bank_/);
  });

  it('finds nothing wrong with payments and refunds both sides agree on', async () => {
    const captured = await pay('success@test');
    const declined = await pay('fail@test');
    const refund = await request(app)
      .post(`/v1/payments/${captured}/refunds`)
      .set('Authorization', `Bearer ${merchant.apiKey.key}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 10_000 });
    expect(refund.body.status).toBe('processed');

    await reconcileDay({ db, bank }, today());

    for (const id of [captured, declined, refund.body.id]) {
      expect(await issuesFor(id)).toEqual([]);
    }
  });

  it('imports the file and its rows, and a re-run replaces them without repeating issues', async () => {
    const id = await pay('lost@test');
    const first = await reconcileDay({ db, bank }, today());
    // Still pending on our side, approved on the bank's.
    expect(await issuesFor(id)).toMatchObject([{ kind: 'status_mismatch' }]);

    const second = await reconcileDay({ db, bank }, today());
    expect(second.issuesCreated).toBe(0);
    expect(second.rows).toBeGreaterThanOrEqual(first.rows);
    expect(await issuesFor(id)).toHaveLength(1);

    const file = await db.bankSettlementFile.findUniqueOrThrow({
      where: { bankDate: new Date(`${today()}T00:00:00Z`) },
      include: { rows: true },
    });
    expect(file.rows).toHaveLength(second.rows);
    expect(file.rows.map((r) => r.gatewayReference)).toContain(id);
    expect(file.csvText.startsWith(SETTLEMENT_CSV_HEADER)).toBe(true);
  });

  it('flags bank rows we never heard of, amounts that differ, and ours the bank never paid', async () => {
    const bankDate = '2026-01-15';
    const { start } = istDayBounds(bankDate);
    const wrongAmount = await pay('success@test');
    const unknownToBank = await pay('success@test');
    // Captured that day, as far as our records go.
    await db.payment.updateMany({
      where: { id: { in: [wrongAmount, unknownToBank] } },
      data: { capturedAt: new Date(start.getTime() + 60_000) },
    });

    const crafted: BankClient = {
      ...bank,
      settlementFile: async (date) =>
        [
          SETTLEMENT_CSV_HEADER,
          `bank_X1,pay_neverHeardOfIt,payment,25000,success,${date}`,
          `bank_X2,${wrongAmount},payment,49000,success,${date}`,
          '',
        ].join('\n'),
    };
    const result = await reconcileDay({ db, bank: crafted }, bankDate);
    expect(result).toEqual({ bankDate, rows: 2, issuesCreated: 3 });

    expect(await issuesFor('pay_neverHeardOfIt')).toMatchObject([
      { kind: 'missing_in_gateway', merchantId: null, bankRef: 'bank_X1' },
    ]);
    expect(await issuesFor(wrongAmount)).toMatchObject([
      {
        kind: 'amount_mismatch',
        merchantId: merchant.merchant.id,
        details: { bank_amount: 49_000, gateway_amount: 50_000 },
      },
    ]);
    expect(await issuesFor(unknownToBank)).toMatchObject([
      { kind: 'missing_in_bank', merchantId: merchant.merchant.id, bankRef: null },
    ]);
  });

  it('refuses a malformed file and leaves nothing half imported', async () => {
    const bankDate = '2026-01-16';
    const broken: BankClient = { ...bank, settlementFile: async () => 'not,a,settlement,file\n' };

    await expect(reconcileDay({ db, bank: broken }, bankDate)).rejects.toThrow(/header/);
    expect(
      await db.bankSettlementFile.count({ where: { bankDate: new Date(`${bankDate}T00:00:00Z`) } }),
    ).toBe(0);
  });
});

describe('reconcile', () => {
  beforeEach(async () => {
    await db.bankSettlementRow.deleteMany();
    await db.bankSettlementFile.deleteMany();
  });

  const at = (iso: string) => new Date(iso);
  const days = (results: { bankDate: string }[]) => results.map((r) => r.bankDate);

  it('with no imports yet, reconciles yesterday (India time)', async () => {
    // 01:30 IST on 5 November.
    const results = await reconcile({ db, bank }, { now: at('2026-11-04T20:00:00Z') });
    expect(days(results)).toEqual(['2026-11-04']);
  });

  it('catches up every day since the last import, re-importing that day too', async () => {
    await reconcileDay({ db, bank }, '2026-10-31');
    const results = await reconcile({ db, bank }, { now: at('2026-11-05T06:00:00Z') });
    expect(days(results)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('catches up at most 7 days', async () => {
    await reconcileDay({ db, bank }, '2026-09-01');
    const results = await reconcile({ db, bank }, { now: at('2026-11-05T06:00:00Z') });
    expect(days(results)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('after a run for today, still reconciles yesterday', async () => {
    await reconcileDay({ db, bank }, '2026-11-05');
    const results = await reconcile({ db, bank }, { now: at('2026-11-05T06:00:00Z') });
    expect(days(results)).toEqual(['2026-11-04']);
  });

  it('reconciles just the day asked for, but never a day still to come', async () => {
    const now = at('2026-11-05T06:00:00Z');
    const results = await reconcile({ db, bank }, { bankDate: '2026-11-05', now });
    expect(days(results)).toEqual(['2026-11-05']);

    await expect(reconcile({ db, bank }, { bankDate: '2026-11-06', now })).rejects.toThrow(
      ValidationError,
    );
  });
});
