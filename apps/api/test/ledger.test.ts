import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@gateway/db';
import { createMerchant, testPrisma } from '@gateway/db/testing';
import { MAX_AMOUNT, MIN_AMOUNT, calculateFee, newId } from '@gateway/shared';
import { CORRECT_OTP, createFakeBank, type BankClient } from '../src/fake-bank';
import {
  getMerchantBalance,
  merchantBalanceAccount,
  postLedgerTransaction,
  type LedgerEntryInput,
} from '../src/services/ledger';
import { applyBankAnswer, type PaymentDeps } from '../src/services/payments';
import {
  merchantWithKey,
  newCheckoutOrder,
  testApp,
  testConfig,
  type CheckoutOrder,
} from './helpers';

const SLOW_MS = 20_000;

let db: PrismaClient;
let bank: BankClient;
let deps: PaymentDeps;
let app: ReturnType<typeof testApp>;
/** How far the fake bank's clock runs ahead of real time. Moved by hand for slow@test. */
let bankClockAheadMs = 0;

beforeAll(() => {
  db = testPrisma();
  bank = createFakeBank(db, {
    normalDelayMs: 0,
    slowDelayMs: SLOW_MS,
    now: () => new Date(Date.now() + bankClockAheadMs),
  });
  deps = { db, bank, feeBps: testConfig.FEE_BPS, bankTimeoutMs: testConfig.BANK_TIMEOUT_MS };
  app = testApp(db, { bank });
});

afterAll(async () => {
  await db.$disconnect();
});

function captureEntries(merchantId: string, amount: number, fee: number): LedgerEntryInput[] {
  return [
    { account: 'gateway_clearing', direction: 'debit', amount },
    { account: merchantBalanceAccount(merchantId), direction: 'credit', amount: amount - fee },
    { account: 'fee_revenue', direction: 'credit', amount: fee },
  ];
}

const paymentReference = () => ({
  type: 'capture' as const,
  referenceType: 'payment',
  referenceId: newId('pay'),
});

describe('postLedgerTransaction', () => {
  it('writes the transaction and its entries', async () => {
    const merchant = await createMerchant(db);
    const reference = paymentReference();

    const posted = await db.$transaction((tx) =>
      postLedgerTransaction(tx, reference, captureEntries(merchant.id, 50_000, 1_000)),
    );

    expect(posted).toMatchObject({ id: expect.stringMatching(/^ltx_/), ...reference });
    const entries = await db.ledgerEntry.findMany({
      where: { transactionId: posted.id },
      include: { account: true },
    });
    expect(
      entries
        .map((e) => ({ account: e.account.code, direction: e.direction, amount: e.amount }))
        .sort((a, b) => a.account.localeCompare(b.account)),
    ).toEqual([
      { account: 'fee_revenue', direction: 'credit', amount: 1_000 },
      { account: 'gateway_clearing', direction: 'debit', amount: 50_000 },
      { account: merchantBalanceAccount(merchant.id), direction: 'credit', amount: 49_000 },
    ]);
  });

  // Both checks look inside the still-open transaction. The database's balance trigger only runs
  // at COMMIT, so a zero there means the service refused before inserting anything.
  it('refuses unbalanced entries before writing anything', async () => {
    const merchant = await createMerchant(db);
    const reference = paymentReference();
    const unbalanced = captureEntries(merchant.id, 50_000, 1_000).slice(0, 2);

    await db.$transaction(async (tx) => {
      await expect(postLedgerTransaction(tx, reference, unbalanced)).rejects.toThrow(
        'Ledger entries do not balance: debits 50000, credits 49000',
      );
      expect(
        await tx.ledgerTransaction.count({ where: { referenceId: reference.referenceId } }),
      ).toBe(0);
    });
  });

  it('refuses an account that does not exist, before writing anything', async () => {
    const reference = paymentReference();
    const entries = captureEntries(newId('mer'), 50_000, 1_000);

    await db.$transaction(async (tx) => {
      await expect(postLedgerTransaction(tx, reference, entries)).rejects.toThrow(
        /Ledger account does not exist: merchant_balance:mer_/,
      );
      expect(
        await tx.ledgerTransaction.count({ where: { referenceId: reference.referenceId } }),
      ).toBe(0);
    });
  });
});

describe('getMerchantBalance', () => {
  it('is credits minus debits on the merchant_balance account', async () => {
    const merchant = await createMerchant(db);
    expect(await getMerchantBalance(db, merchant.id)).toBe(0);

    await db.$transaction((tx) =>
      postLedgerTransaction(tx, paymentReference(), captureEntries(merchant.id, 50_000, 1_000)),
    );
    expect(await getMerchantBalance(db, merchant.id)).toBe(49_000);

    // Refund ₹200 (section 9.4): the merchant gives back the full amount.
    await db.$transaction((tx) =>
      postLedgerTransaction(
        tx,
        { type: 'refund', referenceType: 'refund', referenceId: newId('rfnd') },
        [
          { account: merchantBalanceAccount(merchant.id), direction: 'debit', amount: 20_000 },
          { account: 'gateway_clearing', direction: 'credit', amount: 20_000 },
        ],
      ),
    );
    expect(await getMerchantBalance(db, merchant.id)).toBe(29_000);
  });
});

