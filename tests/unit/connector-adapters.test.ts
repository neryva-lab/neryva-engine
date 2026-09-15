import { describe, expect, it } from 'vitest';
import {
  confluenceRestrictionToAcl,
  drivePermissionToAcl,
  graphPermissionToAcl,
  notionBlocksToText,
  notionPageTitle,
  slackFileToAcl,
  zendeskArticleToAcl,
} from '../../src/modules/knowledge/connector-adapters';
import { stripHtmlToText } from '../../src/modules/knowledge/connector-http';
import { buildAuthorizeUrl, bundleNeedsRefresh, parseCredentialBundle } from '../../src/modules/knowledge/connector-oauth';
import { buildEscalationBrief } from '../../src/modules/conversations/escalations.service';
import { connectorDocSlug } from '../../src/modules/knowledge/connectors.service';
import { normalizeInviteDelivery } from '../../src/modules/organizations/invites.service';

describe('drivePermissionToAcl', () => {
  it('opens on anyone/domain grants', () => {
    expect(drivePermissionToAcl([{ type: 'anyone', role: 'reader' }])).toEqual({ mode: 'open' });
    expect(drivePermissionToAcl([{ type: 'domain', domain: 'acme.com' }])).toEqual({ mode: 'open' });
  });

  it('restricts to listed users/groups with emails', () => {
    expect(
      drivePermissionToAcl([
        { type: 'user', id: 'u1', emailAddress: 'Ada@Acme.com' },
        { type: 'group', id: 'g1' },
      ]),
    ).toEqual({
      mode: 'restricted',
      principals: [
        { kind: 'user', id: 'u1', email: 'Ada@Acme.com' },
        { kind: 'group', id: 'g1' },
      ],
    });
  });

  it('opens when no usable principals exist', () => {
    expect(drivePermissionToAcl([])).toEqual({ mode: 'open' });
    expect(drivePermissionToAcl([{ type: 'anyone' }, { type: 'user', id: 'u9' }])).toEqual({ mode: 'open' });
  });
});

describe('graphPermissionToAcl', () => {
  it('opens on anonymous/organization links', () => {
    expect(graphPermissionToAcl([{ roles: ['read'], link: { scope: 'anonymous' } }])).toEqual({ mode: 'open' });
    expect(graphPermissionToAcl([{ roles: ['read'], link: { scope: 'organization' } }])).toEqual({ mode: 'open' });
  });

  it('restricts to granted users', () => {
    expect(graphPermissionToAcl([{ roles: ['read'], grantedToV2: { user: { id: 'u2', email: 'b@acme.com' } } }])).toEqual({
      mode: 'restricted',
      principals: [{ kind: 'user', id: 'u2', email: 'b@acme.com' }],
    });
  });
});

describe('confluenceRestrictionToAcl', () => {
  it('opens when no restrictions are listed', () => {
    expect(confluenceRestrictionToAcl({})).toEqual({ mode: 'open' });
    expect(confluenceRestrictionToAcl({ read: { userResults: [], groupResults: [] } })).toEqual({ mode: 'open' });
  });

  it('restricts to listed accounts', () => {
    expect(confluenceRestrictionToAcl({ read: { userResults: [{ accountId: 'abc123' }], groupResults: [{ name: 'admins' }] } })).toEqual({
      mode: 'restricted',
      principals: [
        { kind: 'user', id: 'abc123' },
        { kind: 'group', id: 'admins' },
      ],
    });
  });
});

describe('notion helpers', () => {
  it('assembles text blocks, skipping unknowns', () => {
    const text = notionBlocksToText([
      { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Title' }] } },
      { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'hello' }, { plain_text: ' world' }] } },
      { type: 'unsupported_thing', unsupported_thing: {} },
    ]);
    expect(text).toContain('Title');
    expect(text).toContain('hello world');
  });

  it('reads page titles with fallback', () => {
    expect(notionPageTitle({ id: 'p1', properties: { Name: { type: 'title', title: [{ plain_text: 'FAQ' }] } } })).toBe('FAQ');
    expect(notionPageTitle({ id: 'p2', properties: {} })).toBe('p2');
  });
});

