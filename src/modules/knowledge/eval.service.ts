import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { assistantVersions } from '../assistants/schema';
import { RetrievalService } from './retrieval.service';

/**
 * Eval harness (FL-2.21) — Engine is the system of record for datasets,
 * cases and run results; the Studio eval-worker executes runs against the
 * pinned assistant version (tau2-style state verification + LLM-as-judge
 * rubrics, pass^k methodology) and writes results back through the API.
 */

export const evalCaseSchema = z.object({
  input: z.object({ text: z.string().min(1).max(8192) }).strict(),
  expected: z
    .object({
      contains: z.array(z.string().max(256)).max(20).optional(),
      not_contains: z.array(z.string().max(256)).max(20).optional(),
      state_assertions: z.array(z.string().max(128)).max(20).optional(),
      /** FL-3.8 — expected document ids for retrieval recall@k evaluation. */
      document_ids: z.array(z.string().uuid()).max(20).optional(),
    })
    .strict(),
  rubric: z
    .object({
      instructions: z.string().min(1).max(2048),
      min_score: z.number().min(0).max(1).default(0.7),
    })
    .strict()
    .optional(),
});

export const evalResultsSchema = z.object({
  cases: z
    .array(
      z.object({
        case_id: z.string().min(1).max(64),
        attempt: z.number().int().min(1),
        passed: z.boolean(),
        score: z.number().min(0).max(1),
        failure_reason: z.string().max(512).optional(),
        response_excerpt: z.string().max(512).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

@Injectable()
export class EvalService {
  private static readonly logger = new Logger(EvalService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly retrieval: RetrievalService,
  ) {}

  async createDataset(input: { orgId: string; name: string; description?: string; actor: string }): Promise<unknown> {
    assertUuid(input.orgId, 'orgId');
    const id = uuidv7();
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(evalDatasets)
        .values({
          id,
          organizationId: input.orgId,
          name: input.name.trim().slice(0, 128),
          description: input.description?.slice(0, 2048) ?? null,
          createdBy: input.actor,
        })
        .onConflictDoNothing()
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('dataset name already exists', { name: input.name });
      }
      await this.audit.add({
        action: 'eval.dataset_created',
        resourceType: 'eval_dataset',
        resourceId: id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: {},
      });
      return rows[0];
    });
  }

  async addCases(input: { orgId: string; datasetId: string; cases: unknown[]; actor: string }): Promise<{ added: number }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    const parsed = input.cases.map((c) => evalCaseSchema.parse(c));
    return this.db.withOrg(input.orgId, async (tx) => {
      const next = await tx.execute(sql`
        select coalesce(max(sequence), 0) + 1 as next from eval_cases where dataset_id = ${input.datasetId}::uuid
      `);
      let sequence = Number((next.rows[0] as { next: number | string }).next);
      for (const c of parsed) {
        await tx.insert(evalCases).values({
          id: uuidv7(),
          organizationId: input.orgId,
          datasetId: input.datasetId,
          input: c.input,
          expected: c.expected,
          rubric: c.rubric ?? null,
          sequence: sequence++,
        });
      }
      return { added: parsed.length };
    });
  }

  async listDatasets(orgId: string): Promise<unknown[]> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) => tx.select().from(evalDatasets).orderBy(desc(evalDatasets.createdAt)).limit(100));
  }

  /**
   * Start an eval run: pins the assistant version, stores the case snapshot
   * count and emits `eval.run_requested` on the outbox (invariant 7) — the
   * Studio eval-worker consumes execution through its own transport.
   */
  async startRun(input: { orgId: string; datasetId: string; assistantVersionId: string; attemptsPerCase: number; actor: string }): Promise<unknown> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    assertUuid(input.assistantVersionId, 'assistantVersionId');
    const attempts = Math.min(Math.max(1, input.attemptsPerCase), 5);
    const id = uuidv7();
    return this.db.withOrg(input.orgId, async (tx) => {
      const version = await tx
        .select({ id: assistantVersions.id, status: assistantVersions.status })
        .from(assistantVersions)
        .where(and(eq(assistantVersions.id, input.assistantVersionId), eq(assistantVersions.organizationId, input.orgId)))
        .limit(1);
      if (version.length === 0 || version[0].status !== 'PUBLISHED') {
        throw ApiError.validation({ assistant_version_id: 'must be a PUBLISHED version of this org' });
      }
      const rows = await tx
        .insert(evalRuns)
        .values({
          id,
          organizationId: input.orgId,
          datasetId: input.datasetId,
          assistantVersionId: input.assistantVersionId,
          state: 'pending',
          attemptsPerCase: attempts,
          startedBy: input.actor,
        })
        .returning();
      await recordOutboxEvent(tx, {
        aggregateType: 'eval_run',
        aggregateId: id,
        organizationId: input.orgId,
        eventType: 'eval.run_requested',
        partitionKey: input.datasetId,
        payload: { eval_run_id: id, dataset_id: input.datasetId, assistant_version_id: input.assistantVersionId, attempts_per_case: attempts },
      });
      return rows[0];
    });
  }

  async listRuns(orgId: string, datasetId?: string): Promise<unknown[]> {
    assertUuid(orgId, 'orgId');
    return this.db.withOrg(orgId, (tx) => {
      const base = tx.select().from(evalRuns);
      const q = datasetId
        ? base.where(and(eq(evalRuns.organizationId, orgId), eq(evalRuns.datasetId, datasetId)))
        : base.where(eq(evalRuns.organizationId, orgId));
      return q.orderBy(desc(evalRuns.startedAt)).limit(100);
    });
  }

  /** Results write-back (Studio eval-worker → Engine). Idempotent per run id. */
  async completeRun(input: { orgId: string; evalRunId: string; results: unknown; actor: string }): Promise<unknown> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.evalRunId, 'evalRunId');
    const parsed = evalResultsSchema.parse(input.results);
    const total = parsed.cases.length;
    const passed = parsed.cases.filter((c) => c.passed).length;
    const score = total === 0 ? 0 : passed / total;
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(evalRuns)
        .set({ state: 'completed', results: parsed, score: score.toFixed(4), finishedAt: new Date().toISOString() })
        .where(and(eq(evalRuns.organizationId, input.orgId), eq(evalRuns.id, input.evalRunId), sql`state in ('pending','running')`))
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('eval run is not in an open state');
      }
      return rows[0];
    });
  }

  /**
   * FL-3.8 — retrieval recall@k. Runs the LIVE hybrid retrieval per case
   * (same ACL-before-scoring path as production) and scores
   * |retrieved ∩ expected| / |expected| against the case's
   * `expected.document_ids`. Cases without document_ids are skipped. The
   * aggregate is `mean recall@k` over scored cases — the dashboard metric.
   * Computed on demand (no materialization): retrieval is read-only and the
   * dataset sizes here are bounded (≤100 cases per dataset page).
   */
  async evaluateRetrieval(input: { orgId: string; datasetId: string; k: number; actor: string }): Promise<{
    k: number;
    scored_cases: number;
    mean_recall: number;
    cases: Array<{ case_id: string; recall: number | null; retrieved_document_ids: string[] }>;
  }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    const k = Math.min(Math.max(1, input.k), 20);
    const cases = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(evalCases).where(and(eq(evalCases.organizationId, input.orgId), eq(evalCases.datasetId, input.datasetId))).orderBy(asc(evalCases.sequence)).limit(100),
    );
    const scored: Array<{ case_id: string; recall: number | null; retrieved_document_ids: string[] }> = [];
    for (const c of cases) {
      const expected = (c.expected ?? {}) as { document_ids?: unknown };
      const expectedIds = Array.isArray(expected.document_ids) ? expected.document_ids.map(String) : [];
      const text = ((c.input ?? {}) as { text?: unknown }).text;
      if (expectedIds.length === 0 || typeof text !== 'string') {
        scored.push({ case_id: c.id, recall: null, retrieved_document_ids: [] });
        continue;
      }
      const hits = await this.retrieval.searchKnowledge({ orgId: input.orgId, query: text, limit: k });
      const retrieved = [...new Set(hits.map((h) => h.documentId))];
      const found = expectedIds.filter((id) => retrieved.includes(id)).length;
      scored.push({ case_id: c.id, recall: found / expectedIds.length, retrieved_document_ids: retrieved.slice(0, 20) });
    }
    const withRecall = scored.filter((s) => s.recall !== null) as Array<{ case_id: string; recall: number; retrieved_document_ids: string[] }>;
    const mean = withRecall.length === 0 ? 0 : withRecall.reduce((acc, s) => acc + s.recall, 0) / withRecall.length;
    await this.audit.add({
      action: 'eval.retrieval_evaluated',
      resourceType: 'eval_dataset',
      resourceId: input.datasetId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { k, scored_cases: withRecall.length, mean_recall: Number(mean.toFixed(4)) },
    });
    return { k, scored_cases: withRecall.length, mean_recall: Number(mean.toFixed(4)), cases: scored };
  }
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

// table imports (bottom to avoid partial-init ordering issues in editor views)
import { evalCases, evalDatasets, evalRuns } from './eval.schema';
