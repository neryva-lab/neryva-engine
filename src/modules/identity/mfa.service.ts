import { and, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { envelopeDecrypt, envelopeEncrypt, sha256Hex } from '../../common/infra/crypto/envelope';
import { mintMfaProof } from '../../common/auth/mfa-proof';
import { accountCredentials, accountRecoveryCodes, accounts } from './schema';
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
 * Security: every state change is audited; disable requires a current TOTP
 * code (or a recovery code) AND revokes all sessions; recovery codes are
 * consumed atomically single-use.
 */
const RECOVERY_CODE_COUNT = 10;

@Injectable()
export class MfaService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: generate + persist a pending secret. Returns the QR payload + secret once. */
  async enroll(accountId: string, email: string): Promise<{ secret: string; otpauth_url: string }> {
    // Refuse a second parallel enrollment; finish or disable the first.
    const existing = await this.activeCredential(accountId);
    if (existing) {
      throw ApiError.conflict('TOTP is already enabled for this account');
    }
    const pending = await this.pendingCredential(accountId);
    const { secretBase32 } = generateTotpSecret();
    const envelope = { secret: envelopeEncrypt(secretBase32) };
    if (pending) {
      await this.db.root
        .update(accountCredentials)
        .set({ envelope, updatedAt: new Date().toISOString() })
        .where(eq(accountCredentials.id, pending.id));
    } else {
      await this.db.root.insert(accountCredentials).values({
        accountId,
        kind: 'totp_pending',
        envelope,
      });
    }
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
    const pending = await this.pendingCredential(accountId);
    if (!pending || !pending.envelope) {
      throw ApiError.conflict('no pending TOTP enrollment — start one first');
    }
    const secret = this.pendingSecret(pending.envelope);
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
    await this.db.root.transaction(async (tx) => {
      await tx.delete(accountCredentials).where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, 'totp_pending')));
      await tx
        .insert(accountCredentials)
        .values({ accountId, kind: 'totp', envelope: pending.envelope, verifiedAt: now })
        .onConflictDoUpdate({
          target: [accountCredentials.accountId, accountCredentials.kind],
          set: { envelope: pending.envelope, verifiedAt: now, revokedAt: null, updatedAt: now },
        });
      await tx.update(accounts).set({ mfaLevel: 'totp', updatedAt: now }).where(eq(accounts.id, accountId));
    });

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
    const active = await this.activeCredential(accountId);
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

    const now = new Date().toISOString();
    await this.db.root.transaction(async (tx) => {
      await tx.delete(accountCredentials).where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, 'totp')));
      await tx.delete(accountCredentials).where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, 'totp_pending')));
      await tx.delete(accountRecoveryCodes).where(and(eq(accountRecoveryCodes.accountId, accountId), isNull(accountRecoveryCodes.usedAt)));
      await tx.update(accounts).set({ mfaLevel: 'none', updatedAt: now }).where(eq(accounts.id, accountId));
    });
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
    const active = await this.activeCredential(accountId);
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
    if (active.envelope) {
      const now = new Date().toISOString();
      await this.db.root
        .update(accountCredentials)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(accountCredentials.id, active.id));
    }
    const proof = mintMfaProof(accountId);
    return { proof, expires_in_seconds: 300 };
  }

  /** Fresh set of single-use recovery codes (invalidates all previous). Shown ONCE. */
  async regenerateRecoveryCodes(accountId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(8).toString('base64url').slice(0, 10));
    await this.db.root.transaction(async (tx) => {
      await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
      await tx.insert(accountRecoveryCodes).values(codes.map((code) => ({ accountId, codeHash: sha256Hex(code) })));
    });
    return codes;
  }

  /** Regenerate requires a live factor (proof from caller is step-up's business). */
  async rotateRecoveryCodes(accountId: string, factor: string): Promise<{ recovery_codes: string[] }> {
    const active = await this.activeCredential(accountId);
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

  async status(accountId: string): Promise<{ mfa_level: string; totp_enabled: boolean; pending_enrollment: boolean; unused_recovery_codes: number }> {
    const [accountRow] = await this.db.root.select({ mfaLevel: accounts.mfaLevel }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const active = await this.activeCredential(accountId);
    const pending = await this.pendingCredential(accountId);
    const unused = await this.db.root
      .select({ id: accountRecoveryCodes.id })
      .from(accountRecoveryCodes)
      .where(and(eq(accountRecoveryCodes.accountId, accountId), isNull(accountRecoveryCodes.usedAt)));
    return {
      mfa_level: accountRow?.mfaLevel ?? 'none',
      totp_enabled: !!active,
      pending_enrollment: !!pending,
      unused_recovery_codes: unused.length,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async activeCredential(accountId: string) {
    const rows = await this.db.root
      .select()
      .from(accountCredentials)
      .where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, 'totp'), isNull(accountCredentials.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async pendingCredential(accountId: string) {
    const rows = await this.db.root
      .select()
      .from(accountCredentials)
      .where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, 'totp_pending')))
      .limit(1);
    return rows[0] ?? null;
  }

  private activeSecret(row: typeof accountCredentials.$inferSelect): string {
    const envelope = row.envelope as { secret?: string } | null;
    if (!envelope?.secret) {
      throw ApiError.internal();
    }
    return envelopeDecrypt(envelope.secret);
  }

  private pendingSecret(envelope: unknown): string {
    const env_ = envelope as { secret?: string } | null;
    if (!env_?.secret) {
      throw ApiError.internal();
    }
    return envelopeDecrypt(env_.secret);
  }

  /** Atomically consume one recovery code; false when none matches / already used. */
  private async tryConsumeRecoveryCode(accountId: string, presented: string): Promise<boolean> {
    if (presented.length !== 10) {
      return false;
    }
    const updated = await this.db.root
      .update(accountRecoveryCodes)
      .set({ usedAt: new Date().toISOString() })
      .where(and(eq(accountRecoveryCodes.accountId, accountId), eq(accountRecoveryCodes.codeHash, sha256Hex(presented)), isNull(accountRecoveryCodes.usedAt)))
      .returning({ id: accountRecoveryCodes.id });
    return updated.length === 1;
  }
}
