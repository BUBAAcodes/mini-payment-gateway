import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@gateway/shared';
import type { LedgerAccount, PrismaClient } from '../src/generated/prisma/client';
import { createMerchant, systemAccount, testPrisma } from './helpers';

let prisma: PrismaClient;
let clearing: LedgerAccount;
let feeRevenue: LedgerAccount;
let merchantBalance: LedgerAccount;

beforeAll(async () => {
  prisma = testPrisma();
  clearing = await systemAccount(prisma, 'gateway_clearing');
  feeRevenue = await systemAccount(prisma, 'fee_revenue');
  const merchant = await createMerchant(prisma);
  merchantBalance = await prisma.ledgerAccount.create({
    data: { code: `merchant_balance:${merchant.id}`, type: 'liability', merchantId: merchant.id },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function newLedgerTransaction() {
  return {
    id: newId('ltx'),
    type: 'capture' as const,
    referenceType: 'payment',
    referenceId: newId('pay'),
  };
}

/** Posts a balanced ₹500 capture with a ₹10 fee (section 9.4) and returns its transaction ID. */
async function postBalancedCapture(): Promise<string> {
  const ltx = newLedgerTransaction();
  await prisma.$transaction(async (tx) => {
    await tx.ledgerTransaction.create({ data: ltx });
    await tx.ledgerEntry.createMany({
      data: [
        { transactionId: ltx.id, accountId: clearing.id, direction: 'debit', amount: 50_000 },
        {
          transactionId: ltx.id,
          accountId: merchantBalance.id,
          direction: 'credit',
          amount: 49_000,
        },
        { transactionId: ltx.id, accountId: feeRevenue.id, direction: 'credit', amount: 1_000 },
      ],
    });
  });
  return ltx.id;
}

describe('system ledger accounts', () => {
  it('exist in every environment, created by the migration', async () => {
    const accounts = await prisma.ledgerAccount.findMany({
      where: { code: { in: ['gateway_clearing', 'fee_revenue', 'payouts'] } },
      orderBy: { code: 'asc' },
    });
    expect(accounts.map((a) => [a.code, a.type, a.merchantId])).toEqual([
      ['fee_revenue', 'revenue', null],
      ['gateway_clearing', 'asset', null],
      ['payouts', 'asset', null],
    ]);
  });
});

describe('ledger balance trigger', () => {
  it('commits a balanced transaction, even though rows go in one at a time', async () => {
    const ltxId = await postBalancedCapture();
    expect(await prisma.ledgerEntry.count({ where: { transactionId: ltxId } })).toBe(3);
  });

  it('rejects an unbalanced transaction at commit, not at insert', async () => {
    const ltx = newLedgerTransaction();
    let insertSucceeded = false;

    const attempt = prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({ data: ltx });
      await tx.ledgerEntry.create({
        data: { transactionId: ltx.id, accountId: clearing.id, direction: 'debit', amount: 50_000 },
      });
      // The insert itself is allowed: the check is deferred until COMMIT.
      insertSucceeded = true;
    });

    await expect(attempt).rejects.toThrow(/unbalanced/);
    expect(insertSucceeded).toBe(true);
    // The whole transaction rolled back.
    expect(await prisma.ledgerTransaction.count({ where: { id: ltx.id } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: ltx.id } })).toBe(0);
  });

  it('rejects a transaction that is off by a single paisa', async () => {
    const ltx = newLedgerTransaction();
    const attempt = prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({ data: ltx });
      await tx.ledgerEntry.createMany({
        data: [
          { transactionId: ltx.id, accountId: clearing.id, direction: 'debit', amount: 50_000 },
          {
            transactionId: ltx.id,
            accountId: merchantBalance.id,
            direction: 'credit',
            amount: 48_999,
          },
          { transactionId: ltx.id, accountId: feeRevenue.id, direction: 'credit', amount: 1_000 },
        ],
      });
    });
    await expect(attempt).rejects.toThrow(/unbalanced/);
  });

  it('rejects a later one-sided entry added to an already balanced transaction', async () => {
    const ltxId = await postBalancedCapture();
    const attempt = prisma.ledgerEntry.create({
      data: { transactionId: ltxId, accountId: clearing.id, direction: 'debit', amount: 1 },
    });
    await expect(attempt).rejects.toThrow(/unbalanced/);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: ltxId } })).toBe(3);
  });
});

describe('ledger is append-only', () => {
  it('rejects updating a ledger entry', async () => {
    const ltxId = await postBalancedCapture();
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { transactionId: ltxId } });

    await expect(
      prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amount: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`UPDATE ledger_entries SET amount = amount WHERE id = ${entry.id}::uuid`,
    ).rejects.toThrow(/append-only/);

    const unchanged = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(unchanged.amount).toBe(entry.amount);
  });

  it('rejects deleting a ledger entry', async () => {
    const ltxId = await postBalancedCapture();
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { transactionId: ltxId } });

    await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
    expect(await prisma.ledgerEntry.count({ where: { transactionId: ltxId } })).toBe(3);
  });

  it('rejects updating or deleting a ledger transaction', async () => {
    const ltxId = await postBalancedCapture();

    await expect(
      prisma.ledgerTransaction.update({ where: { id: ltxId }, data: { type: 'reversal' } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`DELETE FROM ledger_transactions WHERE id = ${ltxId}`,
    ).rejects.toThrow(/append-only/);
  });

  it('rejects TRUNCATE', async () => {
    // Inside a transaction that always rolls back, so a missing guard can't wipe shared data.
    for (const table of ['ledger_entries', 'ledger_transactions']) {
      const attempt = prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`);
        throw new Error(`TRUNCATE ${table} was allowed`);
      });
      await expect(attempt).rejects.toThrow(/append-only/);
    }
  });
});
