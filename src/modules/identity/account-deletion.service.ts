import { and, eq, lte, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { accounts, oauthGrants } from './schema';
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
 */
@Injectable()
export class AccountDeletionService {
  private static readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly db: DbService,
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
    const existing = await this.deletionRow(input.accountId);
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
    await this.db.root
      .update(accounts)
      .set({ deletedAt: scheduledPurgeAt, updatedAt: new Date().toISOString() })
      .where(eq(accounts.id, input.accountId));
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
    const row = await this.deletionRow(accountId);
    if (!row?.deletedAt) {
      throw ApiError.notFound('pending account deletion');
    }
    await this.db.root
      .update(accounts)
      .set({ deletedAt: null, updatedAt: new Date().toISOString() })
      .where(and(eq(accounts.id, accountId), eq(accounts.status, 'active')));
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
    const row = await this.deletionRow(accountId);
    return row?.deletedAt ? { scheduled_purge_at: row.deletedAt } : null;
  }

  /** The daily purge pass: erase due accounts. Returns purged ids (ops evidence). */
  async purgeDue(): Promise<string[]> {
    const due = await this.db.root
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(lte(accounts.deletedAt, new Date().toISOString())));
    const purged: string[] = [];
    for (const row of due) {
      try {
        await this.purge(row.id);
        purged.push(row.id);
      } catch (err) {
        AccountDeletionService.logger.error(`purge failed for account ${row.id}: ${(err as Error).message}`);
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

    // Grants carry no FK to accounts — explicit delete first (sessions and
    // everything under the account row go with the final DELETE's cascade).
    await this.db.root.delete(oauthGrants).where(eq(oauthGrants.accountId, accountId));
    await this.db.root.execute(sql`delete from notifications where account_id = ${accountId}`);
    // Justification (withBypass): the purge sweeps the account out of every
    // org at once — an explicitly administrative, cross-tenant delete.
    await this.db.withBypass(async (tx) => {
      await tx.execute(sql`delete from org_group_members where account_id = ${accountId}`);
      await tx.execute(sql`delete from org_memberships where account_id = ${accountId}`);
    });
    await this.db.root.delete(accounts).where(eq(accounts.id, accountId));

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

  private async deletionRow(accountId: string) {
    const rows = await this.db.root.select({ deletedAt: accounts.deletedAt }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    return rows[0] ?? null;
  }
}