// ---------- A random mix of payments and refunds (steps 11 and 16, spec section 15) ----------

type Outcome =
  'upi_success' | 'upi_fail' | 'upi_slow' | 'card_approved' | 'card_wrong_otp' | 'card_declined';

const OUTCOMES: Outcome[] = [
  'upi_success',
  'upi_fail',
  'upi_slow',
  'card_approved',
  'card_wrong_otp',
  'card_declined',
];

const CAPTURED: Outcome[] = ['upi_success', 'upi_slow', 'card_approved'];

const VPAS: Partial<Record<Outcome, string>> = {
  upi_success: 'success@test',
  upi_fail: 'fail@test',
  upi_slow: 'slow@test',
};

// The fee is amount / 50 at 200 bps, so these sit on either side of the half-up boundaries.
const EDGE_AMOUNTS = [MIN_AMOUNT, 124, 125, 175, MAX_AMOUNT];

const APPROVED_CARD = '4111111111111111';
const DECLINED_CARD = '4000000000000002';

/** What happens to a payment once captured: partial refunds are for `refundPart` paise. */
type RefundPlan = 'none' | 'partial' | 'full' | 'partial_then_rest';

const REFUND_PLANS: RefundPlan[] = ['none', 'partial', 'full', 'partial_then_rest'];

interface PlannedPayment {
  amount: number;
  outcome: Outcome;
  refund: RefundPlan;
  /** Between 1 and amount - 1 paise. */
  refundPart: number;
}

/** mulberry32: a tiny seeded PRNG, so a failing mix can be replayed with the same seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * Every outcome once, every edge amount captured once (taking each refund plan in turn), then 20
 * random payments, shuffled. Run with LEDGER_MIX_SEED=<seed> to replay a failure.
 */
function planPayments(seed: number): PlannedPayment[] {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const randomAmount = () =>
    random() < 0.3
      ? pick(EDGE_AMOUNTS)
      : MIN_AMOUNT + Math.floor(random() * (MAX_AMOUNT - MIN_AMOUNT + 1));
  const planned = (amount: number, outcome: Outcome, refund = pick(REFUND_PLANS)) => ({
    amount,
    outcome,
    refund,
    refundPart: 1 + Math.floor(random() * (amount - 1)),
  });

  const plan: PlannedPayment[] = [
    ...OUTCOMES.map((outcome) => planned(randomAmount(), outcome)),
    ...EDGE_AMOUNTS.map((amount, i) =>
      planned(amount, 'upi_success', REFUND_PLANS[i % REFUND_PLANS.length]),
    ),
    ...Array.from({ length: 20 }, () => planned(randomAmount(), pick(OUTCOMES))),
  ];
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  return plan;
}

function pay(order: CheckoutOrder, body: object) {
  return request(app).post(`/checkout/orders/${order.id}/pay`).query({ cs: order.cs }).send(body);
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

/** Pays a new order the way the checkout page would, and returns the payment ID. */
async function makePayment(apiKey: string, { amount, outcome }: PlannedPayment): Promise<string> {
  const order = await newCheckoutOrder(app, apiKey, { amount });

  const vpa = VPAS[outcome];
  if (vpa) {
    const res = await pay(order, upi(vpa));
    expect(res.status).toBe(201);
    if (outcome === 'upi_slow') await resolveSlowPayment(res.body.id);
    return res.body.id;
  }

  const started = await pay(
    order,
    card(outcome === 'card_declined' ? DECLINED_CARD : APPROVED_CARD),
  );
  expect(started.body.status).toBe('otp_required');
  const otp = outcome === 'card_wrong_otp' ? '000000' : CORRECT_OTP;
  const done = await request(app)
    .post(`/checkout/payments/${started.body.id}/otp`)
    .query({ cs: order.cs })
    .send({ otp });
  expect(done.status).toBe(200);
  return started.body.id;
}

/**
 * The pay request timed out, so the payment is pending. Moves the bank's clock past its decision
 * and does what the status-check job does for one payment. (The job itself would also claim
 * pending payments that other test files are still working with.)
 */
async function resolveSlowPayment(paymentId: string) {
  bankClockAheadMs = SLOW_MS;
  try {
    const answer = await bank.getStatus(paymentId);
    if (answer.status === 'not_found') throw new Error(`The bank never saw ${paymentId}`);
    expect(await applyBankAnswer(deps, paymentId, answer)).toBe(true);
  } finally {
    bankClockAheadMs = 0;
  }
}

/**
 * Refunds a captured payment as planned, through the merchant API. Returns the refunds' IDs and
 * what they add up to, checking each amount against the plan as it goes.
 */
async function makeRefunds(
  apiKey: string,
  payment: PlannedPayment & { id: string },
): Promise<{ ids: string[]; total: number }> {
  // undefined: no amount in the request, so the refund is for whatever is left.
  const requests: { amount?: number; expected: number }[] = {
    none: [],
    partial: [{ amount: payment.refundPart, expected: payment.refundPart }],
    full: [{ expected: payment.amount }],
    partial_then_rest: [
      { amount: payment.refundPart, expected: payment.refundPart },
      { expected: payment.amount - payment.refundPart },
    ],
  }[payment.refund];

  const ids: string[] = [];
  for (const { amount, expected } of requests) {
    const res = await request(app)
      .post(`/v1/payments/${payment.id}/refunds`)
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Idempotency-Key', randomUUID())
      .send(amount === undefined ? {} : { amount });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ amount: expected, status: 'processed' });
    ids.push(res.body.id);
  }
  return { ids, total: sum(requests.map((r) => r.expected)) };
}

