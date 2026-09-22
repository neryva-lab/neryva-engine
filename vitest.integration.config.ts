import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Suite env: DATABASE_URL must reach the live DB; ENGINE_BASE_URL /
    // REDIS_URL get localhost defaults in tests/setup-db-suites.ts so the
    // suites don't fail on env validation before they even probe the DB.
    setupFiles: ['tests/setup-db-suites.ts'],
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});

