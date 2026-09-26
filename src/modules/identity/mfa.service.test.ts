import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MfaService } from './mfa.service';
import { generateTotpSecret, verifyTotp } from './totp';
import type { AuditService } from '../../common/audit/audit.service';
import type { IAccountRepository } from './repositories/account.repository';
import type { IMfaRepository, TotpCredential } from './repositories/mfa.repository';

/**
 * MFA disable kill-switch wiring (P3). Disabling the second factor drops
 * the account to single-factor, so every existing session must die — this
 * was documented in the service but never implemented until the P3 port,
 * which calls `IAccountRepository.revokeAllSessions` after a successful
 * disable. These tests pin that wiring with mocked ports (no database):
 *
 * - a valid factor disables AND revokes all sessions (in that order);
 * - a bad factor disables nothing and revokes nothing;
 * - no active factor is a conflict, with no session revocation.
 *
 * The TOTP code below is generated with real RFC 6238 crypto and verified
 * through the real `verifyTotp`, so the "valid factor" path exercises the
 * production verification — only the envelope unwrap is stubbed (the test
 * never provisions `ENGINE_ENCRYPTION_KEY`).
 */

const TEST_SECRET = generateTotpSecret();

vi.mock('../../common/infra/crypto/envelope', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../common/infra/crypto/envelope')>();
  return { ...mod, envelopeDecrypt: () => TEST_SECRET.secretBase32 };
});

/** RFC 6238 TOTP code — mirrors `codeAtStep` in `./totp` (test-only copy). */
function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x1_0000_0000), 0);
  counter.writeUInt32BE(step % 0x1_0000_0000, 4);
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function activeCredential(): TotpCredential {
  return {
    id: randomBytes(16).toString('hex'),
    kind: 'totp',
    totpSecretEnvelope: 'enc:v1:stubbed',
    lastUsedAt: null,
  };
}

describe('MfaService.disable kill-switch', () => {
  let mfa: { findActive: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> };
  let accounts: { revokeAllSessions: ReturnType<typeof vi.fn> };
  let audit: { add: ReturnType<typeof vi.fn> };
  let service: MfaService;

  beforeEach(() => {
    mfa = {
      findActive: vi.fn(),
      disable: vi.fn().mockResolvedValue(undefined),
    };
    accounts = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    audit = {
      add: vi.fn().mockResolvedValue(undefined),
    };
    service = new MfaService(
      mfa as unknown as IMfaRepository,
      accounts as unknown as IAccountRepository,
      audit as unknown as AuditService,
    );
    vi.mocked(mfa.findActive).mockResolvedValue(activeCredential());
  });

  it('revokes all sessions after a successful TOTP disable, in order', async () => {
    const code = totpCode(TEST_SECRET.secretBytes, Math.floor(Date.now() / 1000 / 30));
    expect(verifyTotp(TEST_SECRET.secretBase32, code)).toBe(true);

    await service.disable('acc-1', code);

    expect(mfa.disable).toHaveBeenCalledWith('acc-1', expect.any(String));
    expect(accounts.revokeAllSessions).toHaveBeenCalledWith('acc-1', expect.any(String));
    // The kill-switch runs after the factor row is gone — never before.
    expect(vi.mocked(mfa.disable).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(accounts.revokeAllSessions).mock.invocationCallOrder[0],
    );
    expect(audit.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa.disabled' }));
  });

  it('does not touch sessions or the factor when the factor is wrong', async () => {
    await expect(service.disable('acc-1', '000000')).rejects.toThrow('Invalid code');

    expect(mfa.disable).not.toHaveBeenCalled();
    expect(accounts.revokeAllSessions).not.toHaveBeenCalled();
    expect(audit.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa.disable_failed' }));
  });

  it('does not touch sessions when no factor is enrolled', async () => {
    vi.mocked(mfa.findActive).mockResolvedValue(null);

    await expect(service.disable('acc-1', '123456')).rejects.toThrow('TOTP is not enabled');

    expect(mfa.disable).not.toHaveBeenCalled();
    expect(accounts.revokeAllSessions).not.toHaveBeenCalled();
  });
});
