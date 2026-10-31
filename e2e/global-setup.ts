import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { SeedCreated } from '@gateway/db/seed';
import { PORTS, compose, e2eDir, portsInUse, repoRoot, urls } from './stack/compose';

/**
 * Brings up the whole stack in Docker, from an empty database, the way a merchant would see it:
 *  1. Postgres and Redis.
 *  2. Migrations and the seed, from this machine. The seed's secrets are shown only once, and the
 *     demo store needs them at startup, so it can't start before this.
 *  3. The API, web and demo store, built from the working tree, with the seeded secrets.
 * Returns the teardown, which removes the stack and its volume (E2E_KEEP_STACK=1 keeps it).
 */
export default async function globalSetup() {
  // Fresh secrets every run, so the result never depends on your .env.
  const env: NodeJS.ProcessEnv = {
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    INTERNAL_CRON_SECRET: randomBytes(32).toString('hex'),
    DASHBOARD_SERVICE_TOKEN: randomBytes(32).toString('hex'),
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    BETTER_AUTH_URL: urls.web,
    WEB_BASE_URL: urls.web,
    STORE_BASE_URL: urls.store,
    // The API container reaches the store by service name, not localhost.
    STORE_WEBHOOK_URL: `http://demo-store:${PORTS.store}/webhooks/gateway`,
    DATABASE_URL: urls.database,
    DIRECT_DATABASE_URL: urls.database,
  };
  // Compose checks every required variable even for `down`, so each call gets `env`.
  const teardown = () => {
    if (process.env.E2E_KEEP_STACK === '1') {
      step('E2E_KEEP_STACK=1: leaving the stack running (docker compose -p gateway-e2e down -v)');
      return;
    }
    compose(['down', '-v', '--remove-orphans'], env);
  };

  // A stack left running by E2E_KEEP_STACK, or by a crashed run. Start from nothing.
  compose(['down', '-v', '--remove-orphans'], env);

  const busy = await portsInUse();
  if (busy.length > 0) {
    throw new Error(
      `Ports ${busy.join(', ')} are in use. The e2e stack publishes the same ports as ` +
        'docker-compose.yml: stop the dev stack (`docker compose down`) and any `pnpm dev` first.',
    );
  }

  try {
    step('Starting Postgres and Redis');
    compose(['up', '-d', '--wait', 'postgres', 'redis'], env);

    step('Migrating and seeding');
    run('pnpm', ['--filter', '@gateway/db', 'exec', 'prisma', 'migrate', 'deploy'], repoRoot, env);
    const seeded = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'stack/seed.ts'], e2eDir, env),
    ) as SeedCreated;

    step('Building and starting the API, web and demo store (the first build takes a few minutes)');
    compose(['up', '-d', '--build', '--wait', 'api', 'web', 'demo-store'], {
      ...env,
      GATEWAY_SECRET_KEY: seeded.apiKey,
      GATEWAY_WEBHOOK_SECRET: seeded.webhookSecret,
      GATEWAY_CHECKOUT_SECRET: seeded.checkoutSecret,
    });

    // Workers inherit this process's environment.
    process.env.E2E_LOGIN_EMAIL = seeded.login.email;
    process.env.E2E_LOGIN_PASSWORD = seeded.login.password;
  } catch (error) {
    printLogs(env);
    teardown();
    throw error;
  }

  return teardown;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function printLogs(env: NodeJS.ProcessEnv) {
  try {
    console.error(compose(['logs', '--no-color', '--tail', '50'], env));
  } catch {
    // Nothing started, so there is nothing to show.
  }
}

function step(message: string) {
  console.log(`[e2e] ${message}`);
}
