import type { Logger } from 'pino';
import type { Payment, Prisma, PrismaClient } from '@gateway/db';
import { NotFoundError, calculateFee, isId, newId } from '@gateway/shared';
import type { AuthorizeRequest, BankAnswer, BankClient } from '../fake-bank';
import { recordEvent } from './events';
import { moveTo } from './payment-state';

/** What it takes to move a payment through the bank. */
export interface PaymentDeps {
  db: PrismaClient;
  bank: BankClient;
  /** FEE_BPS: our fee in basis points. */
  feeBps: number;
  /** BANK_TIMEOUT_MS: how long we wait for the bank before the answer counts as unknown. */
  bankTimeoutMs: number;
}

/**
 * Another merchant's payment is "not found", never "forbidden", so IDs can't be probed.
 * Every merchant-owned lookup follows this shape: filter by id AND merchant_id.
 */
export async function getPayment(
  db: PrismaClient,
  merchantId: string,
  paymentId: string,
): Promise<Payment> {
  const payment = isId('pay', paymentId)
    ? await db.payment.findFirst({ where: { id: paymentId, merchantId } })
    : null;
  if (!payment) throw new NotFoundError('Payment');
  return payment;
}

/**
 * Sends a pending payment to the bank and applies its answer. Never call it inside a transaction
 * (rule 11). If the bank is too slow, fails, or says "pending", the payment stays pending and the
 * status-check job asks again later: no answer means unknown, never failed (rule 10).
 * Card payments need the customer's OTP.
 */
export async function authorizeWithBank(
  deps: PaymentDeps,
  payment: Payment,
  log: Logger,
  otp?: string,
): Promise<Payment> {
  let answer: BankAnswer | undefined;
  try {
    answer = await deps.bank.authorize(bankRequest(payment, otp), {
      signal: AbortSignal.timeout(deps.bankTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      log.info({ payment_id: payment.id }, 'bank did not answer in time; payment stays pending');
    } else {
      log.error({ err, payment_id: payment.id }, 'bank call failed; payment stays pending');
    }
  }
  if (answer) await applyBankAnswer(deps, payment.id, answer);
  return deps.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
}

/** Only the last four digits of a card go to the bank; the full number was dropped at checkout. */
function bankRequest(payment: Payment, otp: string | undefined): AuthorizeRequest {
  const base = { gatewayReference: payment.id, amount: payment.amount };
  if (payment.method === 'upi' && payment.vpa) {
    return { ...base, method: 'upi', vpa: payment.vpa };
  }
  if (payment.method === 'card' && payment.cardLast4 && otp !== undefined) {
    return { ...base, method: 'card', cardLast4: payment.cardLast4, otp };
  }
  throw new Error(`Payment ${payment.id} is missing details the bank needs`);
}

/**
 * Applies the bank's final answer to a pending payment: approved → captured, declined → failed.
 * The pay request, the OTP request and the status-check job all end up here, sometimes at the same
 * moment; the row lock and the status check turn the second caller into a no-op. A "pending"
 * answer changes nothing. Returns true if this call changed the payment.
 */
export function applyBankAnswer(
  deps: Pick<PaymentDeps, 'db' | 'feeBps'>,
  paymentId: string,
  answer: BankAnswer,
): Promise<boolean> {
  switch (answer.status) {
    case 'pending':
      return Promise.resolve(false);
    case 'approved':
      return resolvePendingPayment(deps, paymentId, { approved: true, bankRef: answer.bankRef });
    case 'declined':
      return resolvePendingPayment(deps, paymentId, {
        approved: false,
        reason: answer.declineReason ?? 'declined',
        bankRef: answer.bankRef,
      });
  }
}

/**
 * Status checks gave up: the bank never gave a final answer (section 9.9). If it approved the
 * payment after all, reconciliation flags it. Returns true if this call changed the payment.
 */
export function failTimedOutPayment(
  deps: Pick<PaymentDeps, 'db' | 'feeBps'>,
  paymentId: string,
  bankRef: string | null,
): Promise<boolean> {
  return resolvePendingPayment(deps, paymentId, {
    approved: false,
    reason: 'bank_timeout',
    bankRef,
  });
}

type Resolution =
  { approved: true; bankRef: string } | { approved: false; reason: string; bankRef: string | null };

async function resolvePendingPayment(
  { db, feeBps }: Pick<PaymentDeps, 'db' | 'feeBps'>,
  paymentId: string,
  resolution: Resolution,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (payment.status !== 'pending') return false; // Someone else resolved it first.

    if (resolution.approved) {
      await capturePayment(tx, payment, resolution.bankRef, feeBps);
    } else {
      await failPayment(tx, payment, resolution.reason, resolution.bankRef);
    }
    return true;
  });
}

