import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountActionsService, type ActionKind } from './account-actions.service';
import type { RedisService } from '../../common/infra/redis.service';
import type { AccountActionToken, IAccountActionTokenRepository } from './repositories/account-action-token.repository';

/**
 * `AccountActionsService` consume wiring (P3). The repository port consumes
 * by the previously read ROW ID (`consume(id, nowIso)` — the exact
 * statement the original service issued: `WHERE id = row.id AND
 * used_at IS NULL`). These tests pin that the service passes the peeked
 * row's id — never a re-derived token hash — into `consume`, and that the
 * lost-race maps to `invalid`. Mocked port, no database.
 */

const KIND: ActionKind = 'email_verify';
const TOKEN = 'abcdefghijklmnopqrst'; // 20 chars: passes the 16–128 length gate

function liveRow(overrides: Partial<AccountActionToken> = {}): AccountActionToken {
  return {
    id: 'row-123',
    accountId: 'acc-1',
    kind: KIND,
    tokenHash: 'deadbeef',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    attempts: 0,
    usedAt: null,
    ...overrides,
  };
}

describe('AccountActionsService.consume', () => {
  let tokens: {
    peek: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
    registerFailedAttempt: ReturnType<typeof vi.fn>;
  };
  let service: AccountActionsService;

  beforeEach(() => {
    tokens = {
      peek: vi.fn().mockResolvedValue(liveRow()),
      consume: vi.fn().mockResolvedValue(liveRow()),
      registerFailedAttempt: vi.fn().mockResolvedValue(undefined),
    };
    // `consume` never touches Redis (the cooldown lives on `issue` only).
    const redis = {} as unknown as RedisService;
    service = new AccountActionsService(tokens as unknown as IAccountActionTokenRepository, redis);
  });

  it('consumes by the peeked row id, not by token hash', async () => {
    const result = await service.consume(TOKEN, KIND);

    expect(result).toEqual({ ok: true, accountId: 'acc-1' });
    expect(tokens.peek).toHaveBeenCalledWith(expect.any(String), KIND);
    // The regression pin: the row id goes to consume — a hash here would
    // silently change the CAS from row-identity to hash-identity.
    expect(tokens.consume).toHaveBeenCalledWith('row-123', expect.any(String));
    const consumedId = vi.mocked(tokens.consume).mock.calls[0][0];
    expect(consumedId).not.toBe(vi.mocked(tokens.peek).mock.calls[0][0]);
  });

  it('maps a lost single-use race to invalid', async () => {
    vi.mocked(tokens.consume).mockResolvedValue(null);

    await expect(service.consume(TOKEN, KIND)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an unknown token without touching consume', async () => {
    vi.mocked(tokens.peek).mockResolvedValue(null);

    await expect(service.consume(TOKEN, KIND)).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(tokens.consume).not.toHaveBeenCalled();
  });

  it('distinguishes expired from over-attempted on peek', async () => {
    vi.mocked(tokens.peek).mockResolvedValue(
      liveRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await expect(service.peek(TOKEN, KIND)).resolves.toEqual({ ok: false, reason: 'expired' });

    vi.mocked(tokens.peek).mockResolvedValue(liveRow({ attempts: 3 }));
    await expect(service.peek(TOKEN, KIND)).resolves.toEqual({ ok: false, reason: 'too_many_attempts' });
  });
});
