// Seeds the e2e database and prints the result as JSON on stdout, for global-setup to read. Run
// with tsx, not inside Playwright: the Prisma client is ESM TypeScript that only tsx loads as is.
import { createPrismaClient } from '@gateway/db';
import { seedDemo } from '@gateway/db/seed';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const prisma = createPrismaClient(requireEnv('DATABASE_URL'));
try {
  const result = await seedDemo(prisma, {
    encryptionKey: requireEnv('APP_ENCRYPTION_KEY'),
    feeBps: 200,
    storeBaseUrl: requireEnv('STORE_BASE_URL'),
    webhookUrl: requireEnv('STORE_WEBHOOK_URL'),
  });
  if (result.status !== 'created') throw new Error('the e2e database was already seeded');
  process.stdout.write(JSON.stringify(result));
} finally {
  await prisma.$disconnect();
}
