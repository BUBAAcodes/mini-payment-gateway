import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Starts one Postgres container for the run and applies every migration to it.
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
