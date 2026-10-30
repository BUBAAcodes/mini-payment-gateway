import type { Logger } from 'pino';
import type { Payment, Prisma, PrismaClient, Refund } from '@gateway/db';
import {
  InvalidStateError,
  NotFoundError,
  isId,
  newId,
  type CreateRefundInput,
} from '@gateway/shared';
import type { BankAnswer, BankClient } from '../fake-bank';
import { recordEvent } from './events';
import { postRefund } from './ledger';
import { moveTo } from './payment-state';
import { getPayment } from './payments';

/** What it takes to send a refund to the bank. */
export interface RefundDeps {
  db: PrismaClient;
  bank: BankClient;
  /** BANK_TIMEOUT_MS: how long we wait for the bank before the answer counts as unknown. */
  bankTimeoutMs: number;
}

/** Another merchant's refund is "not found", the same as a payment (see getPayment). */
export async function getRefund(
  db: PrismaClient,
  merchantId: string,
  refundId: string,
): Promise<Refund> {
  const refund = isId('rfnd', refundId)
    ? await db.refund.findFirst({ where: { id: refundId, merchantId } })
    : null;
  if (!refund) throw new NotFoundError('Refund');
  return refund;
}

/**
 * Refunds a captured payment, in full or in part (section 9.5). Without an amount, the refund is
 * for whatever is left. Returns the refund as it stands once the bank has answered: processed or
 * failed, or still pending if the bank was too slow, in which case the status-check job finishes it.
 */
export async function createRefund(
  deps: RefundDeps,
  merchantId: string,
  paymentId: string,
  input: CreateRefundInput,
  log: Logger,
): Promise<Refund> {
  const payment = await getPayment(deps.db, merchantId, paymentId);
  const refund = await reserveRefund(deps.db, payment.id, input.amount);
  // The refund is committed from here on, so nothing below may throw: an unexpected error would
  // release the Idempotency-Key, and the merchant's retry would refund a second time.
  return refundWithBank(deps, refund, log);
}

/**
 * In one transaction: lock the payment, check what is left to refund, create the refund (pending)
 * and raise amount_refunded by its amount. Refunds of one payment take turns on the lock, and each
 * one's amount stays reserved until the bank says no, so two refunds that each fit can never add
 * up to more than the payment (rule 6). A CHECK on amount_refunded backs this up.
 */
async function reserveRefund(
  db: PrismaClient,
  paymentId: string,
  amount: number | undefined,
): Promise<Refund> {
  return db.$transaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (payment.status !== 'captured') {
      throw new InvalidStateError(
        `Payment ${payment.id} is ${payment.status}; only captured payments can be refunded`,
      );
    }
    const left = payment.amount - payment.amountRefunded;
    if (left === 0) {
      throw new InvalidStateError(`Payment ${payment.id} has nothing left to refund`);
    }
    const refundAmount = amount ?? left;
    if (refundAmount > left) {
      throw new InvalidStateError(
        `Refund of ${refundAmount} paise is more than the ${left} paise left to refund`,
      );
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { amountRefunded: { increment: refundAmount } },
    });
    return tx.refund.create({
      data: {
        id: newId('rfnd'),
        merchantId: payment.merchantId,
        paymentId: payment.id,
        amount: refundAmount,
      },
    });
  });
}

/**
 * Asks the bank to make a pending refund and applies its answer. Never call it inside a
 * transaction (rule 11). It never throws: if the bank is too slow or fails, or its answer can't be
 * applied, the refund stays pending and the status-check job tries again. No answer means unknown,
 * never failed (rule 10). Returns the refund as it now stands.
 */
