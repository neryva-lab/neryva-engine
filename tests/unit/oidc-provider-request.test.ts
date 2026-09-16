import { describe, expect, it } from 'vitest';
import { toProviderRequest } from '../../src/modules/identity/oidc/provider-request.helper';

function rawReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'localhost:3001' },
    method: 'POST',
    url: '/token',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as never;
}

async function readBody(req: unknown): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('toProviderRequest', () => {
  it('re-streams a consumed urlencoded body for the provider', async () => {
    const raw = rawReq();
    const out = toProviderRequest(raw, { grant_type: 'refresh_token', client_id: 'neryva-console' });
    expect(out).not.toBe(raw);
    const params = new URLSearchParams(await readBody(out));
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('client_id')).toBe('neryva-console');
    expect((out as { headers: Record<string, string> }).headers['content-length']).toBe(
      String(Buffer.byteLength(new URLSearchParams({ grant_type: 'refresh_token', client_id: 'neryva-console' }).toString())),
    );
    // Request surface preserved.
    expect((out as { method: string }).method).toBe('POST');
    expect((out as { url: string }).url).toBe('/token');
  });

  it('passes through GETs, empty bodies, and non-urlencoded content', () => {
    const get = rawReq({ method: 'GET' });
    expect(toProviderRequest(get, undefined)).toBe(get);
    const post = rawReq();
    expect(toProviderRequest(post, {})).toBe(post);
    expect(toProviderRequest(post, undefined)).toBe(post);
    const json = rawReq({ headers: { 'content-type': 'application/json' } });
    const parsed = { a: 1 };
    expect(toProviderRequest(json, parsed)).toBe(json);
  });
});
