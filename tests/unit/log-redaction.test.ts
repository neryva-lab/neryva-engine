import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../../src/common/observability/logger';

/**
 * Log-redaction tripwire: bearer-equivalent and credential keys must stay
 * covered by the pino redact list. Presence-only (additions never break it;
 * removals fail loudly and require a deliberate test update).
 *
 * Backbone for the invite-preview guarantee — preview/redeem carry the raw
 * token in the JSON BODY (never the URL, which request logs record), and
 * these paths ensure no `token`-keyed value reaches disk even if a body is
 * ever stringified into a log line.
 */
describe('log redaction coverage', () => {
  it.each([
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["x-mfa-proof"]',
    'password',
    '*.password',
    'secret',
    '*.secret',
    'token',
    '*.token',
    'accessToken',
    '*.accessToken',
    'refreshToken',
    '*.refreshToken',
    'idToken',
    '*.idToken',
  ])('redacts %s', (path) => {
    expect(REDACT_PATHS).toContain(path);
  });
});
