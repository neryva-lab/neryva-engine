import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['tests/contract/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 15_000,
  },
});

