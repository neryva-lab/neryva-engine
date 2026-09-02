import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['tests/load/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
  },
});

