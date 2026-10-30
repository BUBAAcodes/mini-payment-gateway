import { z } from 'zod';

const FROM_SEED = 'run `pnpm db:seed` and copy the value it prints into .env';

const httpUrl = z.url({ protocol: /^https?$/, error: 'Must be an http or https URL' });

/** A required secret. Empty counts as missing: docker-compose passes unset variables as "". */
function secret(prefix = '') {
  return z
    .string({ error: `Required: ${FROM_SEED}` })
    .min(1, `Required: ${FROM_SEED}`)
    .refine((value) => value.startsWith(prefix), `Must start with ${prefix} (${FROM_SEED})`);
}

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Where the gateway API lives. In Docker that's the api service, not localhost.
  API_BASE_URL: httpUrl.default('http://localhost:4000'),
  // The store's own public URL, as the customer's browser sees it. Checkout sends customers back
  // to {STORE_BASE_URL}/payments/callback.
  STORE_BASE_URL: httpUrl
    .default('http://localhost:3001')
    .transform((url) => url.replace(/\/+$/, '')),
  // The three secrets the seed prints once: the API key, the webhook signing secret, and the
  // checkout signing secret that signs redirects back to us.
  GATEWAY_SECRET_KEY: secret('sk_test_'),
  GATEWAY_WEBHOOK_SECRET: secret('whsec_'),
  GATEWAY_CHECKOUT_SECRET: secret(),
});

export type StoreConfig = z.infer<typeof configSchema>;

/** Reads config from the environment. Throws on startup; never prints a secret's value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
