import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * K-5 flag-matrix regression: booting with MODULES__CONVERSATIONS_ENABLED=true
 * but its dependencies off is REJECTED by design (fail loud at boot, never at
 * request time). This test documents the correct boot configuration in code:
 * the smoke/production flag set (conversations + organizations + assistants +
 * knowledge + billing, plus the rest of the smoke set) must pass validation,
 * and the invalid combination must fail with the dependency message naming
 * exactly what to turn on.
 *
 * env.ts parses process.env once per import, so each case re-imports the
 * flag module with a fresh process.env via vi.resetModules().
 */

const BASE_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/neryva',
  REDIS_URL: 'redis://localhost:6379',
  ENGINE_BASE_URL: 'http://localhost:3001',
} as const;

async function loadValidateFlagMatrix(
  flagEnv: Record<string, string>,
): Promise<(typeof import('../../src/common/config/feature-flags'))['validateFlagMatrix']> {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...flagEnv })) {
    process.env[key] = value;
  }
  const mod = await import('../../src/common/config/feature-flags');
  return mod.validateFlagMatrix;
}

afterEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MODULES__') || key.startsWith('WORKERS__')) {
      delete process.env[key];
    }
  }
});

describe('flag matrix (K-5)', () => {
  it('accepts the smoke/prod boot flag set (conversations + its dependencies)', async () => {
    const validateFlagMatrix = await loadValidateFlagMatrix({
      MODULES__CORPORATE_ENABLED: 'true',
      MODULES__IDENTITY_ENABLED: 'true',
      MODULES__ORGANIZATIONS_ENABLED: 'true',
      MODULES__CONSOLE_ENABLED: 'true',
      MODULES__BILLING_ENABLED: 'true',
      MODULES__AGENT_STUDIO_ENABLED: 'true',
      MODULES__ASSISTANTS_ENABLED: 'true',
      MODULES__CONVERSATIONS_ENABLED: 'true',
      MODULES__MCP_ENABLED: 'true',
      MODULES__KNOWLEDGE_ENABLED: 'true',
      MODULES__NOTIFICATIONS_ENABLED: 'true',
    });
    expect(() => validateFlagMatrix()).not.toThrow();
  });

  it('rejects conversations-on with its dependencies off, naming the requirements', async () => {
    const validateFlagMatrix = await loadValidateFlagMatrix({
      MODULES__CONVERSATIONS_ENABLED: 'true',
    });
    expect(() => validateFlagMatrix()).toThrow(
      /MODULES__CONVERSATIONS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED, MODULES__ASSISTANTS_ENABLED, MODULES__KNOWLEDGE_ENABLED and MODULES__BILLING_ENABLED/,
    );
  });
});
