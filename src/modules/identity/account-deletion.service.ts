import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { ACCOUNT_REPOSITORY } from './repositories/repository-tokens';
import type { IAccountRepository } from './repositories/account.repository';
import { AccountsService } from './accounts.service';
import { CredentialsService } from './credentials.service';
import { MfaService } from './mfa.service';

/**
 * Account self-service deletion (H-6) — the org-lifecycle pattern applied
 * to the human credential store:
 *
 *  - request (authenticated + re-auth): the current password AND a live
 *    second factor (when TOTP is enrolled) must be presented; the grace
 *    clock starts (ACCOUNT_DELETION_GRACE_DAYS); every session/token dies
 *    immediately (revocation feed included).
 *  - cancel (authenticated, during grace): clears the flag. Login stays
 *    possible during grace precisely so the cancellation path exists.
 *  - purge (worker, daily): erases the engine-owned rows — org membership
 *    rows across orgs, grants, notifications — then the account row itself
 *    (its ON DELETE CASCADE takes credentials, recovery codes, federated
 *    identities, codes and sessions with it). RETAINED: the audit chain
 *    (append-only by construction — same posture as org purge) and
 *    billing records (financial retention).
 *
 * Persistence goes through `IAccountRepository` (provider-blind); the
 * grace-window policy, confirmation policy, audit writes, events, and
 * notifications stay here.
 */
@Injectable()
export class AccountDeletionService {
  private static readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accountsRepo: IAccountRepository,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly email: EmailService,
    private readonly accountsService: AccountsService,
    private readonly credentials: CredentialsService,
    private readonly mfa: MfaService,
  ) {}

  async request(input: { accountId: string; password?: string; factor?: string }): Promise<{ scheduled_purge_at: string }> {
    const account = await this.accountsService.findById(input.accountId);
    if (!account || account.status !== 'active') {
      throw ApiError.notFound('account');
    }
    const existing = await this.accountsRepo.findDeletionSchedule(input.accountId);
    if (existing?.deletedAt) {
      throw ApiError.conflict('deletion is already scheduled', { scheduled_purge_at: existing.deletedAt });
    }
    // Re-auth: password when one exists, always the second factor when TOTP
    // is enrolled. A passwordless, MFA-less account has no factor to
    // confirm with and may not self-delete (compromise containment posture).
    let confirmed = false;
    const storedHash = await this.credentials.getPasswordHash(input.accountId);
    if (storedHash) {
      if (!input.password || !(await this.credentials.verifyPassword(storedHash, input.password))) {
        throw ApiError.unauthenticated('Current password is incorrect');
      }
      confirmed = true;
    }
    if (await this.mfa.requiresSecondFactor(input.accountId)) {
      if (!input.factor || !(await this.mfa.verifyLoginFactor(input.accountId, input.factor))) {
        throw ApiError.unauthenticated('A live TOTP or recovery code is required');
      }
      confirmed = true;
    }
    if (!confirmed) {
      throw ApiError.forbidden('set a password or enable two-factor authentication before deleting your account');
    }

    const scheduledPurgeAt = new Date(Date.now() + env.ACCOUNT_DELETION_GRACE_DAYS * 86_400_000).toISOString();
    await this.accountsRepo.setScheduledDeletion(input.accountId, scheduledPurgeAt);
    // Sessions/tokens die NOW — grace only protects the data, not access.
    await this.accountsService.revokeAllSessions(input.accountId);
    void this.events.emit('identity.revocation', { kind: 'account_all', subjectId: input.accountId }).catch(() => undefined);

    await this.audit.add({
      action: 'account.deletion_requested',
      resourceType: 'account',
      resourceId: input.accountId,
      actorType: 'account',
      actorId: input.accountId,
      details: { scheduled_purge_at: scheduledPurgeAt },
    });
    await this.events.emit(EngineEvents.AccountDeletionRequested, { accountId: input.accountId, scheduledPurgeAt });
    await this.email
      .sendTemplate({
        template: 'identity.account-deletion-requested',
        to: account.email,
        vars: { purge_date: scheduledPurgeAt.slice(0, 10) },
        metadata: { accountId: input.accountId },
      })
      .catch(() => undefined);
    return { scheduled_purge_at: scheduledPurgeAt };
  }

  async cancel(accountId: string): Promise<void> {
    const row = await this.accountsRepo.findDeletionSchedule(accountId);
    if (!row?.deletedAt) {
      throw ApiError.notFound('pending account deletion');
    }
    await this.accountsRepo.clearScheduledDeletion(accountId);
    await this.audit.add({
      action: 'account.deletion_cancelled',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
    await this.events.emit(EngineEvents.AccountDeletionCancelled, { accountId });
  }

  async status(accountId: string): Promise<{ scheduled_purge_at: string } | null> {
    const row = await this.accountsRepo.findDeletionSchedule(accountId);
    return row?.deletedAt ? { scheduled_purge_at: row.deletedAt } : null;
  }

  /** The daily purge pass: erase due accounts. Returns purged ids (ops evidence). */
  async purgeDue(): Promise<string[]> {
    // The repository takes a limit; the previous implementation scanned the
    // whole due set, so pass an effectively-unbounded one to preserve that.
    const due = await this.accountsRepo.listPurgeDue(new Date().toISOString(), Number.MAX_SAFE_INTEGER);
    const purged: string[] = [];
    for (const accountId of due) {
      try {
        await this.purge(accountId);
        purged.push(accountId);
      } catch (err) {
        AccountDeletionService.logger.error(`purge failed for account ${accountId}: ${(err as Error).message}`);
      }
    }
    return purged;
  }

  private async purge(accountId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.audit.add({
      action: 'account.purge_started',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'system',
      details: {},
    });

    await this.accountsRepo.purgeAccount(accountId);

    await this.audit.add({
      action: 'account.purged',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'system',
      details: {
        retained: 'audit chain (append-only by construction) + billing records (financial retention)',
        purged_at: now,
      },
    });
    await this.events.emit(EngineEvents.AccountPurged, { accountId });
  }
}
