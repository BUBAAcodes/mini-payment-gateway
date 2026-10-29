import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const dbPackageDir = fileURLToPath(new URL('..', import.meta.url));

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

  project.provide('databaseUrl', databaseUrl);
  return async () => {
    await container.stop();
  };
}
