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
});

export type Config = z.infer<typeof configSchema>;

/** Reads config from the environment. Throws on startup instead of failing later on first use. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