const fullyRefunded = (p: PlannedPayment) =>
  p.refund === 'full' || p.refund === 'partial_then_rest';

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

const seed = Number(process.env.LEDGER_MIX_SEED ?? Math.floor(Math.random() * 2 ** 32));

describe('a random mix of payments and refunds', () => {
  it(`balances every ledger transaction and owes the merchant net captures less refunds (seed ${seed})`, async () => {
    const { merchant, apiKey } = await merchantWithKey(db);
    const plan = planPayments(seed);

    const made: (PlannedPayment & { id: string })[] = [];
    for (const planned of plan) {
      made.push({ ...planned, id: await makePayment(apiKey.key, planned) });
    }

    // Expected values come from the plan, not from what the database says it did.
    const captured = made.filter((p) => CAPTURED.includes(p.outcome));
    const fees = captured.map((p) => calculateFee(p.amount, testConfig.FEE_BPS));
    expect(captured.length).toBeGreaterThanOrEqual(EDGE_AMOUNTS.length + 2);

    const refundIds: string[] = [];
    let refundedTotal = 0;
    for (const p of captured) {
      const { ids, total } = await makeRefunds(apiKey.key, p);
      refundIds.push(...ids);
      refundedTotal += total;
    }
    expect(refundIds.length).toBeGreaterThanOrEqual(4);

    const payments = await db.payment.findMany({ where: { id: { in: made.map((p) => p.id) } } });
    const statusOf = new Map(payments.map((p) => [p.id, p.status]));
    for (const p of made) {
      const expected = !CAPTURED.includes(p.outcome)
        ? 'failed'
        : fullyRefunded(p)
          ? 'refunded'
          : 'captured';
      expect(statusOf.get(p.id), `${p.outcome} ${p.refund} ${p.id}`).toBe(expected);
    }

    const transactions = await db.ledgerTransaction.findMany({
      where: {
        OR: [
          { referenceType: 'payment', referenceId: { in: made.map((p) => p.id) } },
          { referenceType: 'refund', referenceId: { in: refundIds } },
        ],
      },
      include: { entries: { include: { account: true } } },
    });

    // Every transaction balances.
    for (const t of transactions) {
      const debits = sum(t.entries.filter((e) => e.direction === 'debit').map((e) => e.amount));
      const credits = sum(t.entries.filter((e) => e.direction === 'credit').map((e) => e.amount));
      expect(debits, `ledger transaction ${t.id}`).toBe(credits);
    }

    // One capture transaction per captured payment, none for failed ones, one per refund.
    const referencesOf = (type: string) =>
      transactions
        .filter((t) => t.type === type)
        .map((t) => t.referenceId)
        .sort();
    expect(referencesOf('capture')).toEqual(captured.map((p) => p.id).sort());
    expect(referencesOf('refund')).toEqual([...refundIds].sort());
    expect(transactions).toHaveLength(captured.length + refundIds.length);

    // The merchant is owed its net captures less what it refunded (fees are not given back); the
    // gateway took in the gross, paid out the refunds and keeps the fees.
    const netCaptures = sum(captured.map((p, i) => p.amount - fees[i]!));
    expect(await getMerchantBalance(db, merchant.id)).toBe(netCaptures - refundedTotal);

    const entries = transactions.flatMap((t) => t.entries);
    const total = (account: string, direction: 'debit' | 'credit') =>
      sum(
        entries
          .filter((e) => e.account.code === account && e.direction === direction)
          .map((e) => e.amount),
      );
    expect(total('gateway_clearing', 'debit')).toBe(sum(captured.map((p) => p.amount)));
    expect(total('gateway_clearing', 'credit')).toBe(refundedTotal);
    expect(total('fee_revenue', 'credit')).toBe(sum(fees));
  });

  it('leaves no unbalanced transaction anywhere in the ledger', async () => {
    const unbalanced = await db.$queryRaw<{ transaction_id: string }[]>`
      SELECT transaction_id
        FROM ledger_entries
       GROUP BY transaction_id
      HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`;
    expect(unbalanced).toEqual([]);
  });
});
