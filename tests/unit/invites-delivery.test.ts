import { describe, expect, it } from 'vitest';
import { maskInviteEmail, normalizeInviteDelivery } from '../../src/modules/organizations/invites.service';

/**
 * Invite delivery + preview helpers. The DB-backed wiring (create/resend
 * guards, single-use claim, preview uniformity) lives in the integration
 * lane; these are the pure policy edges.
 */
describe('normalizeInviteDelivery', () => {
  it('accepts the two channels', () => {
    expect(normalizeInviteDelivery('email')).toBe('email');
    expect(normalizeInviteDelivery('manual')).toBe('manual');
  });

  it('fails closed on anything else', () => {
    for (const raw of [undefined, null, '', 'EMAIL', 'link', 'sms', 0, {}, []]) {
      expect(() => normalizeInviteDelivery(raw)).toThrow();
    }
  });
});

describe('maskInviteEmail', () => {
  it('keeps first local character plus full domain', () => {
    expect(maskInviteEmail('alice@acme.com')).toBe('a***@acme.com');
  });

  it('degrades to opaque on malformed input', () => {
    expect(maskInviteEmail('not-an-email')).toBe('***');
    expect(maskInviteEmail('')).toBe('***');
    expect(maskInviteEmail('@')).toBe('***');
  });
});
