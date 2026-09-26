import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import { policySnapshots } from '../../assistants/schema';
import { runs } from '../../conversations/schema';
import { evalCases, evalCaseExecutions, evalRuns } from '../eval.schema';
import type {
  EvalCaseContent,
  EvalRunCompletion,
  EvalRunRow,
  NewEvalRun,
  OutboxEventDraft,
} from './repository-types';
import type { IEvalRunRepository } from './eval-run.repository';

/**
 * PostgreSQL implementation of `IEvalRunRepository` (P3).
 *
 * Mechanical move of the eval-run lifecycle SQL from `EvalService`. Each
 * method owns its transaction; no transaction handle leaks.
 *
 * `listExecutedContentHashes` preserves the DELIBERATE cross-module join
 * (`eval_case_executions ⨝ runs ⨝ policy_snapshots`) documented on the
 * interface: `runs` is conversations-owned, but `eval.schema.ts` already
 * imports the assistants tables (precedent), and splitting this read
 * across two ports would scatter the hash-verification query the publish
 * gate depends on.
 *
 * INTERFACE DEFECTS (reported 2026-09-26, not silently altered):
 * - The current `completeRun` performs its decision reads (version,
 *   dataset, template policy, regression lookup, pin verification) and the
 *   terminal CAS in ONE transaction. The ports split reads from the CAS;
 *   the service must re-read before `completeIfOpen`, accepting the
 *   read/CAS split.
 *
 * What stays OUT (still the service's job): dispatching the run to
 * Studio's eval-worker (the outbox consumer), scoring and the publish-gate
 * decision (pre-computed into `EvalRunCompletion`), the version/dataset/
 * snapshot validation reads before `createWithOutboxEvent`, audit writes.
 */
export class PgEvalRunRepository implements IEvalRunRepository {
  constructor(private readonly db: DbService) {}

  async createWithOutboxEvent(
    orgId: string,
    run: NewEvalRun,
    event: OutboxEventDraft,
  ): Promise<EvalRunRow> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .insert(evalRuns)
        .values({ ...run, organizationId: orgId })
        .returning();
      // Invariant 7: the outbox row is written in the SAME transaction as
      // the fact it announces. The writer is common infra; this port only
      // guarantees the co-commit.
      await recordOutboxEvent(tx, {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        organizationId: orgId,
        eventType: event.eventType,
        eventVersion: event.eventVersion ?? 1,
        payload: (event.payload ?? undefined) as Record<string, unknown> | undefined,
        partitionKey: event.partitionKey,
        traceId: event.traceId ?? undefined,
        correlationId: event.correlationId ?? undefined,
      });
      const inserted = rows[0];
      if (!inserted) {
        throw new Error('eval run insert returned no row');
      }
      return inserted;
    });
  }

  async findById(orgId: string, runId: string): Promise<EvalRunRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(evalRuns)
        .where(and(eq(evalRuns.organizationId, orgId), eq(evalRuns.id, runId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async list(orgId: string, opts: { datasetId?: string; limit: number }): Promise<EvalRunRow[]> {
    return this.db.withOrg(orgId, (tx) => {
      const base = tx.select().from(evalRuns);
      const q = opts.datasetId
        ? base.where(and(eq(evalRuns.organizationId, orgId), eq(evalRuns.datasetId, opts.datasetId)))
        : base.where(eq(evalRuns.organizationId, orgId));
      return q.orderBy(desc(evalRuns.startedAt)).limit(opts.limit);
    });
  }

  async hasRecentShadowRun(orgId: string, versionId: string, withinHours: number): Promise<boolean> {
    return this.db.withOrg(orgId, async (tx) => {
      const recent = await tx.execute(
        sql`select 1 from eval_runs where organization_id = ${orgId}::uuid and assistant_version_id = ${versionId}::uuid and is_shadow = true and started_at > now() - (${withinHours} * interval '1 hour') limit 1`,
      );
      return recent.rows.length > 0;
    });
  }

  async listExecutedContentHashes(orgId: string, evalRunId: string): Promise<string[]> {
    return this.db.withOrg(orgId, async (tx) => {
      // DELIBERATE cross-module join (documented on the interface):
      // eval_case_executions ⨝ runs ⨝ policy_snapshots.
      const executedHashes = await tx.execute<{ hash: string }>(sql`
        select distinct ps.hash as hash
        from eval_case_executions ece
        join runs r on r.id = ece.run_id
        join policy_snapshots ps on ps.id = r.policy_snapshot_id
        where ece.organization_id = ${orgId}::uuid
          and ece.eval_run_id = ${evalRunId}::uuid
      `);
      return [...new Set(executedHashes.rows.map((r) => String(r.hash)))];
    });
  }

  async completeIfOpen(
    orgId: string,
    runId: string,
    completion: EvalRunCompletion,
  ): Promise<EvalRunRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      // Compare-and-set terminal completion: the WHERE fence makes a
      // duplicate delivery return null (not an error) when the run is
      // already completed/failed.
      //
      // TPL-7.4: provenance IS written — EvalRunCompletion carries the
      // assembled provenance blob and the publish gate reads it.
      const rows = await tx
        .update(evalRuns)
        .set({
          state: completion.state,
          results: completion.results,
          score: completion.score,
          provenance: completion.provenance ?? null,
          decision: completion.decision,
          releasePolicyVersion: completion.releasePolicyVersion,
          finishedAt: completion.finishedAt.toISOString(),
        })
        .where(
          and(
            eq(evalRuns.organizationId, orgId),
            eq(evalRuns.id, runId),
            sql`state in ('pending','running')`,
          ),
        )
        .returning();
      return rows[0] ?? null;
    });
  }

  async listCasesForHash(orgId: string, datasetId: string): Promise<EvalCaseContent[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          id: evalCases.id,
          input: evalCases.input,
          expected: evalCases.expected,
          rubric: evalCases.rubric,
        })
        .from(evalCases)
        .where(and(eq(evalCases.organizationId, orgId), eq(evalCases.datasetId, datasetId)))
        .orderBy(asc(evalCases.sequence)),
    );
  }

  async countRunsForDataset(orgId: string, datasetId: string): Promise<number> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as total from eval_runs
        where organization_id = ${orgId}::uuid and dataset_id = ${datasetId}::uuid
      `);
      return Number((rows.rows[0] as { total: number }).total);
    });
  }

  async latestCompletedRunScore(
    orgId: string,
    assistantVersionId: string,
    datasetId: string,
  ): Promise<string | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ score: evalRuns.score })
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.organizationId, orgId),
            eq(evalRuns.assistantVersionId, assistantVersionId),
            eq(evalRuns.datasetId, datasetId),
            eq(evalRuns.state, 'completed'),
          ),
        )
        .orderBy(desc(evalRuns.finishedAt))
        .limit(1);
      return rows[0]?.score ?? null;
    });
  }
}
