import { describe, expect, it } from 'vitest';
import { stripAuthMountPrefix } from '../../src/modules/identity/oidc-provider.controller';

describe('stripAuthMountPrefix', () => {
  it('strips one /auth mount prefix, preserving the query string', () => {
    expect(stripAuthMountPrefix('/auth/auth?client_id=x')).toBe('/auth?client_id=x');
    expect(stripAuthMountPrefix('/auth/token')).toBe('/token');
    expect(stripAuthMountPrefix('/auth/auth/some-uid')).toBe('/auth/some-uid');
    expect(stripAuthMountPrefix('/auth/.well-known/openid-configuration')).toBe(
      '/.well-known/openid-configuration',
    );
    expect(stripAuthMountPrefix('/auth/session/end')).toBe('/session/end');
  });

  it('leaves non-/auth paths and near-misses untouched', () => {
    expect(stripAuthMountPrefix('/login/abc')).toBe('/login/abc');
    expect(stripAuthMountPrefix('/authentic')).toBe('/authentic');
    expect(stripAuthMountPrefix('/console/home')).toBe('/console/home');
  });
});
