import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { AuditService } from '../../../common/audit/audit.service';
import { EventBus, EngineEvents, AccountCreatedEvent } from '../../../common/events/event-bus';
import { ApiError } from '../../../common/http/api-error';
import { accountIdentities, accounts } from '../schema';
import { CredentialsService } from '../credentials.service';

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
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly credentials: CredentialsService,
  ) {}

  /** Resolve a verified social profile to an account (link or create). */
  async resolve(profile: SocialProfile): Promise<{ account: typeof accounts.$inferSelect; linked: boolean; created: boolean }> {
    // 1. Existing federated identity — the subject is the truth.
    const identityRows = await this.db.root
      .select({ accountId: accountIdentities.accountId })
      .from(accountIdentities)
      .where(and(eq(accountIdentities.provider, profile.provider), eq(accountIdentities.subject, profile.subject)))
      .limit(1);
    if (identityRows[0]) {
      const accountRows = await this.db.root.select().from(accounts).where(eq(accounts.id, identityRows[0].accountId)).limit(1);
      const account = accountRows[0];
      if (!account || account.status !== 'active') {
        throw new Error('account is not active');
      }
      await this.db.root
        .update(accountIdentities)
        .set({ lastUsedAt: new Date().toISOString(), ...(profile.email ? { email: profile.email } : {}) })
        .where(and(eq(accountIdentities.provider, profile.provider), eq(accountIdentities.subject, profile.subject)));
      return { account, linked: false, created: false };
    }

    // 2. Verified-email link into an existing account.
    if (profile.email && profile.emailVerified) {
      const existing = await this.db.root.select().from(accounts).where(eq(accounts.email, profile.email.toLowerCase())).limit(1);
      if (existing[0] && existing[0].status === 'active') {
        await this.linkIdentity(existing[0].id, profile);
        return { account: existing[0], linked: true, created: false };
      }
    }

    // 3. New account. Federated-only accounts without an email address get
    //    the provider's noreply form — login-by-subject keeps working and
    //    transactional mail to it simply no-ops (never a guessed real box).
    const email = profile.email?.toLowerCase() ?? `${profile.provider}-${profile.subject}@users.noreply.neryva.com`;
    const inserted = await this.db.root
      .insert(accounts)
      .values({
        email,
        emailVerifiedAt: profile.emailVerified ? new Date().toISOString() : null,
        displayName: profile.displayName?.slice(0, 256) ?? email.split('@')[0],
        createdVia: `social:${profile.provider}`,
      })
      .onConflictDoNothing({ target: accounts.email })
      .returning();
    let account = inserted[0];
    if (!account) {
      // Lost an insert race (two providers resolving the same instant) —
      // the winner's row is the account; link into it.
      const raced = await this.db.root.select().from(accounts).where(eq(accounts.email, email)).limit(1);
      account = raced[0];
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
    await this.db.root
      .insert(accountIdentities)
      .values({
        accountId,
        provider: profile.provider,
        subject: profile.subject,
        email: profile.email?.toLowerCase() ?? null,
        lastUsedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [accountIdentities.provider, accountIdentities.subject],
        set: { lastUsedAt: new Date().toISOString(), email: profile.email?.toLowerCase() ?? null },
      });
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
    const rows = await this.db.root.select().from(accountIdentities).where(eq(accountIdentities.accountId, accountId));
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
    const rows = await this.db.root.select().from(accountIdentities).where(eq(accountIdentities.id, input.identityId)).limit(1);
    const identity = rows[0];
    if (!identity || identity.accountId !== input.accountId) {
      throw ApiError.notFound('linked identity');
    }
    if (identity.provider === 'local') {
      throw ApiError.forbidden('The local credential is managed by the password surface, not unlink');
    }
    const accountRows = await this.db.root.select().from(accounts).where(eq(accounts.id, input.accountId)).limit(1);
    const account = accountRows[0];
    const remaining = await this.db.root.select().from(accountIdentities).where(eq(accountIdentities.accountId, input.accountId));
    // AUTH-3.2: password presence comes from the factor registry, not the account row.
    const passwordHash = await this.credentials.getPasswordHash(input.accountId);
    const otherWaysIn =
      passwordHash !== null ||
      (account?.emailVerifiedAt ?? null) !== null || // email-code login stays
      remaining.some((r) => r.id !== identity.id);
    if (!otherWaysIn) {
      throw ApiError.conflict('Cannot remove the only way into this account');
    }
    await this.db.root.delete(accountIdentities).where(eq(accountIdentities.id, input.identityId));
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
  federatedOrigin(account: typeof accounts.$inferSelect): boolean {
    return account.createdVia.startsWith('social:');
  }
}
