import { Inject, Injectable } from '@nestjs/common';
import { EventBus, EngineEvents, AccountCreatedEvent } from '../../common/events/event-bus';
import { AuditService } from '../../common/audit/audit.service';
import { ACCOUNT_REPOSITORY } from './repositories/repository-tokens';
import type { Account, IAccountRepository } from './repositories/account.repository';

/**
 * Neryva Accounts (doc-06 D1): the human credential store, the ONLY one in
 * the company. Email is the identity; a successful email-code login IS
 * email verification. Status model: active | locked | disabled — locked is
 * the abuse posture, disabled is administrative.
 *
 * Persistence goes through `IAccountRepository` (provider-blind).
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accountsRepo: IAccountRepository,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async findByEmail(email: string): Promise<Account | null> {
    return this.accountsRepo.findByEmail(email);
  }

  async findById(accountId: string): Promise<Account | null> {
    return this.accountsRepo.findById(accountId);
  }

  /**
   * Upsert-on-login (I-1a): an unknown email creates the account; a known
   * email returns it. Enumeration resistance comes for free — login and
   * signup are the same operation, so there is no separate signal.
   */
  async upsertByEmail(email: string): Promise<{ account: Account; created: boolean }> {
    const normalized = normalizeEmail(email);
    const existing = await this.findByEmail(normalized);
    if (existing) {
      if (existing.status !== 'active') {
        throw new Error('account is not active');
      }
      return { account: existing, created: false };
    }
    const { account, created } = await this.accountsRepo.upsertByEmail(normalized);
    if (created) {
      await this.audit.add({
        action: 'account.created',
        resourceType: 'account',
        resourceId: account.id,
        actorType: 'system',
        details: { email_hash_prefix: normalized.slice(0, 2) }, // domain only, not the address
      });
      await this.events.emit<AccountCreatedEvent>(EngineEvents.AccountCreated, {
        accountId: account.id,
        email: normalized,
      });
      return { account, created: true };
    }
    // Lost an insert race — the winner's row is the truth.
    return { account, created: false };
  }

  async markLoginSuccess(accountId: string): Promise<void> {
    await this.accountsRepo.markLoginSuccess(accountId, new Date().toISOString());
  }

  /** First successful email-code login proves the mailbox. */
  async markEmailVerified(accountId: string): Promise<void> {
    await this.accountsRepo.markEmailVerified(accountId, new Date().toISOString());
  }

  // AUTH-3.2: updatePasswordHash was removed — password material lives only
  // in account_credentials (kind='password') via CredentialsService.setPasswordHash.

  async updateDisplayName(accountId: string, displayName: string): Promise<void> {
    await this.accountsRepo.updateDisplayName(accountId, displayName);
    await this.audit.add({
      action: 'account.profile_updated',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
  }

  /** Global session kill-switch: the L1 guard compares iat against this. */
  async revokeAllSessions(accountId: string): Promise<void> {
    await this.accountsRepo.revokeAllSessions(accountId, new Date().toISOString());
    await this.events.emit(EngineEvents.SessionRevoked, { sid: null, accountId, revokeAllSessionsOfAccount: true });
  }

  /** Claims for the OP's findAccount (openid/email/profile scope-filtered upstream). */
  async claimsFor(accountId: string): Promise<Record<string, unknown>> {
    const account = await this.findById(accountId);
    if (!account) {
      throw new Error('account not found');
    }
    return {
      sub: account.id,
      email: account.email,
      email_verified: account.emailVerifiedAt !== null,
      name: account.displayName ?? account.email.split('@')[0],
      updated_at: Math.floor(Date.parse(account.updatedAt) / 1000),
    };
  }
}

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error('invalid email address');
  }
  return trimmed;
}
