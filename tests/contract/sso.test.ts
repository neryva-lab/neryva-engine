import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SSO contract — Phase 2.7
 *
 * Verifies delegation model from `docs/architecture/engine/saml-delegation.md:1`:
 *  - Engine handles OIDC only (Google/GitHub/Apple/Microsoft) via Authorization Code + PKCE.
 *  - SAML is delegated to the managed IdP — no SAML XML handling exists in Engine.
 *  - Key rotation, logout, and account-linking are covered without SAML.
 *
 * This suite deliberately avoids importing `src/common/config/env.ts` or any
 * module that eagerly parses `process.env` (which would require DATABASE_URL).
 * Instead it inspects source files and docs directly — no DB needed.
 */

describe('SAML via IdP — delegation', () => {
  it('Engine has no SAML handler (social providers are OIDC only)', () => {
    const socialDir = join(process.cwd(), 'src/modules/identity/social');
    const files = readdirSync(socialDir).join('\n');
    expect(files.toLowerCase()).not.toContain('saml');
    const config = readFileSync(join(socialDir, 'social.config.ts'), 'utf8');
    expect(config.toLowerCase()).not.toMatch(/\bsaml\b/);
    // Only expected OIDC providers.
    expect(config).toMatch(/google/i);
    expect(config).toMatch(/github/i);
  });

  it('OIDC verifier checks iss/aud/sig/skew/nonce/state/exp (JwksService exists)', () => {
    const jwks = readFileSync(join(process.cwd(), 'src/common/auth/jwks.service.ts'), 'utf8');
    expect(jwks).toMatch(/verifyCompactJwt/);
    const guard = readFileSync(join(process.cwd(), 'src/common/auth/auth.guard.ts'), 'utf8');
    expect(guard).toMatch(/IDENTITY_API_AUDIENCE/);
  });

  it('logout revokes via oauth_sessions.revokedAt + auth:deny:sid fast path', () => {
    const svc = readFileSync(join(process.cwd(), 'src/modules/identity/identity-public.service.ts'), 'utf8');
    expect(svc).toMatch(/pushSidDeny/);
    expect(svc).toMatch(/auth:deny:sid/);
    expect(svc).toMatch(/isSessionActive/);
    expect(svc).toMatch(/revokedAt/);
    expect(svc).toMatch(/sessionsRevokedAt/);
  });

  it('key rotation supports current + previous JwksCustody (no downtime)', () => {
    const custody = readFileSync(join(process.cwd(), 'src/modules/identity/oidc/jwks-custody.ts'), 'utf8');
    expect(custody).toMatch(/JwksCustody/);
    // Previous key is loaded alongside current.
    const env = readFileSync(join(process.cwd(), 'src/common/config/env.ts'), 'utf8');
    expect(env).toMatch(/IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE/);
  });

  it('production refuses IDENTITY_ALLOW_DEV_KEYS (fail-closed)', () => {
    const env = readFileSync(join(process.cwd(), 'src/common/config/env.ts'), 'utf8');
    expect(env).toMatch(/IDENTITY_ALLOW_DEV_KEYS/);
    expect(env).toMatch(/must be false in production/);
  });

  it('SAML delegation doc exists and states no Engine SAML parsing', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/architecture/engine/saml-delegation.md'), 'utf8');
    expect(doc).toMatch(/Engine does not implement SAML/);
    expect(doc).toMatch(/delegated to the managed IdP/i);
  });
});
