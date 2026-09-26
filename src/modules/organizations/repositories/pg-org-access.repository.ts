import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { legacyTenants } from '../../../common/infra/db/legacy-schema';
import { orgMemberships, orgSettings } from '../schema';
import type { IOrgAccessRepository } from './org-access.repository';

/**
 * PostgreSQL implementation of `IOrgAccessRepository` (P3).
 *
 * Mechanical move of `OrgAccessService.insertOrgWithOwner` /
 * `assertOwnershipCapacity` — the tenants INSERT seam (explicit columns,
 * transaction-local timeouts + tenant context) and the ownership-cap
 * count are the service's original statements, unchanged.
 *
 * The slug-collision 23505 is translated here to the stable
 * `ApiError.conflict('that workspace address is already taken',
 * { reason: 'slug_taken' })` both lanes return — the service drops its old
 * `pgViolation` mapping for this call (behavior-preserving: same 409).
 */
export class PgOrgAccessRepository implements IOrgAccessRepository {
  constructor(private readonly db: DbService) {}

  async createOrgWithOwner(input: {
    orgId: string;
    slug: string;
    name: string;
    accountId: string;
    kind: 'personal' | 'team';
  }): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.db.root.transaction(async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '10000', true)`);
        await tx.execute(sql`select set_config('idle_in_transaction_session_timeout', '30000', true)`);
        await tx.execute(sql`select set_config('app.current_tenant', ${input.orgId}, true)`);
        await tx.insert(legacyTenants).values({
          id: input.orgId,
          slug: input.slug,
          name: input.name,
          allowed_topics: [],
          blocked_topics: [],
          escalation_threshold: 0.7,
          knowledge_allowlist: [],
          default_provider: 'openai',
          default_model: 'gpt-4',
          features: {},
          guardrail_config: {},
          guardrail_thresholds: {},
          version: 1,
          // The Python TenantModel supplies these; the mirror carries no
          // defaults, so the engine passes them explicitly.
          created_at: now,
          updated_at: now,
        });
        await tx
          .insert(orgMemberships)
          .values({ accountId: input.accountId, orgId: input.orgId, role: 'owner', invitedBy: null });
        if (input.kind === 'team') {
          await tx.insert(orgSettings).values({ orgId: input.orgId, kind: 'team' }).onConflictDoNothing({ target: orgSettings.orgId });
        }
      });
    } catch (err) {
      if (pgViolation(err).code === '23505') {
        throw ApiError.conflict('that workspace address is already taken', { reason: 'slug_taken' });
      }
      throw err;
    }
  }

  async countOwnedOrgs(accountId: string): Promise<number> {
    const rows = await this.db.withBypass((tx) =>
      // Justification (withBypass): the caller's own ownership rows span
      // orgs by definition; the query filters account_id explicitly.
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.accountId, accountId),
            eq(orgMemberships.role, 'owner'),
            eq(orgMemberships.status, 'active'),
          ),
        ),
    );
    return Number(rows[0]?.n ?? 0);
  }
}
