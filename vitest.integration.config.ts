import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Suite env: DATABASE_URL must reach the live DB; ENGINE_BASE_URL /
    // REDIS_URL get localhost defaults in tests/setup-db-suites.ts so the
    // suites don't fail on env validation before they even probe the DB.
    setupFiles: ['tests/setup-db-suites.ts'],
    // P2 persistence parity specs (*.parity.spec.ts) are integration tests:
    // they run both lanes against live services (real PostgreSQL via
    // TEST_DATABASE_URL/DATABASE_URL + mongodb-memory-server replica sets)
    // and skip gracefully when the services are unreachable. P3 module parity
    // specs live alongside their repositories (src/modules/**).
    include: [
      'tests/integration/**/*.test.ts',
      'src/common/infra/db/ports/*.parity.spec.ts',
      'src/modules/**/*.parity.spec.ts',
    ],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 30_000,
    // mongodb-memory-server replica-set boot (first run after a cache clear)
    // can exceed the default hook budget; the ceiling only, not a target.
    hookTimeout: 120_000,
    sequence: { concurrent: false },
  },
});

