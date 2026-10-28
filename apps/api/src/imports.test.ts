import { describe, expect, it } from 'vitest';
import { calculateFee, isId, newId } from '@gateway/shared';
import { createPrismaClient, prisma } from '@gateway/db';

describe('workspace packages', () => {
  it('imports @gateway/shared', () => {
    expect(isId('order', newId('order'))).toBe(true);
    expect(calculateFee(50_000, 200)).toBe(1_000);
  });

  it('imports @gateway/db without connecting to a database', () => {
    // Prisma's constructor returns an extended proxy, so instanceof is false; check the API instead.
    expect(prisma.$transaction).toBeTypeOf('function');
    expect(createPrismaClient('postgresql://localhost/unused').$queryRaw).toBeTypeOf('function');
  });
});
