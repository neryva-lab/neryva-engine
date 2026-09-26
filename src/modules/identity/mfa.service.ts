import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeDecrypt, envelopeEncrypt, sha256Hex } from '../../common/infra/crypto/envelope';
import { mintMfaProof } from '../../common/auth/mfa-proof';
import { MFA_REPOSITORY, ACCOUNT_REPOSITORY } from './repositories/repository-tokens';
import type { IMfaRepository } from './repositories/mfa.repository';
import type { IAccountRepository } from './repositories/account.repository';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';

/**
 * Full MFA lifecycle (the audit's "MFA is half-built" gap): TOTP enrollment
 * with a pending state, activation after a verified code, single-use
 * recovery codes (10 × 10 chars, sha256 at rest, shown once), disable with
 * re-auth, and proof minting — the missing producer side of the step-up
 * guard (verifyMfaProof existed; nothing minted proofs).
 *
 * State model on account_credentials (unique account+kind):
 *   kind 'totp_pending' — enrollment started, secret issued, NOT active
 *   kind 'totp'         — active; envelope = { secret }, verified_at set
 * accounts.mfa_level: none → totp (updated on activate/disable).
 *
 * Persistence goes through `IMfaRepository` (provider-blind); all crypto,
 * TOTP, and policy stays here.
 *
 * Security: every state change is audited; disable requires a current TOTP
 * code (or a recovery code) AND revokes all sessions; recovery codes are
 * consumed atomically single-use.
 */
const RECOVERY_CODE_COUNT = 10;

