import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env by itself. Use Node's built-in loader for the repo-root .env.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  // Migrations use the direct (non-pooled) URL. Left optional so `prisma generate` works without a database.
  datasource: { url: process.env.DIRECT_DATABASE_URL ?? '' },
});
