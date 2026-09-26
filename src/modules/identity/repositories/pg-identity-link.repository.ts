import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accountIdentities } from '../schema';
import type { IdentityLink, IIdentityLinkRepository } from './identity-link.repository';

/**
 * PostgreSQL implementation of `IIdentityLinkRepository` (P3).
 *
 * Mechanical move of the `account_identities` units from
 * `SocialAccountService`. The social-account linking POLICY
 * (subject-first, verified-email link, one-way binding) stays in the
 * service; this port is the dumb store underneath it.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgIdentityLinkRepository implements IIdentityLinkRepository {
  constructor(private readonly db: DbService) {}

  /** The account bound to a (provider, subject) pair — the subject is the truth. */
  async findAccountId(provider: string, subject: string): Promise<string | null> {
    const rows = await this.db.root
      .select({ accountId: accountIdentities.accountId })
      .from(accountIdentities)
      .where(
        and(eq(accountIdentities.provider, provider), eq(accountIdentities.subject, subject)),
      )
      .limit(1);
    return rows[0]?.accountId ?? null;
  }

  async touchLastUsed(
    provider: string,
    subject: string,
    email: string | null,
    nowIso: string,
  ): Promise<void> {
    await this.db.root
      .update(accountIdentities)
      .set({ lastUsedAt: nowIso, ...(email ? { email } : {}) })
      .where(
        and(eq(accountIdentities.provider, provider), eq(accountIdentities.subject, subject)),
      );
  }

  /** Insert-or-refresh the federated identity row. */
  async link(
    accountId: string,
    provider: string,
    subject: string,
    email: string | null,
    nowIso: string,
  ): Promise<void> {
    await this.db.root
      .insert(accountIdentities)
      .values({
        accountId,
        provider,
        subject,
        email,
        lastUsedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [accountIdentities.provider, accountIdentities.subject],
        set: { lastUsedAt: nowIso, email },
      });
  }

  async listByAccount(accountId: string): Promise<IdentityLink[]> {
    const rows = await this.db.root
      .select()
      .from(accountIdentities)
      .where(eq(accountIdentities.accountId, accountId));
    return rows.map(toIdentityLink);
  }

  async findById(identityId: string): Promise<IdentityLink | null> {
    const rows = await this.db.root
      .select()
      .from(accountIdentities)
      .where(eq(accountIdentities.id, identityId))
      .limit(1);
    return rows[0] ? toIdentityLink(rows[0]) : null;
  }

  async deleteById(identityId: string): Promise<void> {
    await this.db.root.delete(accountIdentities).where(eq(accountIdentities.id, identityId));
  }
}

function toIdentityLink(row: typeof accountIdentities.$inferSelect): IdentityLink {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider,
    subject: row.subject,
    email: row.email,
    linkedAt: row.linkedAt,
    lastUsedAt: row.lastUsedAt,
  };
}