/**
 * Locks the payment's order, then the payment (SELECT … FOR UPDATE), so anyone else locking them
 * waits until our transaction ends. Every transaction that locks both takes the order first, as
 * startPayment does. Taken the other way round, a capture holding the payment could wait for the
 * order while a new attempt holding the order waits on the capture: a deadlock.
 */
async function lockPayment(tx: Prisma.TransactionClient, paymentId: string): Promise<Payment> {
  await tx.$queryRaw`
    SELECT 1 FROM orders
     WHERE id = (SELECT order_id FROM payments WHERE id = ${paymentId})
       FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 FROM payments WHERE id = ${paymentId} FOR UPDATE`;
  return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

/**
 * Capture (section 9.1, step 7), all inside the caller's transaction so it commits whole or not at
 * all (rule 4): the payment is authorized and captured with its fee, the order is paid, the ledger
 * records who owes whom, and the outbox gets payment.captured.
 */
async function capturePayment(
  tx: Prisma.TransactionClient,
  payment: Payment,
  bankRef: string,
  feeBps: number,
): Promise<Payment> {
  const now = new Date();
  const fee = calculateFee(payment.amount, feeBps);
  const authorized = await moveTo(tx, payment, 'authorized', { bankRef, authorizedAt: now });
  const captured = await moveTo(tx, authorized, 'captured', { fee, capturedAt: now });
  await markOrderPaid(tx, captured.orderId, now);
  await postCaptureToLedger(tx, captured, fee);
  await recordEvent(tx, captured.merchantId, 'payment.captured', paymentResource(captured));
  return captured;
}

/** A declined payment (or one we gave up on) and its payment.failed event, in one transaction. */
async function failPayment(
  tx: Prisma.TransactionClient,
  payment: Payment,
  reason: string,
  bankRef: string | null,
): Promise<Payment> {
  const failed = await moveTo(tx, payment, 'failed', {
    failureReason: reason,
    ...(bankRef !== null && { bankRef }),
  });
  await recordEvent(tx, failed.merchantId, 'payment.failed', paymentResource(failed));
  return failed;
}

/** Only a captured payment pays an order, and an order is paid only once (section 9.3). */
async function markOrderPaid(tx: Prisma.TransactionClient, orderId: string, paidAt: Date) {
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: 'attempted' },
    data: { status: 'paid', paidAt },
  });
  if (count === 0) throw new Error(`Order ${orderId} is not waiting for a payment`);
}

/**
 * The capture's ledger entries (section 9.4). We hold the whole amount in clearing; we owe the
 * merchant the amount minus the fee, and keep the fee. Step 11 moves this into the ledger service.
 */
async function postCaptureToLedger(tx: Prisma.TransactionClient, payment: Payment, fee: number) {
  const merchantBalance = `merchant_balance:${payment.merchantId}`;
  const accounts = await tx.ledgerAccount.findMany({
    where: { code: { in: ['gateway_clearing', 'fee_revenue', merchantBalance] } },
  });
  const accountId = (code: string) => {
    const account = accounts.find((a) => a.code === code);
    if (!account) throw new Error(`Ledger account ${code} does not exist`);
    return account.id;
  };

  const entries = [
    { accountId: accountId('gateway_clearing'), direction: 'debit', amount: payment.amount },
    { accountId: accountId(merchantBalance), direction: 'credit', amount: payment.amount - fee },
    { accountId: accountId('fee_revenue'), direction: 'credit', amount: fee },
  ] as const;

  await tx.ledgerTransaction.create({
    data: {
      id: newId('ltx'),
      type: 'capture',
      referenceType: 'payment',
      referenceId: payment.id,
      // Entry amounts must be positive, so a zero fee (FEE_BPS=0) gets no entry.
      entries: { create: entries.filter((e) => e.amount > 0) },
    },
  });
}

/** The public JSON shape of a payment. Internal columns (merchant, bank bookkeeping) stay out. */
export function paymentResource(p: Payment) {
  return {
    id: p.id,
    order_id: p.orderId,
    amount: p.amount,
    fee: p.fee,
    amount_refunded: p.amountRefunded,
    currency: p.currency,
    method: p.method,
    vpa: p.vpa,
    card_last4: p.cardLast4,
    card_network: p.cardNetwork,
    status: p.status,
    failure_reason: p.failureReason,
    authorized_at: p.authorizedAt?.toISOString() ?? null,
    captured_at: p.capturedAt?.toISOString() ?? null,
    created_at: p.createdAt.toISOString(),
  };
}
