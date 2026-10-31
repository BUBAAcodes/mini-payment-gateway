import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const e2eDir = fileURLToPath(new URL('..', import.meta.url));

/** Its own Compose project, so the run gets a fresh volume and never touches the dev database. */
const PROJECT = 'gateway-e2e';

/** What docker-compose.yml publishes. The e2e stack uses the same ports, so the dev stack must be down. */
export const PORTS = { web: 3000, store: 3001, api: 4000, postgres: 5432, redis: 6379 } as const;

export const urls = {
  web: `http://localhost:${PORTS.web}`,
  store: `http://localhost:${PORTS.store}`,
  api: `http://localhost:${PORTS.api}`,
  database: `postgresql://gateway:gateway@localhost:${PORTS.postgres}/gateway`,
};

/** Runs `docker compose` for the e2e project. Variables in `env` win over the repo's .env. */
export function compose(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', `${repoRoot}/docker-compose.yml`, ...args],
    // Build output is long; the default 1 MB buffer would cut the run short.
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/** Ports that something already answers on. */
export async function portsInUse(): Promise<number[]> {
  const answered = await Promise.all(
    Object.values(PORTS).map(
      (port) =>
        new Promise<number | null>((resolve) => {
          const socket = connect({ port, host: '127.0.0.1' });
          const done = (result: number | null) => {
            socket.destroy();
            resolve(result);
          };
          socket.setTimeout(1000);
          socket.once('connect', () => done(port));
          socket.once('timeout', () => done(null));
          socket.once('error', () => done(null));
        }),
    ),
  );
  return answered.filter((port): port is number => port !== null);
}