@Injectable()
export class MfaService {
  constructor(
    @Inject(MFA_REPOSITORY) private readonly mfa: IMfaRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: generate + persist a pending secret. Returns the QR payload + secret once. */
  async enroll(accountId: string, email: string): Promise<{ secret: string; otpauth_url: string }> {
    // Refuse a second parallel enrollment; finish or disable the first.
    const existing = await this.mfa.findActive(accountId);
    if (existing) {
      throw ApiError.conflict('TOTP is already enabled for this account');
    }
    const { secretBase32 } = generateTotpSecret();
    await this.mfa.enrollPending(accountId, envelopeEncrypt(secretBase32));
    await this.audit.add({
      action: 'mfa.enrollment_started',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
    return { secret: secretBase32, otpauth_url: otpauthUri(secretBase32, email) };
  }

  /** Step 2: verify a code against the pending secret → activate + mint recovery codes. */
  async activate(accountId: string, code: string): Promise<{ recovery_codes: string[] }> {
    const pending = await this.mfa.findPending(accountId);
    if (!pending || !pending.totpSecretEnvelope) {
      throw ApiError.conflict('no pending TOTP enrollment — start one first');
    }
    const secret = envelopeDecrypt(pending.totpSecretEnvelope);
    if (!verifyTotp(secret, code)) {
      await this.audit.add({
        action: 'mfa.activate_failed',
        resourceType: 'account',
        resourceId: accountId,
        actorType: 'account',
        actorId: accountId,
        details: { reason: 'bad_code' },
      });
      throw ApiError.unauthenticated('Invalid code');
    }

    const now = new Date().toISOString();
    // Promote: delete pending kind row, upsert active 'totp' credential.
    await this.mfa.activate(accountId, pending.totpSecretEnvelope, now);

    const recoveryCodes = await this.regenerateRecoveryCodes(accountId);
    await this.audit.add({
      action: 'mfa.enabled',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
    return { recovery_codes: recoveryCodes };
  }

  /** Disable requires a live second factor (TOTP or recovery code). */
  async disable(accountId: string, factor: string): Promise<void> {
    const active = await this.mfa.findActive(accountId);
    if (!active) {
      throw ApiError.conflict('TOTP is not enabled');
    }
    const viaRecovery = await this.tryConsumeRecoveryCode(accountId, factor);
    if (!viaRecovery && !verifyTotp(this.activeSecret(active), factor)) {
      await this.audit.add({
        action: 'mfa.disable_failed',
        resourceType: 'account',
        resourceId: accountId,
        actorType: 'account',
        actorId: accountId,
        details: { reason: 'bad_factor' },
      });
      throw ApiError.unauthenticated('Invalid code');
    }

    await this.mfa.disable(accountId, new Date().toISOString());
    // Disabling the second factor drops the account to single-factor —
    // all existing sessions must die (the kill-switch). This was
    // documented but never implemented.
    await this.accounts.revokeAllSessions(accountId, new Date().toISOString());
    await this.audit.add({
      action: 'mfa.disabled',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: { via: viaRecovery ? 'recovery_code' : 'totp' },
    });
  }

  /** Mint a step-up proof after verifying a live second factor (the producer side). */
  async mintProof(accountId: string, factor: string): Promise<{ proof: string; expires_in_seconds: number }> {
    const active = await this.mfa.findActive(accountId);
    if (!active) {
      throw ApiError.conflict('TOTP is not enabled — enroll first');
    }
    const viaRecovery = await this.tryConsumeRecoveryCode(accountId, factor);
    if (!viaRecovery && !verifyTotp(this.activeSecret(active), factor)) {
      await this.audit.add({
        action: 'mfa.proof_failed',
        resourceType: 'account',
        resourceId: accountId,
        actorType: 'account',
        actorId: accountId,
        details: { reason: 'bad_factor' },
      });
      throw ApiError.unauthenticated('Invalid code');
    }
    await this.mfa.touchLastUsed(active.id, new Date().toISOString());
    const proof = mintMfaProof(accountId);
    return { proof, expires_in_seconds: 300 };
  }

  /** Fresh set of single-use recovery codes (invalidates all previous). Shown ONCE. */
  async regenerateRecoveryCodes(accountId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(8).toString('base64url').slice(0, 10));
    await this.mfa.regenerateRecoveryCodes(accountId, codes.map((c) => sha256Hex(c)), new Date().toISOString());
    return codes;
  }

  /** Regenerate requires a live factor (proof from caller is step-up's business). */
  async rotateRecoveryCodes(accountId: string, factor: string): Promise<{ recovery_codes: string[] }> {
    const active = await this.mfa.findActive(accountId);
    if (!active) {
      throw ApiError.conflict('TOTP is not enabled');
    }
    const viaRecovery = await this.tryConsumeRecoveryCode(accountId, factor);
    if (!viaRecovery && !verifyTotp(this.activeSecret(active), factor)) {
      throw ApiError.unauthenticated('Invalid code');
    }
    const codes = await this.regenerateRecoveryCodes(accountId);
    await this.audit.add({
      action: 'mfa.recovery_codes_rotated',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
    return { recovery_codes: codes };
  }

  /**
   * Login-time challenge policy (H-5): an active TOTP credential is the one
   * enrollment state that demands a second factor at login. Recovery codes
   * only exist alongside TOTP, so "codes remaining" adds no separate case —
   * they are accepted AS the factor below.
   */
  async requiresSecondFactor(accountId: string): Promise<boolean> {
    return (await this.mfa.findActive(accountId)) !== null;
  }

  /**
   * Verify a login-time second factor: a live TOTP code or a single-use
   * recovery code (consumed atomically on match). Never throws — the caller
   * owns rate limiting, auditing, and the failure UX.
   */
  async verifyLoginFactor(accountId: string, presented: string): Promise<boolean> {
    const active = await this.mfa.findActive(accountId);
    if (!active) {
      return false;
    }
    const viaRecovery = await this.tryConsumeRecoveryCode(accountId, presented);
    if (viaRecovery) {
      return true;
    }
    if (!verifyTotp(this.activeSecret(active), presented)) {
      return false;
    }
    await this.mfa.touchLastUsed(active.id, new Date().toISOString());
    return true;
  }

  async status(accountId: string): Promise<{ mfa_level: string; totp_enabled: boolean; pending_enrollment: boolean; unused_recovery_codes: number }> {
    const [mfaLevel, active, pending, unused] = await Promise.all([
      this.mfa.mfaLevel(accountId),
      this.mfa.findActive(accountId),
      this.mfa.findPending(accountId),
      this.mfa.countUnusedRecoveryCodes(accountId),
    ]);
    return {
      mfa_level: mfaLevel,
      totp_enabled: !!active,
      pending_enrollment: !!pending,
      unused_recovery_codes: unused,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private activeSecret(credential: { totpSecretEnvelope: string | null }): string {
    if (!credential.totpSecretEnvelope) {
      throw ApiError.internal();
    }
    return envelopeDecrypt(credential.totpSecretEnvelope);
  }

  /** Atomically consume one recovery code; false when none matches / already used. */
  private async tryConsumeRecoveryCode(accountId: string, presented: string): Promise<boolean> {
    if (presented.length !== 10) {
      return false;
    }
    return this.mfa.consumeRecoveryCode(accountId, sha256Hex(presented), new Date().toISOString());
  }
}
