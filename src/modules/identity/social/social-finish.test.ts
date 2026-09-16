import { describe, expect, it } from 'vitest';
import { parseSocialFinish, SocialLoginService } from './social-login.service';

/**
 * The finish-stash contract (social two-leg finish): the IdP callback stashes
 * a VERIFIED login under the interaction uid and the uid-bound finish leg
 * consumes it exactly once. Redis is faked in-memory — only the `set` /
 * `getdel` surface the service touches.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    raw: {
      async set(key: string, value: string): Promise<string> {
        store.set(key, value);
        return 'OK';
      },
      async getdel(key: string): Promise<string | null> {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
      /** Test-only escape hatch for planting corrupt rows. */
      plant(key: string, value: string): void {
        store.set(key, value);
      },
    },
  };
}

function serviceWithFakeRedis() {
  const redis = fakeRedis();
  const service = new SocialLoginService(redis as never, {} as never);
  return { redis, service };
}

describe('social finish stash', () => {
  it('round-trips a verified login for the interaction uid', async () => {
    const { service } = serviceWithFakeRedis();
    await service.stashFinish('uid-1', { provider: 'google', accountId: 'acct-1' });
    expect(await service.consumeFinish('uid-1')).toEqual({
      uid: 'uid-1',
      provider: 'google',
      accountId: 'acct-1',
    });
  });

  it('is single-use: the second consume finds nothing', async () => {
    const { service } = serviceWithFakeRedis();
    await service.stashFinish('uid-1', { provider: 'google', accountId: 'acct-1' });
    expect(await service.consumeFinish('uid-1')).not.toBeNull();
    expect(await service.consumeFinish('uid-1')).toBeNull();
  });

  it('returns null for an unknown uid', async () => {
    const { service } = serviceWithFakeRedis();
    expect(await service.consumeFinish('nope')).toBeNull();
  });

  it('carries the provider so the finish leg can bind it to the route', async () => {
    const { service } = serviceWithFakeRedis();
    await service.stashFinish('uid-1', { provider: 'google', accountId: 'acct-1' });
    const finished = await service.consumeFinish('uid-1');
    expect(finished?.provider).toBe('google');
    expect(finished?.provider).not.toBe('github');
  });

  it('newest stash wins on overwrite', async () => {
    const { service } = serviceWithFakeRedis();
    await service.stashFinish('uid-1', { provider: 'google', accountId: 'acct-old' });
    await service.stashFinish('uid-1', { provider: 'google', accountId: 'acct-new' });
    expect((await service.consumeFinish('uid-1'))?.accountId).toBe('acct-new');
  });
});

describe('parseSocialFinish', () => {
  it('rejects absent and malformed rows', () => {
    expect(parseSocialFinish(null)).toBeNull();
    expect(parseSocialFinish(undefined)).toBeNull();
    expect(parseSocialFinish('')).toBeNull();
    expect(parseSocialFinish('not-json')).toBeNull();
    expect(parseSocialFinish('[]')).toBeNull();
    expect(parseSocialFinish('42')).toBeNull();
  });

  it('rejects rows with missing or empty fields', () => {
    expect(parseSocialFinish('{}')).toBeNull();
    expect(parseSocialFinish(JSON.stringify({ uid: 'u', provider: 'google' }))).toBeNull();
    expect(
      parseSocialFinish(JSON.stringify({ uid: '', provider: 'google', accountId: 'a' })),
    ).toBeNull();
    expect(
      parseSocialFinish(JSON.stringify({ uid: 'u', provider: '', accountId: 'a' })),
    ).toBeNull();
    expect(
      parseSocialFinish(JSON.stringify({ uid: 'u', provider: 'google', accountId: '' })),
    ).toBeNull();
    expect(
      parseSocialFinish(JSON.stringify({ uid: 'u', provider: 42, accountId: 'a' })),
    ).toBeNull();
  });

  it('accepts a well-formed row and strips extras', () => {
    expect(
      parseSocialFinish(
        JSON.stringify({ uid: 'u', provider: 'google', accountId: 'a', admin: true }),
      ),
    ).toEqual({
      uid: 'u',
      provider: 'google',
      accountId: 'a',
    });
  });

  it('a corrupt row in the store consumes to null (never attaches a login)', async () => {
    const { redis, service } = serviceWithFakeRedis();
    redis.raw.plant('social:finish:uid-9', '{oops');
    expect(await service.consumeFinish('uid-9')).toBeNull();
  });
});
