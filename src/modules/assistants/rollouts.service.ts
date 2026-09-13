import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { assistantRollouts, assistantVersions, AssistantRollout, RolloutVariant } from './schema';

/**
 * FL-3.12 — A/B / canary rollout management. The rollout lives BESIDE the
 * atomic publish pointer: `assistants.active_version_id` stays the default;
 * an active rollout splits traffic across PUBLISHED versions by weight.
 * Selection is sticky per conversation (conversations.service); this service
 * owns the CRUD + invariants:
 *   - every variant version belongs to the assistant and is PUBLISHED,
 *   - weights are positive integers summing to exactly 100,
 *   - at most ONE active rollout per assistant (partial unique index).
 */
@Injectable()
export class RolloutsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private static parseVariants(raw: unknown): RolloutVariant[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) {
      throw ApiError.validation({ versions: 'must be an array of 1..10 variants' });
    }
    const out: RolloutVariant[] = [];
    for (const v of raw) {
      const rec = v as { version_id?: unknown; weight?: unknown };
      if (typeof rec?.version_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(rec.version_id)) {
        throw ApiError.validation({ versions: 'each variant needs a version_id uuid' });
      }
      if (typeof rec?.weight !== 'number' || !Number.isInteger(rec.weight) || rec.weight <= 0) {
        throw ApiError.validation({ versions: 'each variant weight must be a positive integer' });
      }
      out.push({ version_id: rec.version_id, weight: rec.weight });
    }
    const total = out.reduce((acc, v) => acc + v.weight, 0);
    if (total !== 100) {
      throw ApiError.validation({ versions: `weights must sum to 100 (got ${total})` });
    }
    return out;
  }

  /** Activate (or replace) the rollout for an assistant. */
  async set(input: { orgId: string; assistantId: string; versions: unknown; actor: string }): Promise<AssistantRollout> {
    const variants = RolloutsService.parseVariants(input.versions);
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const exists = await tx.execute(sql`select 1 from assistants where id = ${input.assistantId}::uuid and organization_id = ${input.orgId}::uuid limit 1`);
      if (exists.rows.length === 0) {
        throw ApiError.notFound('assistant');
      }
      for (const v of variants) {
        const version = await tx
          .select({ id: assistantVersions.id, status: assistantVersions.status })
          .from(assistantVersions)
          .where(and(eq(assistantVersions.id, v.version_id), eq(assistantVersions.assistantId, input.assistantId)))
          .limit(1);
        if (version.length === 0 || version[0].status !== 'PUBLISHED') {
          throw ApiError.validation({ versions: `version ${v.version_id} must be a PUBLISHED version of this assistant` });
        }
      }
      // Pause any current active rollout first (the partial unique index
      // admits exactly one active row per assistant).
      await tx
        .update(assistantRollouts)
        .set({ state: 'paused', updatedAt: new Date().toISOString() })
        .where(and(eq(assistantRollouts.assistantId, input.assistantId), eq(assistantRollouts.state, 'active')));
      const inserted = await tx
        .insert(assistantRollouts)
        .values({
          organizationId: input.orgId,
          assistantId: input.assistantId,
          state: 'active',
          versions: variants,
          createdBy: input.actor.slice(0, 128),
        })
        .returning();
      return inserted[0];
    });
    await this.audit.add({
      action: 'assistant.rollout_set',
      resourceType: 'assistant_rollout',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId, variants: variants.map((v) => `${v.version_id}:${v.weight}`).join(',') },
    });
    return row;
  }

  async pause(input: { orgId: string; assistantId: string; actor: string }): Promise<{ paused: boolean }> {
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(assistantRollouts)
        .set({ state: 'paused', updatedAt: new Date().toISOString() })
        .where(and(eq(assistantRollouts.assistantId, input.assistantId), eq(assistantRollouts.organizationId, input.orgId), eq(assistantRollouts.state, 'active')))
        .returning({ id: assistantRollouts.id }),
    );
    if (rows.length > 0) {
      await this.audit.add({
        action: 'assistant.rollout_paused',
        resourceType: 'assistant_rollout',
        resourceId: rows[0].id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { assistant_id: input.assistantId },
      });
    }
    return { paused: rows.length > 0 };
  }

  async get(orgId: string, assistantId: string): Promise<AssistantRollout | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistantRollouts)
        .where(and(eq(assistantRollouts.organizationId, orgId), eq(assistantRollouts.assistantId, assistantId)))
        .orderBy(desc(assistantRollouts.createdAt))
        .limit(1),
    );
    return rows[0] ?? null;
  }
}