export async function refundWithBank(
  deps: RefundDeps,
  refund: Refund,
  log: Logger,
): Promise<Refund> {
  try {
    const answer = await deps.bank.refund(
      { gatewayReference: refund.id, paymentReference: refund.paymentId, amount: refund.amount },
      { signal: AbortSignal.timeout(deps.bankTimeoutMs) },
    );
    await applyRefundAnswer(deps.db, refund.id, answer);
    return await deps.db.refund.findUniqueOrThrow({ where: { id: refund.id } });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      log.info({ refund_id: refund.id }, 'bank did not answer in time; refund stays pending');
    } else {
      log.error({ err, refund_id: refund.id }, 'refund did not complete; it stays pending');
    }
    return refund;
  }
}

/**
 * Applies the bank's final answer to a pending refund: approved → processed, declined → failed.
 * The refund request and the status-check job can get here at the same moment; the payment lock
 * and the status check turn the second caller into a no-op. A "pending" answer changes nothing.
 * Returns true if this call changed the refund.
 */
export function applyRefundAnswer(
  db: PrismaClient,
  refundId: string,
  answer: BankAnswer,
): Promise<boolean> {
  if (answer.status === 'pending') return Promise.resolve(false);

  return db.$transaction(async (tx) => {
    // A refund never changes payment, so reading this before taking the lock is safe.
    const { paymentId } = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      select: { paymentId: true },
    });
    const payment = await lockPayment(tx, paymentId);
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.status !== 'pending') return false; // Someone else applied an answer first.

    if (answer.status === 'approved') {
      await processRefund(tx, payment, refund, answer.bankRef);
    } else {
      await failRefund(tx, refund, answer.declineReason ?? 'declined', answer.bankRef);
    }
    return true;
  });
}

/**
 * Locks the payment (SELECT … FOR UPDATE), so refunds of it take turns. Refunds never touch the
 * order, so unlike a capture they lock the payment alone. Every refund transaction locks the
 * payment before its refund rows, so two of them can't deadlock.
 */
async function lockPayment(tx: Prisma.TransactionClient, paymentId: string): Promise<Payment> {
  await tx.$queryRaw`SELECT 1 FROM payments WHERE id = ${paymentId} FOR UPDATE`;
  return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

/**
 * The bank paid the refund. All inside the caller's transaction, so it commits whole or not at all
 * (rule 4): the refund is processed, the ledger records it, the payment becomes refunded once
 * processed refunds cover all of it, and the outbox gets refund.processed.
 */
async function processRefund(
  tx: Prisma.TransactionClient,
  payment: Payment,
  refund: Refund,
  bankRef: string,
): Promise<Refund> {
  const processed = await tx.refund.update({
    where: { id: refund.id },
    data: { status: 'processed', bankRef, processedAt: new Date() },
  });
  await postRefund(tx, processed);

  // amount_refunded also counts refunds still waiting on the bank, any of which could fail, so it
  // can't say whether the payment is fully refunded. Only processed refunds count.
  const { _sum } = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: 'processed' },
    _sum: { amount: true },
  });
  if (_sum.amount === payment.amount) await moveTo(tx, payment, 'refunded');

  await recordEvent(tx, processed.merchantId, 'refund.processed', refundResource(processed));
  return processed;
}

/**
 * The bank refused the refund. In one transaction: the refund fails, its amount is no longer
 * reserved on the payment, and the outbox gets refund.failed. Nothing reached the ledger.
 */
async function failRefund(
  tx: Prisma.TransactionClient,
  refund: Refund,
  reason: string,
  bankRef: string,
): Promise<Refund> {
  const failed = await tx.refund.update({
    where: { id: refund.id },
    data: { status: 'failed', failureReason: reason, bankRef },
  });
  await tx.payment.update({
    where: { id: refund.paymentId },
    data: { amountRefunded: { decrement: refund.amount } },
  });
  await recordEvent(tx, failed.merchantId, 'refund.failed', refundResource(failed));
  return failed;
}

/** The public JSON shape of a refund. */
export function refundResource(r: Refund) {
  return {
    id: r.id,
    payment_id: r.paymentId,
    amount: r.amount,
    status: r.status,
    failure_reason: r.failureReason,
    processed_at: r.processedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}
