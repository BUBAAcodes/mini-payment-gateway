import { z } from 'zod';
import { isValidEncryptionKey } from '@gateway/shared';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().startsWith('postgres', 'Must be a Postgres connection URL'),
  // Encrypts webhook and checkout signing secrets. Checked here so a bad key stops startup,
  // instead of breaking the first webhook hours later.
  APP_ENCRYPTION_KEY: z
    .string({ error: 'Required: 32 random bytes, base64-encoded' })
    .refine(isValidEncryptionKey, 'Must be 32 random bytes, base64-encoded'),
  // Where the checkout page lives; order responses link to {WEB_BASE_URL}/pay/{orderId}.
  WEB_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'Must be an http or https URL' })
    .default('http://localhost:3000'),
  // Our fee in basis points: 200 = 2%. Whole numbers only, so fees stay in integer paise.
  FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
  // slow@test answers after BANK_SLOW_MS; we stop waiting for the bank after BANK_TIMEOUT_MS.
  // Slow must be longer than the timeout, so slow@test exercises the "unknown" path (rule 10).
  BANK_SLOW_MS: z.coerce.number().int().min(0).default(20_000),
  BANK_TIMEOUT_MS: z.coerce.number().int().min(1).default(10_000),
});

export type Config = z.infer<typeof configSchema>;

/** The settings request handlers need. Startup-only settings (port, DB URL) stay in server.ts. */
export type AppConfig = Pick<
  Config,
  'WEB_BASE_URL' | 'APP_ENCRYPTION_KEY' | 'FEE_BPS' | 'BANK_TIMEOUT_MS'
>;

/** Reads config from the environment. Throws on startup instead of failing later on first use. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
