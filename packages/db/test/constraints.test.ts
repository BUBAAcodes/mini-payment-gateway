import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@gateway/shared';
import type { Merchant, PrismaClient } from '../src/generated/prisma/client';
import { createMerchant, createOrder, createPayment, systemAccount, testPrisma } from './helpers';

let prisma: PrismaClient;
let merchant: Merchant;

beforeAll(async () => {
  prisma = testPrisma();
  merchant = await createMerchant(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('orders.amount is between ₹1 and ₹5,00,000 (rule 1)', () => {
  it('accepts the boundaries', async () => {
    await expect(createOrder(prisma, merchant.id, 100)).resolves.toBeDefined();
    await expect(createOrder(prisma, merchant.id, 50_000_000)).resolves.toBeDefined();
  });

  it('rejects amounts just outside them', async () => {
    await expect(createOrder(prisma, merchant.id, 99)).rejects.toThrow(/orders_amount_range/);
    await expect(createOrder(prisma, merchant.id, 50_000_001)).rejects.toThrow(
      /orders_amount_range/,
    );
  });
});

describe('currency is INR only (rule 1)', () => {
  it('rejects another currency on orders and payments', async () => {
    await expect(
      prisma.order.create({
        data: {
          id: newId('order'),
          merchantId: merchant.id,
          amount: 50_000,
          currency: 'USD',
          clientSecretHash: 'h',
        },
      }),
    ).rejects.toThrow(/orders_currency_inr/);

    const order = await createOrder(prisma, merchant.id);
    await expect(
      prisma.payment.create({
        data: {
          id: newId('pay'),
          merchantId: merchant.id,
          orderId: order.id,
          amount: order.amount,
          currency: 'USD',
          method: 'upi',
        },
      }),
    ).rejects.toThrow(/payments_currency_inr/);
  });
});

describe('refunds.amount is positive', () => {
  it('rejects zero and negative refunds', async () => {
    const order = await createOrder(prisma, merchant.id);
    const payment = await createPayment(prisma, order, 'captured');
    for (const amount of [0, -100]) {
      await expect(
        prisma.refund.create({
          data: { id: newId('rfnd'), merchantId: merchant.id, paymentId: payment.id, amount },
        }),
      ).rejects.toThrow(/refunds_amount_positive/);
    }
  });
});

describe('ledger_entries.amount is positive', () => {
  it('rejects a zero entry, even inside a balanced transaction', async () => {
    const clearing = await systemAccount(prisma, 'gateway_clearing');
    const fees = await systemAccount(prisma, 'fee_revenue');
    const ltxId = newId('ltx');
    const attempt = prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({
        data: { id: ltxId, type: 'capture', referenceType: 'payment', referenceId: 'pay_x' },
      });
      await tx.ledgerEntry.createMany({
        data: [
          { transactionId: ltxId, accountId: clearing.id, direction: 'debit', amount: 0 },
          { transactionId: ltxId, accountId: fees.id, direction: 'credit', amount: 0 },
        ],
      });
    });
    await expect(attempt).rejects.toThrow(/ledger_entries_amount_positive/);
  });
});

describe('payments.amount_refunded stays within the amount (rule 6)', () => {
  it('rejects refunding more than the payment, or a negative total', async () => {
    const order = await createOrder(prisma, merchant.id, 50_000);
    const payment = await createPayment(prisma, order, 'captured');

    await expect(
      prisma.payment.update({ where: { id: payment.id }, data: { amountRefunded: 50_000 } }),
    ).resolves.toBeDefined();
    await expect(
      prisma.payment.update({ where: { id: payment.id }, data: { amountRefunded: 50_001 } }),
    ).rejects.toThrow(/payments_amount_refunded_range/);
    await expect(
      prisma.payment.update({ where: { id: payment.id }, data: { amountRefunded: -1 } }),
    ).rejects.toThrow(/payments_amount_refunded_range/);
  });
});

describe('one in-progress payment attempt per order (rule 5)', () => {
  it('is enforced by a partial unique index', async () => {
    const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_attempt'`;
    expect(index?.indexdef).toMatch(/^CREATE UNIQUE INDEX one_active_attempt ON public\.payments/);
    expect(index?.indexdef).toMatch(/created.*otp_required.*pending.*authorized/);
  });

  it('rejects a second in-progress attempt', async () => {
    const order = await createOrder(prisma, merchant.id);
    await createPayment(prisma, order, 'pending');

    for (const status of ['created', 'otp_required', 'pending', 'authorized'] as const) {
      await expect(createPayment(prisma, order, status)).rejects.toMatchObject({ code: 'P2002' });
    }
  });

  it('allows a new attempt once the previous one failed', async () => {
    const order = await createOrder(prisma, merchant.id);
    const first = await createPayment(prisma, order, 'pending');
    await prisma.payment.update({ where: { id: first.id }, data: { status: 'failed' } });

    await expect(createPayment(prisma, order, 'created')).resolves.toBeDefined();
  });

  it('allows any number of finished attempts', async () => {
    const order = await createOrder(prisma, merchant.id);
    await createPayment(prisma, order, 'failed');
    await createPayment(prisma, order, 'failed');
    await createPayment(prisma, order, 'captured');
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(3);
  });
});
