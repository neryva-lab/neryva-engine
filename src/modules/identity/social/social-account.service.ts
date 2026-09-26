import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { EventBus, EngineEvents, AccountCreatedEvent } from '../../../common/events/event-bus';
import { ApiError } from '../../../common/http/api-error';
import { CredentialsService } from '../credentials.service';
import { ACCOUNT_REPOSITORY, IDENTITY_LINK_REPOSITORY } from '../repositories/repository-tokens';
import type { Account, IAccountRepository } from '../repositories/account.repository';
import type { IIdentityLinkRepository } from '../repositories/identity-link.repository';

/**
 * The social account-linking policy (doc-06 Δ1 + ADR-001). Order matters —
 * it IS the security model:
 *
 *  1. SUBJECT FIRST: an existing (provider, subject) identity row always
 *     wins. The IdP's subject is the only assertion we never infer.
 *  2. VERIFIED-EMAIL LINK: an IdP-verified email may link into an existing
 *     account of that address (the user just proved mailbox control at the
 *     IdP). Unverified emails NEVER link — a fresh subject-only account is
 *     created instead (prevents the classic takeover-by-unverified-email).
 *  3. CREATE: otherwise a new account, email marked verified when the IdP
 *     asserted verification.
 *
 * The one-way binding rule (benchmark pattern #5, OpenAI): an account
 * CREATED via federation never grows a password. Enforced structurally:
 * `accounts.created_via` records the origin, and the (future) set-password
 * surface refuses federated-origin accounts via federatedOrigin().
 *
 * Persistence goes through `IAccountRepository` / `IIdentityLinkRepository`
 * (provider-blind) — never Drizzle, never `DbService`.
 */
export interface SocialProfile {
  provider: string; // google | github | apple | microsoft
  subject: string; // the IdP's stable subject
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

@Injectable()
export class SocialAccountService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(IDENTITY_LINK_REPOSITORY) private readonly links: IIdentityLinkRepository,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly credentials: CredentialsService,
  ) {}

  /** Resolve a verified social profile to an account (link or create). */
  async resolve(profile: SocialProfile): Promise<{ account: Account; linked: boolean; created: boolean }> {
    // 1. Existing federated identity — the subject is the truth.
    const accountId = await this.links.findAccountId(profile.provider, profile.subject);
    if (accountId) {
      const account = await this.accounts.findById(accountId);
      if (!account || account.status !== 'active') {
        throw new Error('account is not active');
      }
      await this.links.touchLastUsed(
        profile.provider,
        profile.subject,
        profile.email ?? null,
        new Date().toISOString(),
      );
      return { account, linked: false, created: false };
    }

    // 2. Verified-email link into an existing account.
    if (profile.email && profile.emailVerified) {
      const existing = await this.accounts.findByEmail(profile.email.toLowerCase());
      if (existing && existing.status === 'active') {
        await this.linkIdentity(existing.id, profile);
        return { account: existing, linked: true, created: false };
      }
    }

    // 3. New account. Federated-only accounts without an email address get
    //    the provider's noreply form — login-by-subject keeps working and
    //    transactional mail to it simply no-ops (never a guessed real box).
    const email = profile.email?.toLowerCase() ?? `${profile.provider}-${profile.subject}@users.noreply.neryva.com`;
    const nowIso = new Date().toISOString();
    // The port reports whether THIS call won the insert; step 3 treats the
    // account as its own creation either way (link + created audit + event),
    // exactly as the pre-port code did on the lost-race path.
    const { account } = await this.accounts.upsertByEmail(email, {
      createdVia: `social:${profile.provider}`,
      emailVerifiedAt: profile.emailVerified ? nowIso : null,
      displayName: profile.displayName?.slice(0, 256) ?? email.split('@')[0],
    });
    // The conflicting row can be arbitrarily OLD (locked/disabled long
    // ago) — a non-active account must never gain a session on either the
    // insert or the race path. (Step 1 throws and step 2 skips non-active
    // rows; without this, step 3 would link straight through a lock.)
    if (!account || account.status !== 'active') {
      throw new Error('account is not active');
    }
    await this.linkIdentity(account.id, profile);
    await this.audit.add({
      action: 'account.created',
      resourceType: 'account',
      resourceId: account.id,
      actorType: 'system',
      details: { via: `social:${profile.provider}` },
    });
    await this.events.emit<AccountCreatedEvent>(EngineEvents.AccountCreated, { accountId: account.id, email: account.email });
    return { account, linked: true, created: true };
  }

  private async linkIdentity(accountId: string, profile: SocialProfile): Promise<void> {
    await this.links.link(
      accountId,
      profile.provider,
      profile.subject,
      profile.email?.toLowerCase() ?? null,
      new Date().toISOString(),
    );
    await this.audit.add({
      action: 'identity.linked',
      resourceType: 'account_identity',
      resourceId: `${profile.provider}:${profile.subject.slice(0, 32)}`,
      actorType: 'account',
      actorId: accountId,
      details: { provider: profile.provider, verified_email: profile.emailVerified },
    });
  }

  /** Linked identities for the account-management surface. */
  async listIdentities(accountId: string): Promise<Array<{ id: string; provider: string; email: string | null; linkedAt: string; lastUsedAt: string | null }>> {
    const rows = await this.links.listByAccount(accountId);
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      email: row.email,
      linkedAt: row.linkedAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  /**
   * Unlink a federated identity. Lockout guard: the account must keep at
   * least one way in — a password, another identity, or (email-code
   * accounts) a verified mailbox. Unlinking a `local` row is refused: it
   * is not a federated credential.
   */
  async unlink(input: { accountId: string; identityId: string }): Promise<void> {
    const identity = await this.links.findById(input.identityId);
    if (!identity || identity.accountId !== input.accountId) {
      throw ApiError.notFound('linked identity');
    }
    if (identity.provider === 'local') {
      throw ApiError.forbidden('The local credential is managed by the password surface, not unlink');
    }
    const account = await this.accounts.findById(input.accountId);
    const remaining = await this.links.listByAccount(input.accountId);
    // AUTH-3.2: password presence comes from the factor registry, not the account row.
    const passwordHash = await this.credentials.getPasswordHash(input.accountId);
    const otherWaysIn =
      passwordHash !== null ||
      (account?.emailVerifiedAt ?? null) !== null || // email-code login stays
      remaining.some((r) => r.id !== identity.id);
    if (!otherWaysIn) {
      throw ApiError.conflict('Cannot remove the only way into this account');
    }
    await this.links.deleteById(input.identityId);
    await this.audit.add({
      action: 'identity.unlinked',
      resourceType: 'account_identity',
      resourceId: input.identityId,
      actorType: 'account',
      actorId: input.accountId,
      details: { provider: identity.provider },
    });
  }

  /** The one-way rule: federated-origin accounts never grow a password (doc-06 Δ1). */
  federatedOrigin(account: Account): boolean {
    return account.createdVia.startsWith('social:');
  }
}
