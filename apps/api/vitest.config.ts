import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The same throwaway Postgres 17 (with migrations) that packages/db tests use.
    globalSetup: [fileURLToPath(import.meta.resolve('@gateway/db/testing/global-setup'))],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
