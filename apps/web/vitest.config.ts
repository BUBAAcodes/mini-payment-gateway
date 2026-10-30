import { defineConfig } from 'vitest/config';

// Unit tests for plain helpers only. Vitest can't render async Server Components, so the browser
// flow is covered by Playwright later (step 21).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
