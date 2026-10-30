// Seeds the demo merchant: `pnpm db:seed`. Prints its secrets once; they are stored only hashed or
// encrypted, so a second run can't show them again. To start over: `pnpm db:reset`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../src/client';
import { demoWebhookUrl, seedDemo } from '../src/seed';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const options = {
  encryptionKey: requireEnv('APP_ENCRYPTION_KEY'),
  feeBps: Number(process.env.FEE_BPS || 200),
  storeBaseUrl: process.env.STORE_BASE_URL || 'http://localhost:3001',
  // Docker: http://demo-store:3001/webhooks/gateway (the API container can't reach localhost:3001).
  webhookUrl: process.env.STORE_WEBHOOK_URL || undefined,
};

const prisma = createPrismaClient(requireEnv('DATABASE_URL'));
try {
  const result = await seedDemo(prisma, options);

  if (result.status === 'already_seeded') {
    console.log('Already seeded. Run `pnpm db:reset` to start over (it deletes all data).');
  } else {
    console.log(`
Seeded the demo merchant ${result.merchantId}.
These secrets are shown once. Only their hashes or ciphertexts are stored.

Dashboard login
  email     ${result.login.email}
  password  ${result.login.password}

Webhooks for the demo store go to ${demoWebhookUrl(options)}

Demo store (apps/demo-store) environment
  GATEWAY_SECRET_KEY=${result.apiKey}
  GATEWAY_WEBHOOK_SECRET=${result.webhookSecret}
  GATEWAY_CHECKOUT_SECRET=${result.checkoutSecret}
`);
  }
} finally {
  await prisma.$disconnect();
}
