import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import {
  assistants,
  assistantVersions,
  assistantInstalls,
  assistantTemplates,
  policySnapshots,
} from '../assistants/schema';
import { toolCatalog } from '../assistants/tool-catalog.schema';
import { BUILT_IN_TOOLS } from '../assistants/tool-catalog.service';
import { validateAssistantPayload } from '../assistants/validation';
import { ConfigPublishService } from '../config-publish/config-publish.service';
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
  /**
   * TPL-7.3/7.4 — enriched worker report (all optional, additive: legacy
   * workers posting bare cases keep working, with decisions degrading
   * honestly — missing required checks BLOCK, missing threshold metrics WARN).
   */
  checks: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        passed: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
  /** Critical-failure names that occurred (matched against the release policy list). */
  critical_failures: z.array(z.string().min(1).max(128)).max(32).optional(),
  evaluators: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(32),
      }),
    )
    .max(32)
    .optional(),
  model: z
    .object({
      provider: z.string().min(1).max(64),
      model: z.string().min(1).max(128),
    })
    .optional(),
  /** Threshold metrics; absent metrics degrade their threshold to WARN (never invented). */
  metrics: z
    .object({
      task_success: z.number().min(0).max(1).optional(),
      groundedness: z.number().min(0).max(1).optional(),
      policy_compliance: z.number().min(0).max(1).optional(),
    })
    .optional(),
  compiler_version: z.string().min(1).max(32).optional(),
  seed: z.number().int().optional(),
  /** Free-form worker half of the provenance (runner version, harness details). */
  worker_provenance: z.record(z.string(), z.unknown()).optional(),
});

/**
 * R-2 (team_setup_ledger.md §3) — evaluable version statuses. DRAFT content
 * evaluates pre-publish (EVALUATE → PUBLISH): the entry point synthesizes the
 * execution snapshot first and the run plane requires it, so this gate only
 * decides which rows may START a run — RETIRED (and anything unknown) never
 * executes. Pure so the matrix is unit-testable without a database.
 */
export function isEvaluableVersionStatus(status: unknown): boolean {
  return status === 'DRAFT' || status === 'PUBLISHED';
}

@Injectable()
export class EvalService {
  private static readonly logger = new Logger(EvalService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly retrieval: RetrievalService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  async createDataset(input: {
    orgId: string;
    name: string;
    description?: string;
    actor: string;
  }): Promise<unknown> {
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

  async addCases(input: {
    orgId: string;
    datasetId: string;
    cases: unknown[];
    actor: string;
  }): Promise<{ added: number }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    // Live-verification fix (team_setup_ledger.md F6): schema violations
    // must refuse as typed 422s with paths — a ZodError escaping here
    // surfaced as an opaque 500 with no fix guidance.
    const parsed: Array<z.infer<typeof evalCaseSchema>> = [];
    for (let index = 0; index < input.cases.length; index += 1) {
      const result = evalCaseSchema.safeParse(input.cases[index]);
      if (!result.success) {
        throw ApiError.validation({ [`cases[${index}]`]: result.error.flatten() });
      }
      parsed.push(result.data);
    }
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
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(evalDatasets).orderBy(desc(evalDatasets.createdAt)).limit(100),
    );
  }

