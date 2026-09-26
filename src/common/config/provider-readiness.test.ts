import { describe, expect, it, vi } from 'vitest';

/**
 * Focused tests for the P5 static provider validation
 * (`assertProviderEnvReady`). The env module parses at import, so each case
 * re-imports with a scrubbed process.env via vi.resetModules().
 *
 * The live phase (`assertProviderReady`) needs a real MongoDB replica set
 * and is covered by the DB-backed gate, not here.
 */
const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva',
  REDIS_URL: 'redis://127.0.0.1:6379',
  ENGINE_BASE_URL: 'http://localhost:3001',
};

const MONGO_ENV: Record<string, string> = {
  ...BASE_ENV,
  DB_PROVIDER: 'mongodb',
  MONGODB_URI: 'mongodb://u:p@127.0.0.1:27017/neryva?replicaSet=rs0',
};

/** Pristine process.env captured before any case mutates it. */
const PRISTINE_ENV: Record<string, string | undefined> = { ...process.env };

/** Env keys this suite owns — always cleared so "missing" really means missing. */
const MANAGED_KEYS = ['DATABASE_URL', 'MONGODB_URI', 'DB_PROVIDER'] as const;

async function loadReadiness(env: Record<string, string | undefined>) {
  vi.resetModules();
  // Full wipe + restore: no leakage between cases, and "missing" really means missing.
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(PRISTINE_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('./provider-readiness');
}

describe('assertProviderEnvReady', () => {
  it('accepts a valid mongodb:// URI', async () => {
    const { assertProviderEnvReady } = await loadReadiness(MONGO_ENV);
    expect(() => assertProviderEnvReady()).not.toThrow();
  });

  it('accepts a mongodb+srv:// URI', async () => {
    const { assertProviderEnvReady } = await loadReadiness({
      ...MONGO_ENV,
      MONGODB_URI: 'mongodb+srv://u:p@cluster0.mongodb.net/neryva',
    });
    expect(() => assertProviderEnvReady()).not.toThrow();
  });

  it('accepts a pure-MongoDB boot without DATABASE_URL', async () => {
    const { assertProviderEnvReady } = await loadReadiness({
      ...MONGO_ENV,
      DATABASE_URL: undefined,
    });
    expect(() => assertProviderEnvReady()).not.toThrow();
  });

  it('fails closed on a non-mongo MONGODB_URI scheme', async () => {
    const { assertProviderEnvReady, ProviderReadinessError } = await loadReadiness({
      ...MONGO_ENV,
      MONGODB_URI: 'https://not-mongo.example.com/db',
    });
    let err: unknown;
    try {
      assertProviderEnvReady();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderReadinessError);
    expect((err as Error).message).toMatch(/MONGODB_URI has an unsupported scheme/);
    expect((err as Error).message).toMatch(/mongodb:\/\//);
  });

  it('fails at env import when MONGODB_URI is missing under DB_PROVIDER=mongodb', async () => {
    await expect(
      loadReadiness({ ...MONGO_ENV, MONGODB_URI: undefined }),
    ).rejects.toThrow(/MONGODB_URI/);
  });

  it('accepts DB_PROVIDER=postgres with DATABASE_URL', async () => {
    const { assertProviderEnvReady } = await loadReadiness({
      ...BASE_ENV,
      DB_PROVIDER: 'postgres',
    });
    expect(() => assertProviderEnvReady()).not.toThrow();
  });

  it('fails at env import when DATABASE_URL is missing under DB_PROVIDER=postgres', async () => {
    await expect(
      loadReadiness({ ...BASE_ENV, DB_PROVIDER: 'postgres', DATABASE_URL: undefined }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('error message never echoes the URI password', async () => {
    const { assertProviderEnvReady } = await loadReadiness({
      ...MONGO_ENV,
      MONGODB_URI: 'https://u:super-secret-pw@not-mongo.example.com/db',
    });
    let message = '';
    try {
      assertProviderEnvReady();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('super-secret-pw');
  });
});
