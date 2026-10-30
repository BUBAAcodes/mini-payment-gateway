import { randomBytes, scrypt } from 'node:crypto';
import {
  calculateFee,
  encryptSecret,
  generateApiKey,
  generateCheckoutSecret,
  generateClientSecret,
  generateWebhookSecret,
  newId,
  randomBase62,
  sha256Hex,
} from '@gateway/shared';
import type { Payment, Prisma, PrismaClient, Refund } from './generated/prisma/client';

/** The demo dashboard login. Not a secret: the README shows it next to the live demo link. */
export const DEMO_LOGIN = { email: 'demo@gateway.test', password: 'demo-password' } as const;

export interface SeedOptions {
  /** APP_ENCRYPTION_KEY: encrypts the webhook and checkout signing secrets. */
  encryptionKey: string;
  feeBps: number;
  /** The demo store's public URL; the webhook endpoint points at it. */
  storeBaseUrl: string;
  /**
   * Where the API sends the demo store's webhooks, if not {storeBaseUrl}/webhooks/gateway. In
   * Docker the browser reaches the store at localhost:3001, but the API container must use the
   * service name: http://demo-store:3001/webhooks/gateway.
   */
  webhookUrl?: string;
}

/** The URL the demo webhook endpoint points at. */
export function demoWebhookUrl({
  storeBaseUrl,
  webhookUrl,
}: Pick<SeedOptions, 'storeBaseUrl' | 'webhookUrl'>): string {
  return webhookUrl || `${storeBaseUrl.replace(/\/+$/, '')}/webhooks/gateway`;
}

export interface SeedCreated {
  status: 'created';
  merchantId: string;
  apiKey: string;
  webhookSecret: string;
  checkoutSecret: string;
  login: { email: string; password: string };
}

export type SeedResult = SeedCreated | { status: 'already_seeded' };

interface SamplePayment {
  receipt: string;
  amount: number;
  minutesAgo: number;
  method: 'upi' | 'card';
  vpa?: string;
  card?: { last4: string; network: string };
  outcome: 'captured' | 'failed';
  refund?: number;
}

// Enough history that the dashboard never looks empty.
const SAMPLE_PAYMENTS: SamplePayment[] = [
  {
    receipt: 'demo_1001',
    amount: 50_000,
    minutesAgo: 90,
    method: 'upi',
    vpa: 'success@test',
    outcome: 'captured',
  },
  {
    receipt: 'demo_1002',
    amount: 120_000,
    minutesAgo: 60,
    method: 'card',
    card: { last4: '1111', network: 'visa' },
    outcome: 'captured',
  },
  {
    receipt: 'demo_1003',
    amount: 30_000,
    minutesAgo: 45,
    method: 'upi',
    vpa: 'fail@test',
    outcome: 'failed',
  },
  {
    receipt: 'demo_1004',
    amount: 200_000,
    minutesAgo: 30,
    method: 'upi',
    vpa: 'success@test',
    outcome: 'captured',
    refund: 50_000,
  },
];

/**
 * Creates the demo merchant, its API key, webhook endpoint, dashboard login and sample payments,
 * all in one transaction. Returns the plaintext secrets, which exist nowhere else afterwards.
 * Does nothing if the demo login already exists.
 */
export async function seedDemo(prisma: PrismaClient, options: SeedOptions): Promise<SeedResult> {
  if (await prisma.user.findUnique({ where: { email: DEMO_LOGIN.email } })) {
    return { status: 'already_seeded' };
  }

  // The slow hash runs before the transaction opens, so it holds no connection while it works.
  const passwordHash = await hashPassword(DEMO_LOGIN.password);
  const merchantId = newId('mer');
  const apiKey = generateApiKey();
  const checkoutSecret = generateCheckoutSecret();
  const webhookSecret = generateWebhookSecret();
  const storeBaseUrl = options.storeBaseUrl.replace(/\/+$/, '');

  await prisma.$transaction(
    async (tx) => {
      await tx.merchant.create({
        data: {
          id: merchantId,
          name: 'Demo Store',
          checkoutSigningSecret: encryptSecret(checkoutSecret, options.encryptionKey),
        },
      });
      const merchantBalance = await tx.ledgerAccount.create({
        data: { code: `merchant_balance:${merchantId}`, type: 'liability', merchantId },
      });
      await tx.apiKey.create({
        data: { id: newId('key'), merchantId, prefix: apiKey.prefix, keyHash: apiKey.hash },
      });
      await tx.webhookEndpoint.create({
        data: {
          id: newId('we'),
          merchantId,
          url: demoWebhookUrl(options),
          secret: encryptSecret(webhookSecret, options.encryptionKey),
          eventTypes: ['*'],
        },
      });

      // Better Auth's shape for an email + password login: a user plus a "credential" account.
      const userId = randomBase62(32);
      await tx.user.create({
        data: {
          id: userId,
          name: 'Demo Merchant',
          email: DEMO_LOGIN.email,
          emailVerified: true,
          merchantId,
          accounts: {
            create: {
              id: randomBase62(32),
              accountId: userId,
              providerId: 'credential',
              password: passwordHash,
            },
          },
        },
      });

      const ledger: LedgerAccounts = {
        clearing: await systemAccountId(tx, 'gateway_clearing'),
        fees: await systemAccountId(tx, 'fee_revenue'),
        merchant: merchantBalance.id,
      };
      for (const sample of SAMPLE_PAYMENTS) {
        await seedPayment(tx, { merchantId, storeBaseUrl, feeBps: options.feeBps, ledger }, sample);
      }
    },
    { timeout: 15_000 },
  );

  return {
    status: 'created',
    merchantId,
    apiKey: apiKey.key,
    webhookSecret,
    checkoutSecret,
    login: { ...DEMO_LOGIN },
  };
}

