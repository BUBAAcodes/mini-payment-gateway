import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    /** A migrated copy of the database that nothing connects to, for isolatedTestPrisma(). */
    templateDatabase: string;
  }
}

const dbPackageDir = fileURLToPath(new URL('../..', import.meta.url));
const TEMPLATE_DATABASE = 'gateway_template';

/** A real, throwaway Postgres 17 with our migrations applied, the same way CI and Neon get them. */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const databaseUrl = container.getConnectionUri();

  // Env vars already set win over the repo's .env (process.loadEnvFile), so this can't hit dev.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: dbPackageDir,
    env: { ...process.env, DIRECT_DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // Copied now, while no test is connected to the database: Postgres only clones idle databases.
  const adminUrl = new URL(databaseUrl);
  const source = adminUrl.pathname.slice(1);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE} TEMPLATE "${source}"`);
  } finally {
    await admin.end();
  }

  project.provide('databaseUrl', databaseUrl);
  project.provide('templateDatabase', TEMPLATE_DATABASE);
  return async () => {
    await container.stop();
  };
}
