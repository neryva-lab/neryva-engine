/**
 * Shared setup for the live-DB vitest suites (integration, isolation).
 *
 * The suites gate on DATABASE_URL only ("requires DATABASE_URL"), but every
 * test that touches the engine imports `src/common/infra/db/db.service.ts`,
 * which (transitively) imports `src/common/config/env.ts`. That module
 * parses the full engine environment at import time and *requires*
 * ENGINE_BASE_URL and REDIS_URL — without them, every suite fails during
 * collection with `Error: Invalid engine environment: ENGINE_BASE_URL:
 * Required` even though the database is reachable and healthy.
 *
 * This setup file runs before any test module is imported (vitest
 * `setupFiles`) and supplies the same harmless localhost defaults the
 * dev/smoke environment uses. It never overrides values the caller already
 * set, and it is a test-harness concern only — the engine's fail-fast env
 * validation is deliberately left untouched.
 *
 * Required suite environment:
 *   DATABASE_URL   (no default — the suite skips if the DB is unreachable)
 *   REDIS_URL      (default redis://localhost:6379)
 *   ENGINE_BASE_URL (default http://localhost:3001)
 *   NODE_ENV       (default test)
 */
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = 'test';
}
process.env.ENGINE_BASE_URL ??= 'http://localhost:3001';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// Capability issuance (MCP authority) and the secrets envelope are
// fail-closed: with no key configured the code throws instead of minting.
// The suites exercise those paths, so supply deterministic test-only keys.
// These never override caller-provided values and never leave the test
// process — production still refuses to boot without real keys.
const ZERO_32_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.MCP_CAPABILITY_SIGNING_KEY ??= ZERO_32_B64;
process.env.ENGINE_ENCRYPTION_KEY ??= ZERO_32_B64;
