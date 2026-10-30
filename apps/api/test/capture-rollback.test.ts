import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@gateway/db';
import { createMerchant, createOrder, createPayment, testPrisma } from '@gateway/db/testing';
import { recordEvent } from '../src/services/events';
import { applyBankAnswer } from '../src/services/payments';
import { testConfig } from './helpers';

// recordEvent is the last write of a capture. This file wraps it so a test can make it fail after
// everything else, the event included, has been written inside the capture's transaction.
// Unless a test says otherwise it is the real function.
vi.mock('../src/services/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/events')>();
  return { ...actual, recordEvent: vi.fn(actual.recordEvent) };
});

const realEvents =
  await vi.importActual<typeof import('../src/services/events')>('../src/services/events');

const APPROVAL = { bankRef: 'bank_rollback', status: 'approved', declineReason: null } as const;

let db: PrismaClient;
let deps: { db: PrismaClient; feeBps: number };

beforeAll(() => {
  db = testPrisma();
  deps = { db, feeBps: testConfig.FEE_BPS };
});

afterAll(async () => {
  await db.$disconnect();
});

/** A payment waiting for the bank's answer, on an order that is waiting for a payment. */
async function pendingPayment() {
  const merchant = await createMerchant(db);
  const order = await createOrder(db, merchant.id);
  await db.order.update({ where: { id: order.id }, data: { status: 'attempted' } });
  return createPayment(db, order, 'pending');
}

/** Everything a capture writes, read through `client` (inside or outside the transaction). */
async function captureState(client: Prisma.TransactionClient, paymentId: string) {
  const payment = await client.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: { order: true },
  });
  const ledgerReference = { referenceType: 'payment', referenceId: paymentId };
  return {
    payment: {
      status: payment.status,
      fee: payment.fee,
      bankRef: payment.bankRef,
      authorizedAt: payment.authorizedAt,
      capturedAt: payment.capturedAt,
    },
    order: { status: payment.order.status, paidAt: payment.order.paidAt },
    ledgerTransactions: await client.ledgerTransaction.count({ where: ledgerReference }),
    ledgerEntries: await client.ledgerEntry.count({ where: { transaction: ledgerReference } }),
    events: await client.event.count({
      where: { payload: { path: ['object', 'id'], equals: paymentId } },
    }),
  };
}

/**
 * The next capture writes its event for real, records what its open transaction holds at that
 * moment, then throws. Returns a getter for that snapshot.
 */
function failNextCaptureAfterLastWrite(paymentId: string) {
  let insideTransaction: Awaited<ReturnType<typeof captureState>> | undefined;
  vi.mocked(recordEvent).mockImplementationOnce(async (tx, ...rest) => {
    await realEvents.recordEvent(tx, ...rest);
    insideTransaction = await captureState(tx, paymentId);
    throw new Error('forced failure in the middle of a capture');
  });
  return () => insideTransaction;
}

describe('a capture that fails part-way (rule 4)', () => {
  it('leaves no payment change, no ledger rows and no event', async () => {
    const payment = await pendingPayment();
    const before = await captureState(db, payment.id);
    const insideTransaction = failNextCaptureAfterLastWrite(payment.id);

    await expect(applyBankAnswer(deps, payment.id, APPROVAL)).rejects.toThrow(
      'forced failure in the middle of a capture',
    );

    // It really got that far: every write had happened inside the transaction...
    expect(insideTransaction()).toEqual({
      payment: {
        status: 'captured',
        fee: 1_000,
        bankRef: 'bank_rollback',
        authorizedAt: expect.any(Date),
        capturedAt: expect.any(Date),
      },
      order: { status: 'paid', paidAt: expect.any(Date) },
      ledgerTransactions: 1,
      ledgerEntries: 3,
      events: 1,
    });
    // ...and none of it survived.
    expect(before).toEqual({
      payment: {
        status: 'pending',
        fee: null,
        bankRef: null,
        authorizedAt: null,
        capturedAt: null,
      },
      order: { status: 'attempted', paidAt: null },
      ledgerTransactions: 0,
      ledgerEntries: 0,
      events: 0,
    });
    expect(await captureState(db, payment.id)).toEqual(before);
  });

  it('stays pending, so the next try captures it exactly once', async () => {
    const payment = await pendingPayment();
    failNextCaptureAfterLastWrite(payment.id);
    await expect(applyBankAnswer(deps, payment.id, APPROVAL)).rejects.toThrow();

    // What the status-check job does on its next run.
    expect(await applyBankAnswer(deps, payment.id, APPROVAL)).toBe(true);

    expect(await captureState(db, payment.id)).toMatchObject({
      payment: { status: 'captured', fee: 1_000 },
      order: { status: 'paid' },
      ledgerTransactions: 1,
      ledgerEntries: 3,
      events: 1,
    });
  });
});
