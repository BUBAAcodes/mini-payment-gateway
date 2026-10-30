import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateFee, decryptSecret, sha256Hex } from '@gateway/shared';
import type { PrismaClient } from '../src/generated/prisma/client';
import { DEMO_LOGIN, demoWebhookUrl, seedDemo, type SeedCreated } from '../src/seed';
import { testPrisma } from '../src/testing';

const encryptionKey = randomBytes(32).toString('base64');
const options = { encryptionKey, feeBps: 200, storeBaseUrl: 'http://store.test' };

let prisma: PrismaClient;
let seeded: SeedCreated;

beforeAll(async () => {
  prisma = testPrisma();
  const result = await seedDemo(prisma, options);
  if (result.status !== 'created') throw new Error('expected a fresh seed');
  seeded = result;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('seedDemo', () => {
  it('creates the demo merchant with an encrypted checkout signing secret', async () => {
    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: seeded.merchantId } });
    expect(merchant.name).toBe('Demo Store');
    expect(merchant.checkoutSigningSecret).not.toContain(seeded.checkoutSecret);
    expect(decryptSecret(merchant.checkoutSigningSecret, encryptionKey)).toBe(
      seeded.checkoutSecret,
    );
    await expect(
      prisma.ledgerAccount.findUniqueOrThrow({
        where: { code: `merchant_balance:${seeded.merchantId}` },
      }),
    ).resolves.toMatchObject({ type: 'liability', merchantId: seeded.merchantId });
  });

  it('stores the API key only as a prefix and a hash', async () => {
    expect(seeded.apiKey).toMatch(/^sk_test_[0-9A-Za-z]{32}$/);
    const keys = await prisma.apiKey.findMany({ where: { merchantId: seeded.merchantId } });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      prefix: seeded.apiKey.slice(0, 12),
      keyHash: sha256Hex(seeded.apiKey),
      revokedAt: null,
    });
  });

  it('points the demo webhook endpoint at the store, or at an override for Docker', () => {
    expect(demoWebhookUrl({ storeBaseUrl: 'http://localhost:3001/' })).toBe(
      'http://localhost:3001/webhooks/gateway',
    );
    // In Docker the browser uses localhost:3001, but the API container reaches the store by name.
    expect(
      demoWebhookUrl({
        storeBaseUrl: 'http://localhost:3001',
        webhookUrl: 'http://demo-store:3001/webhooks/gateway',
      }),
    ).toBe('http://demo-store:3001/webhooks/gateway');
  });

  it('creates a webhook endpoint for the demo store with an encrypted secret', async () => {
    const endpoint = await prisma.webhookEndpoint.findFirstOrThrow({
      where: { merchantId: seeded.merchantId },
    });
    expect(endpoint).toMatchObject({
      url: 'http://store.test/webhooks/gateway',
      eventTypes: ['*'],
      enabled: true,
    });
    expect(seeded.webhookSecret).toMatch(/^whsec_/);
    expect(decryptSecret(endpoint.secret, encryptionKey)).toBe(seeded.webhookSecret);
  });

  it('creates a dashboard login with a Better Auth scrypt password hash', async () => {
    expect(seeded.login).toEqual(DEMO_LOGIN);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: DEMO_LOGIN.email },
      include: { accounts: true },
    });
    expect(user.merchantId).toBe(seeded.merchantId);
    expect(user.accounts).toHaveLength(1);

    const account = user.accounts[0]!;
    expect(account).toMatchObject({ providerId: 'credential', accountId: user.id });
    const [salt, key] = account.password!.split(':');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toMatch(/^[0-9a-f]{128}$/);
    // Better Auth: scrypt(NFKC password, hex salt string, N=16384, r=16, p=1, 64 bytes).
    const expected = scryptSync(DEMO_LOGIN.password.normalize('NFKC'), salt!, 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    expect(key).toBe(expected.toString('hex'));
  });

  it('creates captured, failed and partially refunded sample payments', async () => {
    const payments = await prisma.payment.findMany({
      where: { merchantId: seeded.merchantId },
      include: { order: true, refunds: true },
      orderBy: { amount: 'asc' },
    });

    expect(
      payments.map((p) => [p.method, p.amount, p.status, p.amountRefunded, p.order.status]),
    ).toEqual([
      ['upi', 30_000, 'failed', 0, 'attempted'],
      ['upi', 50_000, 'captured', 0, 'paid'],
      ['card', 120_000, 'captured', 0, 'paid'],
      ['upi', 200_000, 'captured', 50_000, 'paid'],
    ]);

    for (const p of payments.filter((p) => p.status === 'captured')) {
      expect(p.fee).toBe(calculateFee(p.amount, 200));
      expect(p.capturedAt).not.toBeNull();
      expect(p.bankRef).not.toBeNull();
    }
    const failed = payments[0]!;
    expect(failed).toMatchObject({ fee: null, failureReason: 'insufficient_funds' });

    const card = payments[2]!;
    expect(card).toMatchObject({ cardLast4: '1111', cardNetwork: 'visa', vpa: null });

    const refunded = payments[3]!;
    expect(refunded.refunds).toHaveLength(1);
    expect(refunded.refunds[0]).toMatchObject({ amount: 50_000, status: 'processed' });
  });

  it('posts ledger entries so the merchant balance is net captures minus refunds', async () => {
    const entries = await prisma.ledgerEntry.findMany({
      where: { account: { code: `merchant_balance:${seeded.merchantId}` } },
    });
    const balance = entries.reduce(
      (sum, e) => sum + (e.direction === 'credit' ? e.amount : -e.amount),
      0,
    );
    // (50,000 − 1,000) + (1,20,000 − 2,400) + (2,00,000 − 4,000) − 50,000 refunded
    expect(balance).toBe(312_600);
  });

  it('balances every ledger transaction it wrote', async () => {
    const references = await prisma.payment.findMany({
      where: { merchantId: seeded.merchantId },
      select: { id: true, refunds: { select: { id: true } } },
    });
    const referenceIds = references.flatMap((p) => [p.id, ...p.refunds.map((r) => r.id)]);
    const transactions = await prisma.ledgerTransaction.findMany({
      where: { referenceId: { in: referenceIds } },
      include: { entries: true },
    });

    expect(transactions.map((t) => t.type).sort()).toEqual([
      'capture',
      'capture',
      'capture',
      'refund',
    ]);
    for (const t of transactions) {
      const debits = t.entries
        .filter((e) => e.direction === 'debit')
        .reduce((s, e) => s + e.amount, 0);
      const credits = t.entries
        .filter((e) => e.direction === 'credit')
        .reduce((s, e) => s + e.amount, 0);
      expect(debits).toBe(credits);
    }
  });

  it('writes outbox events that are already dispatched, so no webhooks go out for them', async () => {
    const events = await prisma.event.findMany({ where: { merchantId: seeded.merchantId } });
    expect(events.map((e) => e.type).sort()).toEqual([
      'payment.captured',
      'payment.captured',
      'payment.captured',
      'payment.failed',
      'refund.processed',
    ]);
    expect(events.every((e) => e.dispatchedAt !== null)).toBe(true);
  });

  it("mirrors each payment and refund in the fake bank's own records", async () => {
    const payments = await prisma.payment.findMany({
      where: { merchantId: seeded.merchantId },
      include: { refunds: true },
    });
    for (const p of payments) {
      const bankTxn = await prisma.bankTransaction.findFirstOrThrow({
        where: { gatewayReference: p.id },
      });
      expect(bankTxn).toMatchObject({
        type: 'payment',
        amount: p.amount,
        outcome: p.status === 'failed' ? 'declined' : 'approved',
        declineReason: p.failureReason,
        callbackSent: true,
      });
      if (p.bankRef) expect(bankTxn.bankRef).toBe(p.bankRef);
      for (const r of p.refunds) {
        await expect(
          prisma.bankTransaction.findFirstOrThrow({ where: { gatewayReference: r.id } }),
        ).resolves.toMatchObject({ type: 'refund', amount: r.amount, outcome: 'approved' });
      }
    }
  });

  it('does nothing the second time', async () => {
    await expect(seedDemo(prisma, options)).resolves.toEqual({ status: 'already_seeded' });
    expect(await prisma.merchant.count({ where: { name: 'Demo Store' } })).toBe(1);
    expect(await prisma.user.count({ where: { email: DEMO_LOGIN.email } })).toBe(1);
    expect(await prisma.payment.count({ where: { merchantId: seeded.merchantId } })).toBe(4);
  });
});
