import { inject } from 'vitest';
import { newId } from '@gateway/shared';
import { createPrismaClient } from '../client';
import type { PaymentStatus, PrismaClient } from '../generated/prisma/client';
// Type-only: brings in the `databaseUrl` typing for inject() without loading Testcontainers.
import type {} from './global-setup';

// Test helpers for any package that runs against the Testcontainers Postgres from global-setup.

/** A client for the test container. Every test file shares the database, so use fresh IDs. */
export function testPrisma(): PrismaClient {
  return createPrismaClient(inject('databaseUrl'));
}

/** A merchant and its merchant_balance:{id} ledger account, created together as the seed does. */
export async function createMerchant(prisma: PrismaClient) {
  const id = newId('mer');
  return prisma.merchant.create({
    data: {
      id,
      name: 'Test Merchant',
      checkoutSigningSecret: 'v1:test',
      ledgerAccounts: { create: { code: `merchant_balance:${id}`, type: 'liability' } },
    },
  });
}

export async function createOrder(prisma: PrismaClient, merchantId: string, amount = 50_000) {
  return prisma.order.create({
    data: { id: newId('order'), merchantId, amount, clientSecretHash: 'test-hash' },
  });
}

export async function createPayment(
  prisma: PrismaClient,
  order: { id: string; merchantId: string; amount: number },
  status: PaymentStatus = 'created',
) {
  return prisma.payment.create({
    data: {
      id: newId('pay'),
      merchantId: order.merchantId,
      orderId: order.id,
      amount: order.amount,
      method: 'upi',
      vpa: 'success@test',
      status,
    },
  });
}

export async function systemAccount(prisma: PrismaClient, code: string) {
  return prisma.ledgerAccount.findUniqueOrThrow({ where: { code } });
}
