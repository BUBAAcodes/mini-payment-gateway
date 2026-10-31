import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for plain helpers and Server Actions. Vitest can't render async Server Components, so
// the browser flow is covered by Playwright later (step 21).
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
