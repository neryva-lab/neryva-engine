import { describe, expect, it } from 'vitest';
import { interactionEntryUrl } from './interaction-route.helper';

/**
 * Preselected-provider routing: a valid `connection` hint skips the
 * generic chooser; everything else fails closed to the generic page
 * (never an error, never a user-controlled redirect).
 */
describe('interactionEntryUrl', () => {
  const enabled = (key: string): boolean => key === 'google';

  it('routes a valid hint straight to the provider initiate for this interaction', () => {
    expect(interactionEntryUrl({ connection: 'google' }, 'uid-1', enabled)).toBe('/login/uid-1/social/google');
  });

  it('falls back to the generic page when the hint is absent', () => {
    expect(interactionEntryUrl({}, 'uid-1', enabled)).toBe('/login/uid-1');
    expect(interactionEntryUrl(null, 'uid-1', enabled)).toBe('/login/uid-1');
    expect(interactionEntryUrl(undefined, 'uid-1', enabled)).toBe('/login/uid-1');
  });

  it('falls back on unknown or disabled providers', () => {
    expect(interactionEntryUrl({ connection: 'evilcorp' }, 'uid-1', enabled)).toBe('/login/uid-1');
    expect(interactionEntryUrl({ connection: 'github' }, 'uid-1', enabled)).toBe('/login/uid-1');
  });

  it('falls back on blank or non-string hints', () => {
    expect(interactionEntryUrl({ connection: '' }, 'uid-1', enabled)).toBe('/login/uid-1');
    expect(interactionEntryUrl({ connection: '   ' }, 'uid-1', enabled)).toBe('/login/uid-1');
    expect(interactionEntryUrl({ connection: 42 }, 'uid-1', enabled)).toBe('/login/uid-1');
    expect(interactionEntryUrl({ connection: { key: 'google' } }, 'uid-1', enabled)).toBe('/login/uid-1');
  });

  it('takes the first value of a repeated hint and normalizes case/whitespace', () => {
    expect(interactionEntryUrl({ connection: ['google', 'github'] }, 'uid-1', enabled)).toBe(
      '/login/uid-1/social/google',
    );
    expect(interactionEntryUrl({ connection: '  Google ' }, 'uid-1', enabled)).toBe('/login/uid-1/social/google');
  });
});
