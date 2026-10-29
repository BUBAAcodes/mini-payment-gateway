import { setTimeout as sleep } from 'node:timers/promises';
import type { BankTransaction, BankTransactionType, PrismaClient } from '@gateway/db';
import { randomBase62 } from '@gateway/shared';
import type { BankAnswer, BankClient } from './bank-client';
import { decideAuthorization, decideRefund, type Decision } from './scenarios';
import { istDayBounds, toSettlementCsv } from './settlement-file';

export interface FakeBankOptions {
  /** How long ordinary answers take. Default 1 second. */
  normalDelayMs?: number;
  /** BANK_SLOW_MS: how long slow@test takes, longer than the gateway is willing to wait. */
  slowDelayMs: number;
  /** The bank's clock. Tests move it by hand instead of waiting. */
  now?: () => Date;
}

/**
 * A pretend bank. It keeps its own records in bank_transactions, apart from our payments, so
 * reconciliation has two independent sources to compare.
 *
 * Each request is decided the moment it arrives (scenarios.ts) and recorded with decided_at set
 * to when that decision takes effect; until then the bank says "pending". Only the caller waits,
 * so a decision survives a caller that gave up, or a server restart.
 */
export function createFakeBank(db: PrismaClient, options: FakeBankOptions): BankClient {
  const { normalDelayMs = 1000, slowDelayMs, now = () => new Date() } = options;

  async function record(
    type: BankTransactionType,
    gatewayReference: string,
    amount: number,
    decision: Decision,
  ): Promise<BankTransaction> {
    const delayMs = decision.delay === 'slow' ? slowDelayMs : normalDelayMs;
    // ON CONFLICT DO NOTHING: a repeated request for the same reference gets the first record.
    await db.bankTransaction.createMany({
      data: {
        bankRef: newBankRef(),
        gatewayReference,
        type,
        amount,
        outcome: decision.outcome,
        declineReason: decision.declineReason,
        decidedAt: new Date(now().getTime() + delayMs),
        callbackSent: decision.tellsGateway,
      },
      skipDuplicates: true,
    });
    return db.bankTransaction.findUniqueOrThrow({
      where: { gatewayReference_type: { gatewayReference, type } },
    });
  }

  /** Waits until the record is decided, then answers. The signal can cut the wait short. */
  async function answerWhenDecided(
    row: BankTransaction,
    signal?: AbortSignal,
  ): Promise<BankAnswer> {
    const waitMs = (row.decidedAt ?? now()).getTime() - now().getTime();
    if (waitMs > 0) await sleep(waitMs, undefined, { signal });
    return answer(row, true);
  }

  return {
    async authorize(request, { signal } = {}) {
      signal?.throwIfAborted();
      const decision = decideAuthorization(request);
      const row = await record('payment', request.gatewayReference, request.amount, decision);
      return answerWhenDecided(row, signal);
    },

    async getStatus(gatewayReference) {
      const row = await db.bankTransaction.findFirst({ where: { gatewayReference } });
      if (!row) return { status: 'not_found' };
      return answer(row, row.decidedAt !== null && row.decidedAt <= now());
    },

    async refund(request, { signal } = {}) {
      signal?.throwIfAborted();
      const decision = decideRefund({
        failRefund: await refundShouldFail(db, request.paymentReference),
      });
      const row = await record('refund', request.gatewayReference, request.amount, decision);
      return answerWhenDecided(row, signal);
    },

    async settlementFile(bankDate) {
      const { start, end } = istDayBounds(bankDate);
      // Only what is decided by now: a slow payment still in flight isn't on today's file yet.
      const rows = await db.bankTransaction.findMany({
        where: { decidedAt: { gte: start, lt: end, lte: now() }, outcome: { not: 'pending' } },
        orderBy: [{ decidedAt: 'asc' }, { bankRef: 'asc' }],
      });
      return toSettlementCsv(bankDate, rows);
    },
  };
}

/** What the gateway gets told. lost@test never tells, so it stays "pending" for good. */
function answer(row: BankTransaction, decided: boolean): BankAnswer {
  const told = decided && row.callbackSent && row.outcome !== 'pending';
  return {
    bankRef: row.bankRef,
    status: told ? row.outcome : 'pending',
    declineReason: told ? row.declineReason : null,
  };
}

/**
 * Test hook from spec section 10: refunds fail when the order's notes say "fail_refund": true.
 * The one place the fake bank reads the gateway's tables; a real bank would never see notes.
 */
async function refundShouldFail(db: PrismaClient, paymentReference: string): Promise<boolean> {
  const payment = await db.payment.findUnique({
    where: { id: paymentReference },
    select: { order: { select: { notes: true } } },
  });
  const notes = payment?.order.notes;
  return (
    typeof notes === 'object' &&
    notes !== null &&
    !Array.isArray(notes) &&
    notes.fail_refund === true
  );
}

function newBankRef(): string {
  return `bank_${randomBase62(14)}`;
}
