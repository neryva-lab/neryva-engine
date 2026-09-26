/**
 * PostgreSQL lane for `IRetentionPolicyRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/retention-purge.service.ts`
 * (`upsertPolicy` / `sweepRetention` / `sweepConversationRetention` /
 * `sweepAllRetention`'s tenant read). Byte-identical behavior, same
 * transaction boundaries, same error semantics — the queries moved here
 * mechanically; no logic changed.
 */
import { sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { legacyTenants } from '../../../common/infra/db/legacy-schema';
import { retentionPolicies } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { IRetentionPolicyRepository } from './retention-policy.repository';

@Injectable()
export class PgRetentionPolicyRepository implements IRetentionPolicyRepository {
  constructor(private readonly db: DbService) {}

  async upsertPolicy(input: {
    orgId: string;
    resourceType: string;
    retentionClass: string;
    keepDays: number;
    actor: string;
  }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    await this.db.withOrg(input.orgId, async (tx) => {
      // True upsert — a changed keep_days must take effect, not be silently
      // swallowed by a DO NOTHING.
      await tx
        .insert(retentionPolicies)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          resourceType: input.resourceType,
          retentionClass: input.retentionClass,
          keepUntilRule: { keep_days: input.keepDays },
          createdBy: input.actor,
        })
        .onConflictDoUpdate({
          target: [retentionPolicies.organizationId, retentionPolicies.resourceType, retentionPolicies.retentionClass],
          set: { keepUntilRule: { keep_days: input.keepDays } },
        });
    });
  }

  async sweepArtifactRetention(orgId: string): Promise<number> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, async (tx) => {
      const created = await tx.execute(sql`
        insert into purge_tasks (id, organization_id, scope_type, scope_id, reason)
        select gen_random_uuid(), a.organization_id, 'artifact', a.id, 'retention_expiry'
        from artifacts a
        join retention_policies p on p.organization_id = a.organization_id
          and p.resource_type = 'artifact' and p.retention_class = a.retention_class
        where a.organization_id = ${orgId}::uuid
          and a.state = 'active'
          and a.created_at < now() - ((p.keep_until_rule->>'keep_days')::int * interval '1 day')
          and not exists (
            select 1 from purge_tasks pt
            where pt.organization_id = a.organization_id and pt.scope_id = a.id
              and pt.state in ('pending','in_progress','blocked','done')
          )
        returning id
      `);
      return created.rows.length;
    });
  }

  async sweepConversationRetention(orgId: string): Promise<number> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, async (tx) => {
      const created = await tx.execute(sql`
        insert into purge_tasks (id, organization_id, scope_type, scope_id, reason)
        select gen_random_uuid(), c.organization_id, 'conversation', c.id, 'retention_expiry'
        from conversations c
        join tenants t on t.id = c.organization_id::text
        where c.organization_id = ${orgId}::uuid
          and t.retention_days is not null
          and c.status <> 'deleted'
          and c.created_at < now() - (t.retention_days * interval '1 day')
          and not exists (
            select 1 from purge_tasks pt
            where pt.organization_id = c.organization_id and pt.scope_id = c.id
              and pt.state in ('pending','in_progress','blocked','done')
          )
        returning id
      `);
      return created.rows.length;
    });
  }

  async listTenantIds(): Promise<string[]> {
    const rows = await this.db.withBypass((tx) => tx.select({ id: legacyTenants.id }).from(legacyTenants));
    return rows.map((r) => r.id);
  }
}
