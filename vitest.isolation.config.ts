import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // See vitest.integration.config.ts — same suite env defaults.
    setupFiles: ['tests/setup-db-suites.ts'],
    include: ['tests/isolation/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 15_000,
    sequence: { concurrent: false },
  },
});

