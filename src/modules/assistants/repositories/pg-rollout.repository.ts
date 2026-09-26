import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { ApiError } from '../../../common/http/api-error';
import { assistantRollouts, assistantVersions, assistantInstalls } from '../schema';
import type { AssistantRollout, RolloutVariant } from '../schema';
import { templatePlatformBlocks } from '../template-blocks.schema';
import { evalRuns } from '../../knowledge/eval.schema';
import { ControlBlocksService } from '../control-blocks.service';
import type { IRolloutRepository } from './rollout.repository';

/**
 * PostgreSQL implementation of `IRolloutRepository` (P3).
 *
 * Mechanical move of the `RolloutsService` persistence units (promote / pause
 * / get release pointers). `promoteRelease` owns the ONE wide withOrg
 * transaction — assistants exists-check, template platform-block provenance,
 * per-variant PUBLISHED check + version kill gate + eval BLOCK gate, pause of
 * the current active pointer at the (environment, channel) address, and the
 * insert of the new active row. NOTHING leaves this unit: the service only
 * ever sees the returned row.
 *
 * The version kill gate calls the (unchanged) `ControlBlocksService`
 * static with the caller's drizzle tx, exactly as the service did.
 *
 * What stays OUT (still the caller's job): input validation (`assertUuid`,
 * environment/channel shape, variant weights summing — the caller
 * pre-normalizes), tracing spans, audit writes (replayed by the service from
 * inputs + results), burn-rate auto-rollback decisions (the burn-rate worker
 * pauses via `pauseRelease`).
 */
export class PgRolloutRepository implements IRolloutRepository {
  /** The primary release address: omitted environment/channel default here. */
  private static readonly PRIMARY_ENVIRONMENT = 'production';
  private static readonly PRIMARY_CHANNEL = 'default';

  constructor(private readonly db: DbService) {}

  async promoteRelease(input: {
    orgId: string;
    assistantId: string;
    environment: string;
    channel: string;
    variants: RolloutVariant[];
    actor: string;
  }): Promise<AssistantRollout> {
    const { orgId, assistantId, environment, channel, variants, actor } = input;
    try {
      return await this.db.withOrg(orgId, async (tx) => {
        const exists = await tx.execute(sql`select 1 from assistants where id = ${assistantId}::uuid and organization_id = ${orgId}::uuid limit 1`);
        if (exists.rows.length === 0) {
          throw ApiError.notFound('assistant');
        }
        // REL-6.1 — platform kill, second effect point: a release pointer may
        // not be (re)assigned for an assistant installed from a platform-
        // blocked slug. The install record carries the slug provenance.
        const install = await tx
          .select({ slug: assistantInstalls.slug })
          .from(assistantInstalls)
          .where(eq(assistantInstalls.assistantId, assistantId))
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
            .where(and(eq(assistantVersions.id, v.version_id), eq(assistantVersions.assistantId, assistantId)))
            .limit(1);
          if (version.length === 0 || version[0].status !== 'PUBLISHED') {
            throw ApiError.validation({ versions: `version ${v.version_id} must be a PUBLISHED version of this assistant` });
          }
          // Version-level kill (TPL-6.3): a blocked version cannot be assigned
          // to any pointer. In-flight runs stay pinned (never touched here).
          const blocked = await ControlBlocksService.findActiveBlock(tx, orgId, 'version', v.version_id);
          if (blocked) {
            throw ApiError.conflict(`version ${v.version_id} is blocked (${blocked.reason}) — clear the block to assign it`, {
              version_id: v.version_id,
            });
          }
          // Eval gate (TPL-8.3 + A2-80): a version whose latest completed
          // evaluation decided BLOCK or FAIL cannot be promoted to any pointer.
          // A FAIL means the version's own cases failed — promoting it would
          // serve disproven content.
          const runs = await tx
            .select({ decision: evalRuns.decision })
            .from(evalRuns)
            .where(and(eq(evalRuns.organizationId, orgId), eq(evalRuns.assistantVersionId, v.version_id), eq(evalRuns.state, 'completed')))
            .orderBy(desc(evalRuns.finishedAt))
            .limit(1);
          if (runs.length > 0 && (runs[0].decision === 'BLOCK' || runs[0].decision === 'FAIL')) {
            throw ApiError.conflict(`version ${v.version_id} decided ${runs[0].decision} in its latest evaluation — resolve and re-evaluate before promoting`, {
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
              eq(assistantRollouts.assistantId, assistantId),
              eq(assistantRollouts.environment, environment),
              eq(assistantRollouts.channel, channel),
              eq(assistantRollouts.state, 'active'),
            ),
          );
        const inserted = await tx
          .insert(assistantRollouts)
          .values({
            organizationId: orgId,
            assistantId,
            environment,
            channel,
            state: 'active',
            versions: variants,
            createdBy: actor.slice(0, 128),
          })
          .returning();
        return inserted[0];
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Concurrent promotion at the same address: the partial unique index
      // admits one active row — the loser retries against fresh state.
      if (typeof err === 'object' && err !== null && pgViolation(err).code === '23505') {
        throw ApiError.conflict('concurrent release update at this address — reload and retry', { environment, channel });
      }
      throw err;
    }
  }

  async pauseRelease(input: {
    orgId: string;
    assistantId: string;
    environment?: string;
    channel?: string;
    reason: string;
    pausedBy: string;
  }): Promise<{ paused: boolean; rolloutId?: string }> {
    const environment = input.environment ?? PgRolloutRepository.PRIMARY_ENVIRONMENT;
    const channel = input.channel ?? PgRolloutRepository.PRIMARY_CHANNEL;
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(assistantRollouts)
        .set({
          state: 'paused',
          pausedReason: input.reason,
          pausedBy: input.pausedBy.slice(0, 128),
          pausedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(assistantRollouts.assistantId, input.assistantId),
            eq(assistantRollouts.organizationId, input.orgId),
            eq(assistantRollouts.environment, environment),
            eq(assistantRollouts.channel, channel),
            eq(assistantRollouts.state, 'active'),
          ),
        )
        .returning({ id: assistantRollouts.id }),
    );
    if (rows.length === 0) {
      return { paused: false };
    }
    return { paused: true, rolloutId: rows[0].id };
  }

  async getRelease(
    orgId: string,
    assistantId: string,
    environment?: string,
    channel?: string,
  ): Promise<AssistantRollout | null> {
    const address = {
      environment: environment ?? PgRolloutRepository.PRIMARY_ENVIRONMENT,
      channel: channel ?? PgRolloutRepository.PRIMARY_CHANNEL,
    };
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
