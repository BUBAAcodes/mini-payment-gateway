import { inject } from 'vitest';
import { newId } from '@gateway/shared';
import { createPrismaClient } from '../src/client';
import type { PaymentStatus, PrismaClient } from '../src/generated/prisma/client';

/** A client for the test container. Every test file shares the database, so use fresh IDs. */
export function testPrisma(): PrismaClient {
  return createPrismaClient(inject('databaseUrl'));
}

export async function createMerchant(prisma: PrismaClient) {
  return prisma.merchant.create({
    data: { id: newId('mer'), name: 'Test Merchant', checkoutSigningSecret: 'v1:test' },
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