  /**
   * TPL-8.2 — human-gated failure promotion. Failing production traces become
   * *candidate* eval cases FIRST (curators write them into a candidate
   * dataset named `template:<slug>@<version>:candidates` — same tables, never
   * auto-ingested, so prompt injection cannot write the test suite). A
   * curator then promotes (copy into the real dataset) or rejects (delete):
   *
   *  - promote = copy with the next sequence + audit; the candidate row is
   *    deleted after the copy (its lifecycle ends; the audit preserves it);
   *  - only candidate datasets promote (name must start with `template:`
   *    and end with `:candidates`), only into the sibling dataset with the
   *    suffix stripped. Reviewer/approver roles own this surface.
   */
  async promoteCandidateCase(input: {
    orgId: string;
    datasetId: string;
    caseId: string;
    actor: string;
  }): Promise<{ promoted_case_id: string }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    assertUuid(input.caseId, 'caseId');
    return this.db.withOrg(input.orgId, async (tx) => {
      const source = await tx
        .select()
        .from(evalDatasets)
        .where(
          and(eq(evalDatasets.id, input.datasetId), eq(evalDatasets.organizationId, input.orgId)),
        )
        .limit(1);
      const sourceDataset = source[0];
      if (!sourceDataset) {
        throw ApiError.notFound('eval dataset');
      }
      const targetName = targetDatasetName(sourceDataset.name);
      if (!targetName) {
        throw ApiError.validation({
          dataset_id: 'only candidate datasets (template:<slug>@<version>:candidates) promote',
        });
      }
      const target = await tx
        .select()
        .from(evalDatasets)
        .where(and(eq(evalDatasets.organizationId, input.orgId), eq(evalDatasets.name, targetName)))
        .limit(1);
      if (target.length === 0) {
        throw ApiError.conflict('candidate target dataset does not exist', { target: targetName });
      }
      const cases = await tx
        .select()
        .from(evalCases)
        .where(
          and(
            eq(evalCases.id, input.caseId),
            eq(evalCases.datasetId, input.datasetId),
            eq(evalCases.organizationId, input.orgId),
          ),
        )
        .limit(1);
      const candidate = cases[0];
      if (!candidate) {
        throw ApiError.notFound('eval case');
      }
      const next = await tx.execute(sql`
        select coalesce(max(sequence), 0) + 1 as next from eval_cases where dataset_id = ${target[0].id}::uuid
      `);
      const sequence = Number((next.rows[0] as { next: number | string }).next);
      const promotedId = uuidv7();
      await tx.insert(evalCases).values({
        id: promotedId,
        organizationId: input.orgId,
        datasetId: target[0].id,
        input: candidate.input,
        expected: candidate.expected,
        rubric: candidate.rubric,
        sequence,
      });
      await tx.delete(evalCases).where(eq(evalCases.id, input.caseId));
      await this.audit.add({
        action: 'eval.case_promoted',
        resourceType: 'eval_dataset',
        resourceId: target[0].id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: {
          from_dataset: sourceDataset.name,
          candidate_case_id: input.caseId,
          promoted_case_id: promotedId,
        },
      });
      return { promoted_case_id: promotedId };
    });
  }

  /** TPL-8.2 — reject a candidate case (audited delete; the trace stays in run_judgments). */
  async rejectCandidateCase(input: {
    orgId: string;
    datasetId: string;
    caseId: string;
    actor: string;
  }): Promise<{ ok: true }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    assertUuid(input.caseId, 'caseId');
    return this.db.withOrg(input.orgId, async (tx) => {
      const source = await tx
        .select()
        .from(evalDatasets)
        .where(
          and(eq(evalDatasets.id, input.datasetId), eq(evalDatasets.organizationId, input.orgId)),
        )
        .limit(1);
      if (source.length === 0) {
        throw ApiError.notFound('eval dataset');
      }
      if (!targetDatasetName(source[0].name)) {
        throw ApiError.validation({
          dataset_id: 'only candidate datasets (template:<slug>@<version>:candidates) reject',
        });
      }
      const deleted = await tx
        .delete(evalCases)
        .where(
          and(
            eq(evalCases.id, input.caseId),
            eq(evalCases.datasetId, input.datasetId),
            eq(evalCases.organizationId, input.orgId),
          ),
        )
        .returning({ id: evalCases.id });
      if (deleted.length === 0) {
        throw ApiError.notFound('eval case');
      }
      await this.audit.add({
        action: 'eval.case_rejected',
        resourceType: 'eval_dataset',
        resourceId: input.datasetId,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { candidate_case_id: input.caseId },
      });
      return { ok: true };
    });
  }

  /**
   * Start an eval run: pins the assistant version, stores the case snapshot
   * count and emits `eval.run_requested` on the outbox (invariant 7) — the
   * Studio eval-worker consumes execution through its own transport.
   */
  async startRun(input: {
    orgId: string;
    datasetId: string;
    assistantVersionId: string;
    attemptsPerCase: number;
    actor: string;
    environment?: string;
    /**
     * P5 (drift shadow evals): TRUE marks observation-only rows. Shadow runs
     * never gate releases and never satisfy required-checks (enforced at
     * read time in release-gate.ts + provenance). Formal callers omit it.
     */
    shadow?: boolean;
  }): Promise<unknown> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    assertUuid(input.assistantVersionId, 'assistantVersionId');
    const attempts = Math.min(Math.max(1, input.attemptsPerCase), 5);
    const id = uuidv7();
    return this.db.withOrg(input.orgId, async (tx) => {
      const version = await tx
        .select({ id: assistantVersions.id, status: assistantVersions.status })
        .from(assistantVersions)
        .where(
          and(
            eq(assistantVersions.id, input.assistantVersionId),
            eq(assistantVersions.organizationId, input.orgId),
          ),
        )
        .limit(1);
      // R-2 (team_setup_ledger.md §3) — DRAFT content evaluates pre-publish
      // (EVALUATE → PUBLISH): the version-scoped entry point synthesizes the
      // execution snapshot first, and the executor pins the version with a
      // snapshot-required join — so drafts without a snapshot still cannot
      // run. Anything else (e.g. RETIRED) refuses: only live content executes.
      if (version.length === 0 || !isEvaluableVersionStatus(version[0].status)) {
        throw ApiError.validation({
          assistant_version_id: 'must be a DRAFT or PUBLISHED version of this org',
        });
      }
      // Fail-closed dataset scope: a version may only run against its own
      // org's dataset (previously unchecked — cross-org dataset reference
      // would leak case content into another org's eval trail).
      const dataset = await tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(
          and(eq(evalDatasets.id, input.datasetId), eq(evalDatasets.organizationId, input.orgId)),
        )
        .limit(1);
      if (dataset.length === 0) {
        throw ApiError.notFound('eval dataset');
      }
      // W2.4 (drizzle/0070) — authoritative content pin: resolve the
      // version's CURRENT snapshot in the same transaction that creates the
      // run, so the eval is forever bound to the content that was live at
      // start time. The executor dispatches every case against this pinned
      // row (acceptMessage pinSnapshotId); an edit landing mid-dispatch
      // inserts a NEW snapshot row and cannot change what the eval runs
      // against. Fail closed when the version has no snapshot (drafts
      // without one cannot run — the executor's snapshot-required join
      // would refuse every case anyway).
      const snapRows = await tx
        .select({ id: policySnapshots.id })
        .from(policySnapshots)
        .innerJoin(
          assistantVersions,
          and(
            eq(assistantVersions.id, policySnapshots.assistantVersionId),
            eq(policySnapshots.hash, assistantVersions.hash),
          ),
        )
        .where(eq(policySnapshots.assistantVersionId, input.assistantVersionId))
        .limit(1);
      if (snapRows.length === 0) {
        throw ApiError.conflict('assistant version has no policy snapshot');
      }
      const policySnapshotId = snapRows[0].id;
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
          isShadow: input.shadow === true,
          policySnapshotId,
        })
        .returning();
      await recordOutboxEvent(tx, {
        aggregateType: 'eval_run',
        aggregateId: id,
        organizationId: input.orgId,
        eventType: 'eval.run_requested',
        partitionKey: input.datasetId,
        payload: {
          eval_run_id: id,
          dataset_id: input.datasetId,
          assistant_version_id: input.assistantVersionId,
          attempts_per_case: attempts,
          // W2.4 — the authoritative content pin travels with the dispatch
          // request so the executor never re-resolves "current" content.
          policy_snapshot_id: policySnapshotId,
          ...(input.environment ? { environment: input.environment } : {}),
          // P5: the executor ignores unknown keys — shadow rides along so
          // downstream scoring can distinguish observation from gating.
          ...(input.shadow === true ? { shadow: true } : {}),
        },
      });
      return rows[0];
    });
  }

  /**
   * P5 (drift shadow evals) — compare the ACTIVE version's pinned model refs
   * against the LIVE org catalog. Pure comparison over rows the caller reads;
   * the hash shape mirrors ManifestResolutionService.resolveModelRef exactly
   * (canonicalHash over the whole catalog entry object) — drift means the
   * entry object changed, byte-identically to how the pin was computed.
   * Rules:
   * - live entry missing → entry_removed (the model vanished from governance);
   * - live disabled while the pin wasn't → entry_disabled;
   * - entry object hash differs → entry_changed (config/regions/payload moved);
   * - pin had NO entry (null) and live has one → catalog growth, NOT drift.
   * Returns the active version id (for the shadow run pin) plus drift list.
   * Empty drift = nothing to do (caller skips silently — steady state).
   */
  async detectModelDrift(
    orgId: string,
    assistantId: string,
  ): Promise<{ versionId: string | null; drifted: Array<{ alias: string; reason: string }> }> {
    assertUuid(orgId, 'orgId');
    const assistantRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: assistants.id, activeVersionId: assistants.activeVersionId })
        .from(assistants)
        .where(eq(assistants.id, assistantId))
        .limit(1),
    );
    // Tenant-scoped read (withOrg RLS): a foreign-org id yields no row.
    const assistant = assistantRows[0];
    if (!assistant) {
      throw ApiError.notFound('assistant');
    }
    if (!assistant.activeVersionId) {
      return { versionId: null, drifted: [] };
    }
    const snapRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ modelRef: policySnapshots.modelRef })
        .from(policySnapshots)
        .innerJoin(
          assistantVersions,
          and(
            eq(assistantVersions.id, policySnapshots.assistantVersionId),
            eq(policySnapshots.hash, assistantVersions.hash),
          ),
        )
        .where(eq(policySnapshots.assistantVersionId, assistant.activeVersionId as string))
        .limit(1),
    );
    const models =
      ((snapRows[0]?.modelRef ?? {}) as { models?: Array<Record<string, unknown>> }).models ?? [];
    if (!Array.isArray(models) || models.length === 0) {
      return { versionId: assistant.activeVersionId, drifted: [] };
    }
    let liveEntries: Array<Record<string, unknown>> | null = null;
    try {
      const latest = await this.configPublish.latest(orgId, 'model_catalog', null);
      const payload = (latest?.payload ?? null) as {
        models?: Array<Record<string, unknown>>;
      } | null;
      liveEntries = Array.isArray(payload?.models)
        ? (payload.models as Array<Record<string, unknown>>)
        : null;
    } catch {
      liveEntries = null;
    }
    if (!liveEntries) {
      // No live catalog to compare against (never published / surface down)
      // — unknown, not drift. Fail OPEN to silence, never to false alerts.
      return { versionId: assistant.activeVersionId, drifted: [] };
    }
    const drifted: Array<{ alias: string; reason: string }> = [];
    for (const ref of models) {
      const provider = typeof ref.provider === 'string' ? ref.provider : '';
      const model = typeof ref.model === 'string' ? ref.model : '';
      const alias = `${provider}/${model}`;
      const live =
        liveEntries.find((m) => `${String(m.provider)}/${String(m.model)}` === alias) ?? null;
      if (!live) {
        drifted.push({ alias, reason: 'entry_removed' });
        continue;
      }
      if (live.enabled === false && ref.catalog_enabled !== false) {
        drifted.push({ alias, reason: 'entry_disabled' });
        continue;
      }
      if (ref.entry_hash != null && canonicalHash(live) !== ref.entry_hash) {
        drifted.push({ alias, reason: 'entry_changed' });
      }
    }
    return { versionId: assistant.activeVersionId, drifted };
  }

  /**
   * P5 — start a drift-observation run, deduped to one shadow eval per
   * version per 24h (drift doesn't change hourly; evals cost provider money).
   * Discriminated result (never throws for the expected two non-starts):
   * - started: the shadow run (observation only);
   * - deduped: a shadow from the last 24h already covers it;
   * - no_dataset: drift is real but nothing exists to measure it against
   *   (caller alerts WITHOUT an eval — still worth knowing).
   */
  async startShadowEval(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    drifted: Array<{ alias: string }>;
  }): Promise<{ status: 'started' | 'deduped' | 'no_dataset'; run?: unknown }> {
    assertUuid(input.orgId, 'orgId');
    const recent = await this.db.withOrg(input.orgId, (tx) =>
      tx.execute(
        sql`select 1 from eval_runs where organization_id = ${input.orgId}::uuid and assistant_version_id = ${input.versionId}::uuid and is_shadow = true and started_at > now() - interval '24 hours' limit 1`,
      ),
    );
    if (recent.rows.length > 0) {
      return { status: 'deduped' };
    }
    const datasetId = await this.resolveTemplateDataset(input.orgId, input.assistantId);
    if (!datasetId) {
      return { status: 'no_dataset' };
    }
    const run = await this.startRun({
      orgId: input.orgId,
      datasetId,
      assistantVersionId: input.versionId,
      attemptsPerCase: 1,
      actor: 'system:model-drift',
      shadow: true,
    });
    return { status: 'started', run };
  }

  /** Template-seeded dataset id (`template:<slug>@<version>`), if installed. */
  private async resolveTemplateDataset(orgId: string, assistantId: string): Promise<string | null> {
    const name = await this.db.withOrg(orgId, async (tx) => {
      const installs = await tx
        .select()
        .from(assistantInstalls)
        .where(eq(assistantInstalls.assistantId, assistantId))
        .limit(1);
      const install = installs[0];
      if (!install || install.organizationId !== orgId) {
        return null;
      }
      return `template:${install.slug}@${install.templateVersion}`;
    });
    if (!name) {
      return null;
    }
    const datasets = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.organizationId, orgId), eq(evalDatasets.name, name)))
        .limit(1),
    );
    return datasets[0]?.id ?? null;
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
  async completeRun(input: {
    orgId: string;
    evalRunId: string;
    results: unknown;
    actor: string;
  }): Promise<unknown> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.evalRunId, 'evalRunId');
    const parsed = evalResultsSchema.parse(input.results);
    const total = parsed.cases.length;
    const passed = parsed.cases.filter((c) => c.passed).length;
    const score = total === 0 ? 0 : passed / total;
    return this.db.withOrg(input.orgId, async (tx) => {
      const runRows = await tx
        .select()
        .from(evalRuns)
        .where(and(eq(evalRuns.organizationId, input.orgId), eq(evalRuns.id, input.evalRunId)))
        .limit(1);
      const run = runRows[0];
      if (!run) {
        throw ApiError.notFound('eval run');
      }
      if (run.state !== 'pending' && run.state !== 'running') {
        throw ApiError.conflict('eval run is not in an open state');
      }
      const versionRows = await tx
        .select()
        .from(assistantVersions)
        .where(eq(assistantVersions.id, run.assistantVersionId))
        .limit(1);
      const version = versionRows[0];
      if (!version) {
        throw ApiError.conflict('eval run references a missing assistant version');
      }
      const datasetRows = await tx
        .select()
        .from(evalDatasets)
        .where(eq(evalDatasets.id, run.datasetId))
        .limit(1);
      const dataset = datasetRows[0] ?? null;

      // Template linkage: seeded datasets are named template:<slug>@<version>.
      const template = await this.resolveTemplatePolicy(tx, input.orgId, version.assistantId);
      const policy = (template?.releasePolicy ?? null) as {
        release_policy_version?: unknown;
        required?: unknown;
        thresholds?: unknown;
        critical_failures?: unknown;
        regression_no_worse_than?: unknown;
      } | null;
      const requiredChecks = Array.isArray(policy?.required) ? (policy?.required as unknown[]) : [];
      const thresholds = (policy?.thresholds ?? {}) as {
        task_success?: number;
        groundedness?: number;
        policy_compliance?: number;
      };
      const criticalList = Array.isArray(policy?.critical_failures)
        ? (policy?.critical_failures as string[])
        : [];

      // ── Engine-verifiable required checks (never delegated to the worker) ──
      const engineChecks = new Map<string, boolean>();
      engineChecks.set(
        'schema_valid',
        validateAssistantPayload({
          model_policy: version.modelPolicy,
          context_policy: version.contextPolicy,
          tool_policy: version.toolPolicy,
          knowledge_policy: version.knowledgePolicy ?? undefined,
          guardrail_policy: version.guardrailPolicy,
          instructions: version.instructions ?? undefined,
          model_params: version.modelParams ?? undefined,
          budget_policy: version.budgetPolicy ?? undefined,
        }).ok,
      );
      engineChecks.set(
        'tool_authorization_pass',
        await this.verifyToolPinsLive(tx, input.orgId, version.toolPolicy),
      );
      const workerChecks = new Map((parsed.checks ?? []).map((c) => [c.name, c.passed]));

      // ── Decision (TPL-7.3/7.4 + §4.4 model) ──
      const blockReasons: string[] = [];
      const warnings: string[] = [];
      // 1. Critical failures: worker-reported occurrence ∩ policy list.
      const occurred = new Set(parsed.critical_failures ?? []);
      for (const critical of criticalList) {
        if (occurred.has(critical)) {
          blockReasons.push(`critical failure: ${critical}`);
        }
      }
      // 2. Required checks: engine verdict wins for engine-verifiable names,
      //    worker verdict otherwise. A required check nobody evaluated BLOCKS
      //    (fail-closed: unverified safety is not safety).
      for (const required of requiredChecks) {
        if (typeof required === 'object' && required !== null) {
          continue; // handled as regression below
        }
        if (typeof required !== 'string') {
          continue;
        }
        if (engineChecks.has(required)) {
          if (!engineChecks.get(required)) {
            blockReasons.push(`required check failed: ${required}`);
          }
          continue;
        }
        if (!workerChecks.has(required)) {
          blockReasons.push(`required check unevaluated: ${required}`);
          continue;
        }
        if (!workerChecks.get(required)) {
          blockReasons.push(`required check failed: ${required}`);
        }
      }
      // 3. Regression (TPL-7.5): previous PUBLISHED version's latest completed
      //    run on the SAME dataset. Breach of the required bound BLOCKs.
      const regressionBound =
        typeof policy?.regression_no_worse_than === 'number'
          ? policy.regression_no_worse_than
          : (
              requiredChecks.find(
                (r) =>
                  typeof r === 'object' &&
                  r !== null &&
                  'regression_no_worse_than' in (r as Record<string, unknown>),
              ) as { regression_no_worse_than?: unknown } | undefined
            )?.regression_no_worse_than;
      if (typeof regressionBound === 'number') {
        // TPL-7.5: the candidate is compared against the release it would
        // succeed. A DRAFT carries the version-0 sentinel, so a bound of
        // `previous_version < evaluated_version` would be unsatisfiable and
        // regression could never fire pre-publish; instead a draft is
        // compared against the currently-published version (what is live).
        // A post-publish eval keeps the original bound: the release this
        // version succeeded.
        const [currentPublished] = await tx
          .select({ version: assistantVersions.version })
          .from(assistantVersions)
          .where(
            and(
              eq(assistantVersions.assistantId, version.assistantId),
              eq(assistantVersions.status, 'PUBLISHED'),
            ),
          )
          .orderBy(desc(assistantVersions.version))
          .limit(1);
        const previous = currentPublished
          ? await tx
              .select({ id: assistantVersions.id })
              .from(assistantVersions)
              .where(
                and(
                  eq(assistantVersions.assistantId, version.assistantId),
                  eq(assistantVersions.status, 'PUBLISHED'),
                  version.version === 0
                    ? sql`${assistantVersions.version} <= ${currentPublished.version}`
                    : sql`${assistantVersions.version} < ${version.version}`,
                ),
              )
              .orderBy(desc(assistantVersions.version))
              .limit(1)
          : [];
        if (previous.length > 0) {
          const prevRuns = await tx
            .select({ score: evalRuns.score })
            .from(evalRuns)
            .where(
              and(
                eq(evalRuns.organizationId, input.orgId),
                eq(evalRuns.assistantVersionId, previous[0].id),
                eq(evalRuns.datasetId, run.datasetId),
                eq(evalRuns.state, 'completed'),
              ),
            )
            .orderBy(desc(evalRuns.finishedAt))
            .limit(1);
          if (prevRuns.length > 0 && prevRuns[0].score !== null) {
            const delta = Number(prevRuns[0].score) - score;
            if (delta > regressionBound) {
              blockReasons.push(
                `regression ${delta.toFixed(4)} exceeds bound ${regressionBound} (previous score ${prevRuns[0].score})`,
              );
            }
          }
        }
      }
      // 3b. Content pin (drizzle/0070): the run pinned its snapshot ONCE at
      //    startRun (eval_runs.policy_snapshot_id). The decision is
      //    attributed to the pin — VERIFIED against what the dispatched
      //    executions actually ran, never derived from executions alone and
      //    never the version row's live hash at completion time (updateDraft
      //    rewrites it in place — the in-flight edit race):
      //    - pin set, executions ran, distinct execution hashes == pin hash
      //      → the honest pin: what the eval actually executed;
      //    - pin set, executions ran against anything else (mixed content
      //      from a pre-pin dispatch, or a different row) → no single
      //      evaluated content exists → BLOCK fail-closed. Defense in
      //      depth: the pinned executor makes this unreachable for runs
      //      dispatched by the current code;
      //    - pin set, NO executions (Studio write-back / legacy direct
      //      completion): the engine did not observe the execution, so it
      //      cannot attest the content. Claiming the pin's hash would assert
      //      the Studio ran the pinned content — unwitnessed. The pin stays
      //      NULL → the publish gate fails closed (re-evaluate);
      //    - pin NULL (pre-0070 rows): unattestable → NULL, same fail-closed.
      let pinHash: string | null = null;
      if (run.policySnapshotId) {
        const pinRows = await tx
          .select({ hash: policySnapshots.hash })
          .from(policySnapshots)
          .where(eq(policySnapshots.id, run.policySnapshotId))
          .limit(1);
        pinHash = pinRows[0]?.hash ?? null;
      }
      const executedHashes = await tx.execute<{ hash: string }>(sql`
        select distinct ps.hash as hash
        from eval_case_executions ece
        join runs r on r.id = ece.run_id
        join policy_snapshots ps on ps.id = r.policy_snapshot_id
        where ece.organization_id = ${input.orgId}::uuid
          and ece.eval_run_id = ${input.evalRunId}::uuid
      `);
      const distinctHashes = [...new Set(executedHashes.rows.map((r) => r.hash))];
      let evaluatedContentHash: string | null = null;
      if (pinHash !== null && distinctHashes.length === 1 && distinctHashes[0] === pinHash) {
        evaluatedContentHash = pinHash;
      } else if (pinHash !== null && distinctHashes.length > 0) {
        blockReasons.push(
          `mixed content: executions ran against ${distinctHashes.length} distinct content hash(es) (${distinctHashes.map((h) => h.slice(0, 12)).join(', ')}) but the run pinned ${pinHash.slice(0, 12)} — no single evaluated content; re-run the eval`,
        );
      }
      // pinHash null, or no dispatched executions: evaluatedContentHash
      // stays null — the engine attests only what it pinned AND observed.
      // 4. Thresholds: task_success defaults to the aggregate score BY
      //    DEFINITION (mean case score); groundedness/policy_compliance with
      //    no worker metric are recorded unevaluated → WARN, never invented.
      const metrics = parsed.metrics ?? {};
      const evaluatedMetrics: Record<string, number | null> = {
        task_success: metrics.task_success ?? score,
        groundedness: metrics.groundedness ?? null,
        policy_compliance: metrics.policy_compliance ?? null,
      };
      for (const [name, bar] of Object.entries(thresholds)) {
        const value = evaluatedMetrics[name];
        if (value === null || value === undefined) {
          warnings.push(`threshold ${name} unevaluated (no worker metric)`);
        } else if (value < (bar as number)) {
          warnings.push(`threshold ${name} ${value} below bar ${bar}`);
        }
      }
      // A2-80: the verdict MUST reflect case outcomes — a run that failed
      // cases is FAIL, never PASS. PASS means "shippable"; a green PASS on a
      // 0.0000 run is the exact lie the console rendered (score 0.0000 +
      // "Failing cases · 1" beside a PASS pill). Precedence is
      // BLOCK > FAIL > WARN > PASS: safety-critical BLOCK outranks a quality
      // FAIL; FAIL outranks an advisory WARN.
      const failedCases = total - passed;
      const decision =
        blockReasons.length > 0 ? 'BLOCK' : failedCases > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';

      // ── Provenance (TPL-7.4 — everything a replayer needs, no scalars alone) ──
      const provenance = await this.assembleProvenance(tx, input.orgId, {
        run,
        version,
        dataset,
        template,
        parsed,
        score,
        evaluatedMetrics,
        evaluatedContentHash,
        blockReasons,
        warnings,
      });

      const rows = await tx
        .update(evalRuns)
        .set({
          state: 'completed',
          results: parsed,
          score: score.toFixed(4),
          provenance,
          decision,
          releasePolicyVersion:
            typeof template?.releasePolicyVersion === 'number'
              ? template.releasePolicyVersion
              : null,
          finishedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(evalRuns.organizationId, input.orgId),
            eq(evalRuns.id, input.evalRunId),
            sql`state in ('pending','running')`,
          ),
        )
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('eval run is not in an open state');
      }
      await this.audit.add({
        action: template ? 'template.version_evaluated' : 'eval.run_completed',
        resourceType: 'assistant_version',
        resourceId: version.id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: {
          eval_run_id: input.evalRunId,
          decision,
          score: Number(score.toFixed(4)),
          failed_cases: failedCases,
          ...(template ? { template_slug: template.slug, template_version: template.version } : {}),
          block_reasons: blockReasons,
          warnings,
        },
      });
      return rows[0];
    });
  }

  /** Template linkage for a version: installs row → registry row + release policy. */
  private async resolveTemplatePolicy(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
  ): Promise<{
    slug: string;
    version: string;
    definitionHash: string | null;
    releasePolicy: unknown;
    releasePolicyVersion: number | null;
  } | null> {
    const installs = await tx
      .select()
      .from(assistantInstalls)
      .where(eq(assistantInstalls.assistantId, assistantId))
      .limit(1);
    const install = installs[0];
    if (!install || install.organizationId !== orgId) {
      return null;
    }
    const templates = await tx
      .select()
      .from(assistantTemplates)
      .where(
        and(
          eq(assistantTemplates.slug, install.slug),
          eq(assistantTemplates.version, install.templateVersion),
        ),
      )
      .limit(1);
    const template = templates[0];
    if (!template) {
      return {
        slug: install.slug,
        version: install.templateVersion,
        definitionHash: null,
        releasePolicy: null,
        releasePolicyVersion: null,
      };
    }
    const policy = (template.releasePolicy ?? {}) as { release_policy_version?: unknown };
    return {
      slug: template.slug,
      version: template.version,
      definitionHash: template.hash,
      releasePolicy: template.releasePolicy,
      releasePolicyVersion:
        typeof policy.release_policy_version === 'number' ? policy.release_policy_version : null,
    };
  }

  /** Engine-side tool pin verification (never delegated): every non-built-in
   *  version entry resolves to an ENABLED catalog row with matching hash. */
  private async verifyToolPinsLive(
    tx: NodePgDatabase,
    orgId: string,
    toolPolicy: unknown,
  ): Promise<boolean> {
    const tools =
      (toolPolicy as { tools?: Array<{ name?: string; schema_hash?: string }> } | null)?.tools ??
      [];
    const names = tools
      .map((t) => t?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0 && !BUILT_IN_TOOLS.has(n));
    if (names.length === 0) {
      return true;
    }
    const rows = await tx
      .select({ name: toolCatalog.name, hash: toolCatalog.hash, enabled: toolCatalog.enabled })
      .from(toolCatalog)
      .where(eq(toolCatalog.organizationId, orgId));
    const byName = new Map(rows.map((r) => [r.name, r]));
    return names.every((name) => {
      const row = byName.get(name);
      if (!row || !row.enabled) {
        return false;
      }
      const entry = tools.find((t) => t?.name === name);
      return entry?.schema_hash === undefined || entry.schema_hash === row.hash;
    });
  }

  /** Dataset content hash at run time — the reproducibility anchor. */
  private async hashDatasetCases(
    tx: NodePgDatabase,
    orgId: string,
    datasetId: string,
  ): Promise<string> {
    const cases = await tx
      .select({
        input: evalCases.input,
        expected: evalCases.expected,
        rubric: evalCases.rubric,
        sequence: evalCases.sequence,
      })
      .from(evalCases)
      .where(and(eq(evalCases.organizationId, orgId), eq(evalCases.datasetId, datasetId)))
      .orderBy(asc(evalCases.sequence));
    return canonicalHash(cases);
  }

  private async assembleProvenance(
    tx: NodePgDatabase,
    orgId: string,
    input: {
      run: { id: string; datasetId: string; attemptsPerCase: number };
      version: { id: string; assistantId: string };
      dataset: { id: string; name: string } | null;
      template: { slug: string; version: string; definitionHash: string | null } | null;
      parsed: {
        evaluators?: Array<{ name: string; version: string }>;
        model?: { provider: string; model: string };
        compiler_version?: string;
        seed?: number;
        worker_provenance?: Record<string, unknown>;
      };
      score: number;
      evaluatedMetrics: Record<string, number | null>;
      /**
       * W2.4 (drizzle/0070) — the authoritative content pin from completeRun
       * §3b: the snapshot hash the run pinned at startRun AND whose
       * execution was observed, or null when unattestable. Null is NEVER
       * backfilled from the version's current snapshot: the current hash is
       * mutable (updateDraft rewrites it in place), so falling back to it
       * would reintroduce the completion-time misattribution 0069/0070
       * exist to kill. Null pins fail closed at the publish gate
       * (re-evaluate).
       */
      evaluatedContentHash: string | null;
      blockReasons: string[];
      warnings: string[];
    },
  ): Promise<Record<string, unknown>> {
    const catalogRows = await tx
      .select({
        name: toolCatalog.name,
        version: toolCatalog.version,
        hash: toolCatalog.hash,
        enabled: toolCatalog.enabled,
      })
      .from(toolCatalog)
      .where(eq(toolCatalog.organizationId, orgId));
    // The honest pin: the snapshot row matching the content the run pinned
    // at startRun and the executions actually ran against
    // (content-addressed, immutable). Null when unattestable — no fallback
    // to the version's mutable current snapshot, ever.
    const snapshotRows = input.evaluatedContentHash
      ? await tx
          .select()
          .from(policySnapshots)
          .where(
            and(
              eq(policySnapshots.assistantVersionId, input.version.id),
              eq(policySnapshots.hash, input.evaluatedContentHash),
            ),
          )
          .limit(1)
      : [];
    const snapshot = snapshotRows[0] ?? null;
    let modelCatalogMatch: Record<string, unknown> | null = null;
    if (input.parsed.model) {
      try {
        const latest = await this.configPublish.latest(orgId, 'model_catalog', null);
        const models =
          (
            (latest?.payload ?? null) as {
              models?: Array<{ provider: string; model: string; enabled: boolean }>;
            } | null
          )?.models ?? [];
        const entry =
          models.find(
            (m) =>
              m.provider === input.parsed.model?.provider && m.model === input.parsed.model?.model,
          ) ?? null;
        modelCatalogMatch = {
          claimed: input.parsed.model,
          catalog_config_present: latest !== null && latest !== undefined,
          entry_hash: entry ? canonicalHash(entry) : null,
          catalog_enabled: entry?.enabled ?? null,
        };
      } catch {
        modelCatalogMatch = {
          claimed: input.parsed.model,
          catalog_config_present: false,
          entry_hash: null,
          catalog_enabled: null,
        };
      }
    }
    return {
      template: input.template
        ? {
            slug: input.template.slug,
            version: input.template.version,
            definition_hash: input.template.definitionHash,
          }
        : null,
      dataset: input.dataset
        ? {
            id: input.dataset.id,
            name: input.dataset.name,
            content_hash: await this.hashDatasetCases(tx, orgId, input.dataset.id),
          }
        : null,
      evaluators: input.parsed.evaluators ?? null,
      model: modelCatalogMatch,
      tool_catalog_hash: canonicalHash(catalogRows.filter((r) => r.enabled)),
      knowledge_pins: (snapshot?.knowledgePins ?? null) as unknown,
      guardrail_ref: snapshot?.hash ?? null,
      // The content hash the eval was PINNED to at startRun and OBSERVED
      // executing (completeRun §3b). Never the version row's live hash at
      // completion time (updateDraft rewrites it in place — the in-flight
      // edit race). The publish gate matches on this pin. Null when the
      // engine cannot attest the executed content (pre-0070 runs, Studio
      // write-backs, mixed-content BLOCKs) — null pins fail closed at the
      // gate (re-evaluate).
      evaluated_content_hash: snapshot?.hash ?? null,
      compiler_version: input.parsed.compiler_version ?? null,
      environment: null,
      seed: input.parsed.seed ?? null,
      attempts_per_case: input.run.attemptsPerCase,
      worker_provenance: input.parsed.worker_provenance ?? null,
      evaluated_metrics: input.evaluatedMetrics,
      block_reasons: input.blockReasons,
      warnings: input.warnings,
    };
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
  async evaluateRetrieval(input: {
    orgId: string;
    datasetId: string;
    k: number;
    actor: string;
  }): Promise<{
    k: number;
    scored_cases: number;
    mean_recall: number;
    cases: Array<{ case_id: string; recall: number | null; retrieved_document_ids: string[] }>;
  }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.datasetId, 'datasetId');
    const k = Math.min(Math.max(1, input.k), 20);
    const cases = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select()
        .from(evalCases)
        .where(
          and(eq(evalCases.organizationId, input.orgId), eq(evalCases.datasetId, input.datasetId)),
        )
        .orderBy(asc(evalCases.sequence))
        .limit(100),
    );
    const scored: Array<{
      case_id: string;
      recall: number | null;
      retrieved_document_ids: string[];
    }> = [];
    for (const c of cases) {
      const expected = (c.expected ?? {}) as { document_ids?: unknown };
      const expectedIds = Array.isArray(expected.document_ids)
        ? expected.document_ids.map(String)
        : [];
      const text = ((c.input ?? {}) as { text?: unknown }).text;
      if (expectedIds.length === 0 || typeof text !== 'string') {
        scored.push({ case_id: c.id, recall: null, retrieved_document_ids: [] });
        continue;
      }
      const hits = await this.retrieval.searchKnowledge({
        orgId: input.orgId,
        query: text,
        limit: k,
      });
      const retrieved = [...new Set(hits.map((h) => h.documentId))];
      const found = expectedIds.filter((id) => retrieved.includes(id)).length;
      scored.push({
        case_id: c.id,
        recall: found / expectedIds.length,
        retrieved_document_ids: retrieved.slice(0, 20),
      });
    }
    const withRecall = scored.filter((s) => s.recall !== null) as Array<{
      case_id: string;
      recall: number;
      retrieved_document_ids: string[];
    }>;
    const mean =
      withRecall.length === 0
        ? 0
        : withRecall.reduce((acc, s) => acc + s.recall, 0) / withRecall.length;
    await this.audit.add({
      action: 'eval.retrieval_evaluated',
      resourceType: 'eval_dataset',
      resourceId: input.datasetId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { k, scored_cases: withRecall.length, mean_recall: Number(mean.toFixed(4)) },
    });
    return {
      k,
      scored_cases: withRecall.length,
      mean_recall: Number(mean.toFixed(4)),
      cases: scored,
    };
  }
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/**
 * TPL-8.2 — candidate dataset convention. `template:<slug>@<version>:candidates`
 * holds curator-written candidates; stripping the suffix yields the dataset
 * they promote into. Anything else returns null (not a candidate dataset).
 */
function targetDatasetName(name: string): string | null {
  if (!name.startsWith('template:') || !name.endsWith(':candidates')) {
    return null;
  }
  const target = name.slice(0, -':candidates'.length);
  return target.length > 'template:'.length ? target : null;
}

// table imports (bottom to avoid partial-init ordering issues in editor views)
import { evalCases, evalDatasets, evalRuns } from './eval.schema';
