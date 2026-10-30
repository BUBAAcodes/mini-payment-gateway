import { defineConfig } from 'vitest/config';

// No database here: the store keeps everything in memory and reaches the gateway over HTTP, which
// tests replace with a stub or a tiny local server.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
