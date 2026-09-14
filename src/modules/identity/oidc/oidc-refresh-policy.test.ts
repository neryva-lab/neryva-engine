import { describe, expect, it } from 'vitest';
import { clampRefreshExpiresAt, isRefreshRowUsable } from './oidc-adapter';

/**
 * Refresh-expiry policy (RFC 9700 §4.14 / RFC 10017 §6.3.2.3) and the
 * adapter usability gate. Pure helpers — no DB, no provider.
 */
describe('clampRefreshExpiresAt', () => {
  it('keeps the provider value when no cap applies', () => {
    expect(clampRefreshExpiresAt('2026-02-01T00:00:00.000Z', [])).toBe('2026-02-01T00:00:00.000Z');
    expect(clampRefreshExpiresAt('2026-02-01T00:00:00.000Z', [null, undefined])).toBe('2026-02-01T00:00:00.000Z');
  });

  it('clamps a rotated token to the predecessor expiry (never extends)', () => {
    expect(clampRefreshExpiresAt('2026-03-01T00:00:00.000Z', ['2026-02-01T00:00:00.000Z'])).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('takes the minimum across predecessor and existing-row caps', () => {
    expect(
      clampRefreshExpiresAt('2026-04-01T00:00:00.000Z', ['2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']),
    ).toBe('2026-02-01T00:00:00.000Z');
  });

  it('ignores empty-string caps', () => {
    expect(clampRefreshExpiresAt('2026-02-01T00:00:00.000Z', [''])).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('isRefreshRowUsable', () => {
  const now = '2026-01-15T12:00:00.000Z';

  it('resolves live rows', () => {
    expect(isRefreshRowUsable({ expiresAt: '2026-02-01T00:00:00.000Z', revokedAt: null }, now)).toBe(true);
  });

  it('rejects expired rows', () => {
    expect(isRefreshRowUsable({ expiresAt: '2026-01-01T00:00:00.000Z', revokedAt: null }, now)).toBe(false);
  });

  it('rejects family-revoked rows even before expiry', () => {
    expect(
      isRefreshRowUsable({ expiresAt: '2026-02-01T00:00:00.000Z', revokedAt: '2026-01-15T11:00:00.000Z' }, now),
    ).toBe(false);
  });
});