describe('zendeskArticleToAcl', () => {
  it('opens segment-less articles, restricts segmented ones', () => {
    expect(zendeskArticleToAcl({ id: 1, title: 't', body: 'b', draft: false, locale: 'en-us', updated_at: '', user_segment_id: null })).toEqual({ mode: 'open' });
    expect(zendeskArticleToAcl({ id: 2, title: 't', body: 'b', draft: false, locale: 'en-us', updated_at: '', user_segment_id: 360001 })).toEqual({
      mode: 'restricted',
      principals: [{ kind: 'group', id: 'zendesk-segment-360001' }],
    });
  });
});

describe('slackFileToAcl', () => {
  it('opens publicly shared files, restricts the rest', () => {
    expect(slackFileToAcl({ shares: { public: { C1: [{}] } } })).toEqual({ mode: 'open' });
    expect(slackFileToAcl({ shares: { private: { G1: [{}] } } })).toEqual({ mode: 'restricted', principals: [] });
    expect(slackFileToAcl({})).toEqual({ mode: 'restricted', principals: [] });
  });
});

describe('stripHtmlToText', () => {
  it('drops tags and scripts, decodes entities', () => {
    expect(stripHtmlToText('<script>evil()</script><h1>A &amp; B</h1><p>x</p>')).toBe('A & B x');
  });
});

describe('connector OAuth helpers', () => {
  it('builds the Google authorize URL with required params', () => {
    const url = buildAuthorizeUrl({ provider: 'google_drive', clientId: 'cid', redirectUri: 'https://api/x/cb', scope: ['s1'], state: 'st' });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=st');
  });

  it('rejects unknown providers fail-closed', () => {
    expect(() => buildAuthorizeUrl({ provider: 'nope', clientId: 'c', redirectUri: 'https://x', scope: [], state: 's' })).toThrow();
  });

  it('parses bundles with legacy bare-string fallback', () => {
    expect(parseCredentialBundle(null)).toBeNull();
    expect(parseCredentialBundle('')).toBeNull();
    expect(parseCredentialBundle('xoxb-raw')).toEqual({ kind: 'static', secret: 'xoxb-raw' });
    expect(parseCredentialBundle(JSON.stringify({ kind: 'oauth2', access_token: 'a', refresh_token: 'r', expires_at: new Date(Date.now() + 3600000).toISOString() }))).toMatchObject({
      kind: 'oauth2',
    });
  });

  it('flags refresh inside the skew window', () => {
    expect(bundleNeedsRefresh({ kind: 'static', secret: 'x' })).toBe(false);
    expect(bundleNeedsRefresh({ kind: 'oauth2', access_token: 'a', refresh_token: 'r', expires_at: new Date(Date.now() + 3600000).toISOString() })).toBe(false);
    expect(bundleNeedsRefresh({ kind: 'oauth2', access_token: 'a', refresh_token: 'r', expires_at: new Date(Date.now() + 1000).toISOString() })).toBe(true);
    expect(bundleNeedsRefresh({ kind: 'oauth2', access_token: 'a', refresh_token: null, expires_at: new Date(0).toISOString() })).toBe(false);
  });
});

describe('buildEscalationBrief (P0-3)', () => {
  it('caps lengths and preserves nulls', () => {
    const brief = buildEscalationBrief({ summary: 's'.repeat(5000), summarySequence: 12, messageCount: 42, lastUserText: 'u'.repeat(3000), openRun: { id: 'r', state: 'RUNNING' } });
    expect((brief['summary'] as string).length).toBe(4000);
    expect((brief['last_user_text'] as string).length).toBe(2000);
    expect(brief['message_count']).toBe(42);
    expect(brief['open_run']).toEqual({ id: 'r', state: 'RUNNING' });
  });

  it('keeps absent data absent, never invented', () => {
    expect(buildEscalationBrief({ summary: null, summarySequence: null, messageCount: 0, lastUserText: null, openRun: null })).toEqual({
      summary: null,
      summary_sequence: null,
      message_count: 0,
      last_user_text: null,
      open_run: null,
    });
  });
});

describe('invite delivery + connector slugs', () => {
  it('normalizes delivery fail-closed', () => {
    expect(normalizeInviteDelivery('manual')).toBe('manual');
    expect(() => normalizeInviteDelivery('sms')).toThrow();
  });

  it('derives stable kebab slugs per external id', () => {
    const a = connectorDocSlug('google_drive', 'file_123');
    expect(a).toMatch(/^ext-google-drive-[0-9a-f]{8}$/);
    expect(connectorDocSlug('google_drive', 'file_123')).toBe(a);
    expect(connectorDocSlug('google_drive', 'file_124')).not.toBe(a);
  });
});
