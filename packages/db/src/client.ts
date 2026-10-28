import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// One client per process. Next.js dev reloads re-run this module, so cache it on globalThis.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** The shared client. It connects on the first query, so importing it needs no database. */
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient(process.env.DATABASE_URL ?? '');

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