interface LedgerAccounts {
  clearing: string;
  fees: string;
  merchant: string;
}

interface SeedContext {
  merchantId: string;
  storeBaseUrl: string;
  feeBps: number;
  ledger: LedgerAccounts;
}

/**
 * One finished payment, written the way the real flows will write it: order, payment, ledger
 * entries (section 9.4), outbox event, and the fake bank's own record of it.
 */
async function seedPayment(tx: Prisma.TransactionClient, ctx: SeedContext, sample: SamplePayment) {
  const { merchantId, ledger } = ctx;
  const at = new Date(Date.now() - sample.minutesAgo * 60_000);
  const captured = sample.outcome === 'captured';
  const fee = captured ? calculateFee(sample.amount, ctx.feeBps) : null;
  const orderId = newId('order');
  const bankRef = newBankRef();

  await tx.order.create({
    data: {
      id: orderId,
      merchantId,
      amount: sample.amount,
      receipt: sample.receipt,
      status: captured ? 'paid' : 'attempted',
      clientSecretHash: sha256Hex(generateClientSecret()),
      callbackUrl: `${ctx.storeBaseUrl}/payments/callback`,
      paidAt: captured ? at : null,
      createdAt: at,
    },
  });
  const payment = await tx.payment.create({
    data: {
      id: newId('pay'),
      merchantId,
      orderId,
      amount: sample.amount,
      fee,
      amountRefunded: sample.refund ?? 0,
      method: sample.method,
      vpa: sample.vpa ?? null,
      cardLast4: sample.card?.last4 ?? null,
      cardNetwork: sample.card?.network ?? null,
      status: captured ? 'captured' : 'failed',
      failureReason: captured ? null : 'insufficient_funds',
      bankRef,
      authorizedAt: captured ? at : null,
      capturedAt: captured ? at : null,
      createdAt: at,
    },
  });
  await tx.bankTransaction.create({
    data: {
      bankRef,
      gatewayReference: payment.id,
      type: 'payment',
      amount: payment.amount,
      outcome: captured ? 'approved' : 'declined',
      declineReason: payment.failureReason,
      decidedAt: at,
      callbackSent: true,
      createdAt: at,
    },
  });

  if (!captured) {
    await recordEvent(tx, merchantId, 'payment.failed', paymentObject(payment), at);
    return;
  }

  await tx.ledgerTransaction.create({
    data: {
      id: newId('ltx'),
      type: 'capture',
      referenceType: 'payment',
      referenceId: payment.id,
      createdAt: at,
      entries: {
        create: [
          { accountId: ledger.clearing, direction: 'debit', amount: payment.amount, createdAt: at },
          {
            accountId: ledger.merchant,
            direction: 'credit',
            amount: payment.amount - fee!,
            createdAt: at,
          },
          { accountId: ledger.fees, direction: 'credit', amount: fee!, createdAt: at },
        ],
      },
    },
  });
  await recordEvent(tx, merchantId, 'payment.captured', paymentObject(payment), at);

  if (sample.refund) {
    const refundAt = new Date(at.getTime() + 10 * 60_000);
    const refund = await tx.refund.create({
      data: {
        id: newId('rfnd'),
        merchantId,
        paymentId: payment.id,
        amount: sample.refund,
        status: 'processed',
        bankRef: newBankRef(),
        processedAt: refundAt,
        createdAt: refundAt,
      },
    });
    await tx.bankTransaction.create({
      data: {
        bankRef: refund.bankRef!,
        gatewayReference: refund.id,
        type: 'refund',
        amount: refund.amount,
        outcome: 'approved',
        decidedAt: refundAt,
        callbackSent: true,
        createdAt: refundAt,
      },
    });
    // The fee is not returned on refunds: the merchant gives back the full refunded amount.
    await tx.ledgerTransaction.create({
      data: {
        id: newId('ltx'),
        type: 'refund',
        referenceType: 'refund',
        referenceId: refund.id,
        createdAt: refundAt,
        entries: {
          create: [
            {
              accountId: ledger.merchant,
              direction: 'debit',
              amount: refund.amount,
              createdAt: refundAt,
            },
            {
              accountId: ledger.clearing,
              direction: 'credit',
              amount: refund.amount,
              createdAt: refundAt,
            },
          ],
        },
      },
    });
    await recordEvent(tx, merchantId, 'refund.processed', refundObject(refund), refundAt);
  }
}

async function systemAccountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { code } });
  return account.id;
}

/** Already dispatched: these are history, so the webhook worker never sends them. */
async function recordEvent(
  tx: Prisma.TransactionClient,
  merchantId: string,
  type: string,
  object: Prisma.InputJsonObject,
  at: Date,
) {
  await tx.event.create({
    data: {
      id: newId('evt'),
      merchantId,
      type,
      payload: { object },
      dispatchedAt: at,
      createdAt: at,
    },
  });
}

function paymentObject(p: Payment): Prisma.InputJsonObject {
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
    created_at: p.createdAt.toISOString(),
  };
}

function refundObject(r: Refund): Prisma.InputJsonObject {
  return {
    id: r.id,
    payment_id: r.paymentId,
    amount: r.amount,
    status: r.status,
    created_at: r.createdAt.toISOString(),
  };
}

/** The fake bank's own reference format (step 9 builds the bank itself). */
function newBankRef(): string {
  return `bank_${randomBase62(14)}`;
}

/**
 * Better Auth's default password hash: scrypt over the NFKC-normalised password, keyed with a
 * random hex salt string, stored as "salt:key" in hex. Matches it so the seeded login just works.
 */
function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const N = 16_384;
  const r = 16;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      64,
      { N, r, p: 1, maxmem: 128 * N * r * 2 },
      (err, key) => (err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`)),
    );
  });
}
