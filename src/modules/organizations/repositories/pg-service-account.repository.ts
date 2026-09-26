import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { orgServiceAccounts } from '../schema';
import type { IServiceAccountRepository, ServiceAccountRow } from './service-account.repository';

/**
 * PostgreSQL implementation of `IServiceAccountRepository` (P3).
 *
 * Mechanical move of the `OrgServiceAccountsService` persistence units.
 * Org-scoped methods own their transaction via `DbService.withOrg`; the
 * AuthGuard lookups (`findByTokenHash`, `touchTokenLastUsed`) run under
 * `withBypass` — authentication happens before any org context exists, and
 * the filter is the globally-unique unguessable hash
 * (`uq_org_service_accounts_token_hash`). No transaction handle leaks
 * through this interface.
 *
 * What stays OUT (still the caller's job): token minting/hashing, input
 * validation, token-state guards, audit writes, event emission, the
 * validateByHash outcome shaping.
 */
export class PgServiceAccountRepository implements IServiceAccountRepository {
  constructor(private readonly db: DbService) {}

  /** Service accounts of the org, newest first. */
  async listServiceAccounts(orgId: string): Promise<ServiceAccountRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(orgServiceAccounts)
        .where(eq(orgServiceAccounts.orgId, orgId))
        .orderBy(desc(orgServiceAccounts.createdAt)),
    );
  }

  /** Raw row read; the service maps a miss to NotFoundException. */
  async getServiceAccount(orgId: string, id: string): Promise<ServiceAccountRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(orgServiceAccounts)
        .where(and(eq(orgServiceAccounts.id, id), eq(orgServiceAccounts.orgId, orgId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** Insert with a freshly minted token hash/prefix (computed by the service). */
  async createServiceAccount(input: {
    orgId: string;
    name: string;
    description: string | null;
    scopes: string[];
    tokenHash: string;
    tokenPrefix: string;
    tokenLastRotatedAt: string;
    createdBy: string;
  }): Promise<ServiceAccountRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgServiceAccounts)
        .values({
          orgId: input.orgId,
          name: input.name,
          description: input.description,
          scopes: input.scopes,
          tokenHash: input.tokenHash,
          tokenPrefix: input.tokenPrefix,
          tokenLastRotatedAt: input.tokenLastRotatedAt,
          createdBy: input.createdBy,
        })
        .returning(),
    );
    return inserted[0];
  }

  /**
   * Compare-and-swap the token hash on the row's current hash so a
   * concurrent rotate cannot silently win. False when no row matched.
   */
  async rotateTokenHash(input: {
    orgId: string;
    id: string;
    expectedTokenHash: string | null;
    tokenHash: string;
    tokenPrefix: string;
    tokenLastRotatedAt: string;
    updatedAt: string;
  }): Promise<boolean> {
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgServiceAccounts)
        .set({
          tokenHash: input.tokenHash,
          tokenPrefix: input.tokenPrefix,
          tokenExpiresAt: null,
          tokenLastRotatedAt: input.tokenLastRotatedAt,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(orgServiceAccounts.id, input.id),
            eq(orgServiceAccounts.tokenHash, input.expectedTokenHash ?? ''),
          ),
        )
        .returning({ id: orgServiceAccounts.id }),
    );
    return updated.length === 1;
  }

  /** Revoke just the token — the identity and its metadata stay. */
  async revokeToken(orgId: string, id: string, updatedAt: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgServiceAccounts)
        .set({ tokenHash: null, tokenPrefix: null, tokenExpiresAt: null, updatedAt })
        .where(and(eq(orgServiceAccounts.id, id), eq(orgServiceAccounts.orgId, orgId))),
    );
  }

  /** Disable (voids the token) — the account stops authenticating. */
  async disableServiceAccount(orgId: string, id: string, updatedAt: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgServiceAccounts)
        .set({ status: 'disabled', tokenHash: null, tokenPrefix: null, tokenExpiresAt: null, updatedAt })
        .where(and(eq(orgServiceAccounts.id, id), eq(orgServiceAccounts.orgId, orgId))),
    );
  }

  /** Re-enable; the token must be rotated to authenticate again. */
  async enableServiceAccount(orgId: string, id: string, updatedAt: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgServiceAccounts)
        .set({ status: 'active', updatedAt })
        .where(and(eq(orgServiceAccounts.id, id), eq(orgServiceAccounts.orgId, orgId))),
    );
  }

  /** Delete the identity row. */
  async removeServiceAccount(orgId: string, id: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .delete(orgServiceAccounts)
        .where(and(eq(orgServiceAccounts.id, id), eq(orgServiceAccounts.orgId, orgId))),
    );
  }

  /**
   * AuthGuard lookup by token hash — deliberately cross-tenant and global:
   * authentication happens before any org context exists; the filter is
   * the globally-unique unguessable hash.
   */
  async findByTokenHash(tokenHash: string): Promise<ServiceAccountRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(orgServiceAccounts).where(eq(orgServiceAccounts.tokenHash, tokenHash)).limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Fire-and-forget usage telemetry (same discipline as L2 keys):
   * best-effort, cross-tenant by id — the id is globally unique.
   */
  async touchTokenLastUsed(id: string, at: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx.update(orgServiceAccounts).set({ tokenLastUsedAt: at }).where(eq(orgServiceAccounts.id, id)),
    );
  }
}
