import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { assistantRollouts, assistantVersions, AssistantRollout, RolloutVariant } from './schema';
import { assistantInstalls } from './schema';
import { templatePlatformBlocks } from './template-blocks.schema';
import { isNull } from 'drizzle-orm';
import { evalRuns } from '../knowledge/eval.schema';
import { ControlBlocksService } from './control-blocks.service';

/**
 * FL-3.12 + TPL-6.2 — A/B / canary rollout management + release pointers.
 * The rollout lives BESIDE the atomic publish pointer:
 * `assistants.active_version_id` stays the default; an active rollout splits
 * traffic across PUBLISHED versions by weight. Selection is sticky per
 * conversation (conversations.service); this service owns the CRUD +
 * invariants:
 *   - every variant version belongs to the assistant and is PUBLISHED,
 *   - weights are positive integers summing to exactly 100,
 *   - at most ONE active rollout per (assistant, environment, channel),
 *   - versions under an active version-block cannot be assigned,
 *   - versions whose latest completed eval decision is BLOCK cannot be
 *     pointed at (TPL-8.3 — the publish-TX hash gate covers the same content
 *     smuggled through rollback, so the two gates compose).
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
    return this.setRelease({ ...input, environment: 'production', channel: 'default' });
  }

  /**
   * TPL-6.2 — move the release pointer for one (environment, channel)
   * address. Promotion is a pointer move, never a rebuild; rollback is a
   * repoint (history preserved) or restore-as-new-version (rollback_of
   * lineage) — both append-only.
   */
  async setRelease(input: {
    orgId: string;
    assistantId: string;
    environment?: string;
    channel?: string;
    versions: unknown;
    actor: string;
  }): Promise<AssistantRollout> {
    const environment = input.environment ?? 'production';
    const channel = input.channel ?? 'default';
    assertAddress(environment, channel);
    const variants = RolloutsService.parseVariants(input.versions);
    let row: AssistantRollout;
    try {
      row = await this.db.withOrg(input.orgId, async (tx) => {
      const exists = await tx.execute(sql`select 1 from assistants where id = ${input.assistantId}::uuid and organization_id = ${input.orgId}::uuid limit 1`);
      if (exists.rows.length === 0) {
        throw ApiError.notFound('assistant');
      }
      // REL-6.1 — platform kill, second effect point: a release pointer may
      // not be (re)assigned for an assistant installed from a platform-
      // blocked slug. The install record carries the slug provenance.
      const install = await tx
        .select({ slug: assistantInstalls.slug })
        .from(assistantInstalls)
        .where(eq(assistantInstalls.assistantId, input.assistantId))
        .limit(1);
      if (install.length > 0) {
        const block = await tx
          .select({ id: templatePlatformBlocks.id, reason: templatePlatformBlocks.reason })
          .from(templatePlatformBlocks)
          .where(and(eq(templatePlatformBlocks.slug, install[0].slug), isNull(templatePlatformBlocks.liftedAt)))
          .limit(1);
        if (block.length > 0) {
          throw ApiError.forbidden(`template ${install[0].slug} is platform-blocked (${block[0].reason}) — new release pointers refuse`, { slug: install[0].slug });
        }
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
        // Version-level kill (TPL-6.3): a blocked version cannot be assigned
        // to any pointer. In-flight runs stay pinned (never touched here).
        const blocked = await ControlBlocksService.findActiveBlock(tx, input.orgId, 'version', v.version_id);
        if (blocked) {
          throw ApiError.conflict(`version ${v.version_id} is blocked (${blocked.reason}) — clear the block to assign it`, {
            version_id: v.version_id,
          });
        }
        // Eval gate (TPL-8.3): a version whose latest completed evaluation
        // decided BLOCK cannot be promoted to any pointer.
        const runs = await tx
          .select({ decision: evalRuns.decision })
          .from(evalRuns)
          .where(and(eq(evalRuns.organizationId, input.orgId), eq(evalRuns.assistantVersionId, v.version_id), eq(evalRuns.state, 'completed')))
          .orderBy(desc(evalRuns.finishedAt))
          .limit(1);
        if (runs.length > 0 && runs[0].decision === 'BLOCK') {
          throw ApiError.conflict(`version ${v.version_id} is BLOCKed by evaluation — resolve and re-evaluate before promoting`, {
            version_id: v.version_id,
          });
        }
      }
      // Pause the current active pointer AT THIS ADDRESS ONLY (a staging
      // move must never pause production).
      await tx
        .update(assistantRollouts)
        .set({ state: 'paused', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(assistantRollouts.assistantId, input.assistantId),
            eq(assistantRollouts.environment, environment),
            eq(assistantRollouts.channel, channel),
            eq(assistantRollouts.state, 'active'),
          ),
        );
      const inserted = await tx
        .insert(assistantRollouts)
        .values({
          organizationId: input.orgId,
          assistantId: input.assistantId,
          environment,
          channel,
          state: 'active',
          versions: variants,
          createdBy: input.actor.slice(0, 128),
        })
        .returning();
      return inserted[0];
    });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Concurrent promotion at the same address: the partial unique index
      // admits one active row — the loser retries against fresh state.
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        throw ApiError.conflict('concurrent release update at this address — reload and retry', { environment, channel });
      }
      throw err;
    }
    await this.audit.add({
      action: 'release.promoted',
      resourceType: 'assistant_rollout',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {
        assistant_id: input.assistantId,
        environment,
        channel,
        variants: variants.map((v) => `${v.version_id}:${v.weight}`).join(','),
      },
    });
    return row;
  }

  async pause(input: { orgId: string; assistantId: string; environment?: string; channel?: string; actor: string }): Promise<{ paused: boolean }> {
    const clauses = [eq(assistantRollouts.assistantId, input.assistantId), eq(assistantRollouts.organizationId, input.orgId), eq(assistantRollouts.state, 'active')];
    if (input.environment !== undefined) {
      assertAddress(input.environment, input.channel ?? 'default');
      clauses.push(eq(assistantRollouts.environment, input.environment));
    }
    if (input.channel !== undefined) {
      assertAddress(input.environment ?? 'production', input.channel);
      clauses.push(eq(assistantRollouts.channel, input.channel));
    }
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(assistantRollouts)
        .set({ state: 'paused', updatedAt: new Date().toISOString() })
        .where(and(...clauses))
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

  /**
   * The current release pointer. Addressless reads mean the DEFAULT address
   * (production/default) — "the" release of an assistant is its production
   * pointer, never "the newest row of any address" (a staging/canary move
   * must not leak into reads that did not ask for it).
   */
  async get(orgId: string, assistantId: string, environment?: string, channel?: string): Promise<AssistantRollout | null> {
    const address = { environment: environment ?? 'production', channel: channel ?? 'default' };
    assertAddress(address.environment, address.channel);
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistantRollouts)
        .where(
          and(
            eq(assistantRollouts.organizationId, orgId),
            eq(assistantRollouts.assistantId, assistantId),
            eq(assistantRollouts.environment, address.environment),
            eq(assistantRollouts.channel, address.channel),
          ),
        )
        .orderBy(desc(assistantRollouts.createdAt))
        .limit(1),
    );
    return rows[0] ?? null;
  }
}

function assertAddress(environment: string, channel: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(environment)) {
    throw ApiError.validation({ environment: 'must be 1..32 chars of [a-z0-9_-], starting alnum' });
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(channel)) {
    throw ApiError.validation({ channel: 'must be 1..32 chars of [a-z0-9_-], starting alnum' });
  }
}
