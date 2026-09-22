import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * Regression coverage for the Wave 2 eval-gate fixes that the 2026-09-22
 * live proof exercised (the stale-hash publish bypass is covered by
 * publish-gate.test.ts).
 *
 * Each test FAILS on the pre-fix code:
 * 1. analytics-rollup recomputeOutcomes: the INSERT listed 6 target columns
 *    but SELECTed 5 expressions (missing id) → the consumer threw and the
 *    run.completed event dead-lettered before eval scoring.
 * 2. completeRun schema_valid: a NULL knowledge_policy row (absent policy)
 *    was passed as null to validateAssistantPayload and failed validation,
 *    BLOCKing every eval of an assistant without a knowledge policy.
 * 3. eval-scoring scoreResponse: the raw `select content ...` read JSONB
 *    through the driver's OID-3802 string parser, so `.text` was read off a
 *    string and every case scored 0.
 * 4. completeRun regression: the baseline bound `previous_version < 0`
 *    (draft sentinel) was unsatisfiable, so a draft could never regress
 *    against the published release it would succeed.
 * 5. ensureVersionSnapshot: editing a draft after the snapshot was taken left
 *    the snapshot stale (early return on row existence), so a re-eval would
 *    execute the OLD content while the gate attributes the decision to the
 *    new hash.
 * 6. in-flight edit race (drizzle/0070): startRun pins the snapshot ONCE
 *    (eval_runs.policy_snapshot_id, carried on eval.run_requested); the
 *    executor dispatches every case against the pinned row, so a mid-eval
 *    edit cannot change what the eval runs against. completeRun attests the
 *    pin (verified against dispatched executions), never the version row's
 *    live hash.
 * 7. mixed-content execution: executions split across a pre-pin edit BLOCK
 *    fail-closed with a NULL content pin (no single evaluated content).
 * 8. unattested completion (Studio write-back / legacy direct completion):
 *    the provenance pin is NULL instead of falling back to the version's
 *    mutable current snapshot — the publish gate fails it closed.
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  if (!TEST_DATABASE_URL) return false;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const describeIfDb = (await pgReachable()) ? describe : describe.skip;

/** Valid payload; knowledge_policy deliberately absent → NULL in the row. */
const PAYLOAD = {
  instructions: 'You are an eval-gate regression probe. Be concise.',
  modelPolicy: { allowed_models: ['neryva-core-1'] },
  contextPolicy: { history_limit: 20 },
  toolPolicy: { tools: [{ name: 'search_knowledge', access: 'read' }] }, // built-in → tool pins pass trivially
  guardrailPolicy: { input_policy: 'default', output_policy: 'brand-safe' },
};

describeIfDb('eval-gate fixes (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let evals: import('../../src/modules/knowledge/eval.service').EvalService;
  let assistantsSvc: import('../../src/modules/assistants/assistants.service').AssistantsService;
  const orgId = randomUUID();
  const actor = 'eval-gate-fixes';
  const slug = `egf-${randomUUID().slice(0, 8)}`;
  const assistantIds: string[] = [];
  const datasetIds: string[] = [];

  async function plantAssistant(name: string): Promise<string> {
    const { assistants } = await import('../../src/modules/assistants/schema');
    const assistantId = randomUUID();
    await db.withBypass((tx) =>
      tx.insert(assistants).values({ id: assistantId, organizationId: orgId, name }),
    );
    assistantIds.push(assistantId);
    return assistantId;
  }

  async function plantVersion(input: {
    assistantId: string;
    version: number;
    status: string;
    hash: string;
  }): Promise<string> {
    const { assistantVersions } = await import('../../src/modules/assistants/schema');
    const versionId = randomUUID();
    // knowledgePolicy omitted → NULL (the nullable-column case).
    await db.withBypass((tx) =>
      tx.insert(assistantVersions).values({
        id: versionId,
        assistantId: input.assistantId,
        organizationId: orgId,
        version: input.version,
        status: input.status,
        hash: input.hash,
        ...PAYLOAD,
      }),
    );
    return versionId;
  }

  async function plantDataset(): Promise<string> {
    const { evalDatasets } = await import('../../src/modules/knowledge/eval.schema');
    const datasetId = randomUUID();
    await db.withBypass((tx) =>
      tx.insert(evalDatasets).values({ id: datasetId, organizationId: orgId, name: `egf-${datasetId.slice(0, 8)}`, createdBy: actor }),
    );
    datasetIds.push(datasetId);
    return datasetId;
  }

  async function plantCase(datasetId: string): Promise<string> {
    const { evalCases } = await import('../../src/modules/knowledge/eval.schema');
    const caseId = randomUUID();
    await db.withBypass((tx) =>
      tx.insert(evalCases).values({
        id: caseId,
        organizationId: orgId,
        datasetId,
        input: { text: 'probe' },
        expected: {},
        sequence: 1,
      }),
    );
    return caseId;
  }

  /**
   * A dispatched eval execution: the executor's acceptMessage pinned a
   * snapshot row by id at dispatch time (runs.policy_snapshot_id), so the
   * execution is forever tied to that row's immutable content.
   */
  async function plantDispatchedExecution(input: {
    evalRunId: string;
    assistantId: string;
    versionId: string;
    snapshotId: string;
    datasetId: string;
  }): Promise<void> {
    const { conversations, messages, runs } = await import('../../src/modules/conversations/schema');
    const { evalCaseExecutions } = await import('../../src/modules/knowledge/eval.schema');
    const caseId = await plantCase(input.datasetId);
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.insert(conversations).values({ id: conversationId, organizationId: orgId, assistantId: input.assistantId });
      await tx.insert(messages).values({
        id: messageId,
        conversationId,
        organizationId: orgId,
        sequence: 1,
        role: 'user',
        content: { text: 'probe' },
      });
      await tx.insert(runs).values({
        id: runId,
        organizationId: orgId,
        conversationId,
        inputMessageId: messageId,
        assistantVersionId: input.versionId,
        policySnapshotId: input.snapshotId,
        state: 'COMPLETED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      await tx.insert(evalCaseExecutions).values({
        id: randomUUID(),
        organizationId: orgId,
        evalRunId: input.evalRunId,
        caseId,
        attempt: 1,
        conversationId,
        runId,
        state: 'passed',
        score: '1.0000',
      });
    });
  }

  async function snapshotIdFor(versionId: string, hash: string): Promise<string> {
    const { policySnapshots } = await import('../../src/modules/assistants/schema');
    const rows = await db.withBypass((tx) =>
      tx
        .select({ id: policySnapshots.id })
        .from(policySnapshots)
        .where(and(eq(policySnapshots.assistantVersionId, versionId), eq(policySnapshots.hash, hash)))
        .limit(1),
    );
    if (rows.length === 0) throw new Error(`no snapshot row for version ${versionId} hash ${hash.slice(0, 12)}`);
    return rows[0].id;
  }

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { buildAssistantsService, stubConfigPublish } = await import('../helpers/db');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { EvalService } = await import('../../src/modules/knowledge/eval.service');
    const { assistantTemplates } = await import('../../src/modules/assistants/schema');
    db = new DbService();
    assistantsSvc = await buildAssistantsService(db);
    evals = new EvalService(
      db,
      new AuditService(db),
      undefined as never,
      stubConfigPublish() as never,
    );
    await db.withBypass((tx) =>
      tx.insert(assistantTemplates).values({
        slug,
        version: '1.0.0',
        status: 'stable',
        family: 'egf',
        definition: {},
        releasePolicy: { required: ['schema_valid', { regression_no_worse_than: 0.05 }] },
        hash: 'e'.repeat(64),
        minEngineSchema: 1,
      }),
    );
  });

  afterAll(async () => {
    const { assistants, assistantVersions, assistantInstalls, assistantTemplates, policySnapshots } =
      await import('../../src/modules/assistants/schema');
    const { conversations, messages, runs } = await import('../../src/modules/conversations/schema');
    const { analyticsRollups } = await import('../../src/modules/analytics/schema').catch(() => ({} as Record<string, never>));
    await db.withBypass(async (tx) => {
      await tx.execute(sql`delete from eval_runs where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from eval_case_executions where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from eval_cases where organization_id = ${orgId}::uuid`);
      for (const datasetId of datasetIds) {
        await tx.execute(sql`delete from eval_datasets where id = ${datasetId}::uuid`);
      }
      if (analyticsRollups && (analyticsRollups as Record<string, unknown>).id !== undefined) {
        await tx.execute(sql`delete from analytics_rollups where organization_id = ${orgId}::uuid`);
      }
      for (const assistantId of assistantIds) {
        await tx.execute(sql`delete from runs where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from messages where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from conversations where organization_id = ${orgId}::uuid`);
        await tx.delete(policySnapshots).where(sql`${policySnapshots.assistantVersionId} in (select id from assistant_versions where assistant_id = ${assistantId}::uuid)`);
        await tx.delete(assistantInstalls).where(sql`${assistantInstalls.assistantId} = ${assistantId}::uuid`);
        await tx.delete(assistantVersions).where(sql`${assistantVersions.assistantId} = ${assistantId}::uuid`);
        await tx.delete(assistants).where(sql`${assistants.id} = ${assistantId}::uuid`);
      }
      await tx.delete(assistantTemplates).where(sql`${assistantTemplates.slug} = ${slug}`);
      void runs;
      void conversations;
      void messages;
    });
    await db.onModuleDestroy();
  });

  it('analytics rollup: recomputeOutcomes inserts a conversation_outcomes row (6 columns / 6 expressions)', async () => {
    const { conversations, messages, runs } = await import('../../src/modules/conversations/schema');
    const { policySnapshots } = await import('../../src/modules/assistants/schema');
    const { AnalyticsRollupConsumer } = await import('../../src/workers/analytics-rollup.consumer');
    const assistantId = await plantAssistant(`egf-analytics-${assistantIds.length}`);
    const hash = `egf-analytics-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 1, status: 'PUBLISHED', hash });
    const snapshotId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.insert(policySnapshots).values({
        id: snapshotId,
        organizationId: orgId,
        assistantVersionId: versionId,
        modelPolicy: {},
        contextPolicy: {},
        toolPolicy: {},
        guardrailPolicy: {},
        hash,
      });
      await tx.insert(conversations).values({ id: conversationId, organizationId: orgId, assistantId });
      await tx.insert(messages).values({
        id: messageId,
        conversationId,
        organizationId: orgId,
        sequence: 1,
        role: 'user',
        content: { text: 'hello' },
      });
      await tx.insert(runs).values({
        id: runId,
        organizationId: orgId,
        conversationId,
        inputMessageId: messageId,
        assistantVersionId: versionId,
        policySnapshotId: snapshotId,
        state: 'COMPLETED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    });
    const consumer = new AnalyticsRollupConsumer(db);
    // Pre-fix: INSERT has more target columns than expressions → throws here.
    await (consumer as unknown as { recomputeOutcomes(o: string): Promise<void> }).recomputeOutcomes(orgId);
    const rows = await db.withBypass((tx) =>
      tx.execute(sql`select kind, metrics from analytics_rollups where organization_id = ${orgId}::uuid and kind = 'conversation_outcomes'`),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    // NOTE: tx.execute returns JSONB through the driver's OID-3802 string
    // parser (see pg-types.ts), so metrics arrives as a string here.
    const rawMetrics = (rows.rows[0] as { metrics: unknown }).metrics;
    const metrics = typeof rawMetrics === 'string' ? (JSON.parse(rawMetrics) as { completed: number }) : (rawMetrics as { completed: number });
    expect(Number(metrics.completed)).toBeGreaterThanOrEqual(1);
  });

  it('completeRun: a NULL knowledge_policy does not fail schema_valid', async () => {
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const assistantId = await plantAssistant(`egf-nullkp-${assistantIds.length}`);
    const hash = `egf-nullkp-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash });
    const datasetId = await plantDataset();
    const runId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId });
      await tx.insert(evalRuns).values({
        id: runId,
        organizationId: orgId,
        datasetId,
        assistantVersionId: versionId,
        state: 'running',
        startedBy: actor,
      });
    });
    // Sanity: the row really carries NULL (absent), not {}.
    const kp = await db.withBypass((tx) =>
      tx.execute(sql`select knowledge_policy is null as is_null from assistant_versions where id = ${versionId}::uuid`),
    );
    expect((kp.rows[0] as { is_null: boolean }).is_null).toBe(true);
    const result = (await evals.completeRun({
      orgId,
      evalRunId: runId,
      results: { cases: [{ case_id: 'c1', attempt: 1, passed: true, score: 1 }] },
      actor,
    })) as { decision: string; provenance: { block_reasons?: string[] } };
    // Pre-fix: schema_valid failed on the NULL policy → BLOCK.
    expect(result.decision).toBe('PASS');
    expect(result.provenance.block_reasons ?? []).toEqual([]);
  });

  it('eval scoring: the typed JSONB read scores message content (no string-form misread)', async () => {
    const { conversations, messages } = await import('../../src/modules/conversations/schema');
    const { evalCases, evalDatasets } = await import('../../src/modules/knowledge/eval.schema');
    const { EvalScoringConsumer } = await import('../../src/workers/eval-scoring.consumer');
    const assistantId = await plantAssistant(`egf-scorer-${assistantIds.length}`);
    const datasetId = await plantDataset();
    const caseId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.insert(evalCases).values({
        id: caseId,
        organizationId: orgId,
        datasetId,
        input: { prompt: 'capital of France?' },
        expected: { contains: ['paris'] },
        sequence: 1,
      });
      await tx.insert(conversations).values({ id: conversationId, organizationId: orgId, assistantId });
      await tx.insert(messages).values({
        id: messageId,
        conversationId,
        organizationId: orgId,
        sequence: 1,
        role: 'assistant',
        content: { text: 'The capital of France is Paris.' },
      });
    });
    void evalDatasets;
    const consumer = new EvalScoringConsumer(db, evals);
    // The exact seam that was fixed: raw SQL returned the driver's string
    // form of JSONB (OID 3802 parser), so `.text` read off a string and every
    // case scored 0.
    const verdict = await (consumer as unknown as {
      scoreResponse(o: string, c: string, m: string): Promise<{ state: string; score: number }>;
    }).scoreResponse(orgId, caseId, messageId);
    expect(verdict.state).toBe('passed');
    expect(verdict.score).toBe(1);
  });

  it('completeRun: a DRAFT regresses against the currently-published version (version-0 sentinel no longer unsatisfiable)', async () => {
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const assistantId = await plantAssistant(`egf-regression-${assistantIds.length}`);
    const pubHash = `egf-pub-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const draftHash = `egf-draft-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const publishedId = await plantVersion({ assistantId, version: 1, status: 'PUBLISHED', hash: pubHash });
    const draftId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash: draftHash });
    const datasetId = await plantDataset();
    const draftRunId = randomUUID();
    const finishedAt = new Date().toISOString();
    await db.withBypass(async (tx) => {
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId });
      // The release the draft would succeed: a completed PASS at score 1.0.
      await tx.insert(evalRuns).values({
        id: randomUUID(),
        organizationId: orgId,
        datasetId,
        assistantVersionId: publishedId,
        state: 'completed',
        score: '1.0000',
        decision: 'PASS',
        startedBy: actor,
        finishedAt,
      });
      await tx.insert(evalRuns).values({
        id: draftRunId,
        organizationId: orgId,
        datasetId,
        assistantVersionId: draftId,
        state: 'running',
        startedBy: actor,
      });
    });
    const result = (await evals.completeRun({
      orgId,
      evalRunId: draftRunId,
      results: {
        cases: [
          { case_id: 'c1', attempt: 1, passed: true, score: 1 },
          { case_id: 'c2', attempt: 1, passed: false, score: 0 },
        ],
      },
      actor,
    })) as { decision: string; provenance: { block_reasons?: string[] } };
    // Pre-fix: the baseline bound `previous_version < 0` matched nothing, so
    // the 0.5 regression against the published 1.0 never fired → PASS.
    expect(result.decision).toBe('BLOCK');
    expect((result.provenance.block_reasons ?? []).join(' ')).toContain('regression');
  });

  it('ensureVersionSnapshot: a draft edited after the snapshot gets a NEW immutable snapshot row (old row untouched)', async () => {
    const { assistantVersions, policySnapshots } = await import('../../src/modules/assistants/schema');
    const assistantId = await plantAssistant(`egf-snapshot-${assistantIds.length}`);
    const hashV1 = `egf-snap1-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const hashV2 = `egf-snap2-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash: hashV1 });
    // Snapshot taken when the draft carried hashV1.
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    const snapV1 = await db.withBypass((tx) =>
      tx.select().from(policySnapshots).where(
        and(eq(policySnapshots.assistantVersionId, versionId), eq(policySnapshots.hash, hashV1)),
      ).limit(1),
    );
    expect(snapV1.length).toBe(1);
    const v1Instructions = snapV1[0].instructions;
    // Draft edited in place (what updateDraft does): the version row now
    // carries hashV2.
    await db.withBypass((tx) =>
      tx.update(assistantVersions).set({ hash: hashV2, instructions: 'edited instructions' }).where(sql`${assistantVersions.id} = ${versionId}::uuid`),
    );
    // Pre-fix (in-place refresh): the single snapshot row was MUTATED to
    // hashV2 — an eval dispatched against hashV1 would complete with
    // evaluated_content_hash=hashV2 and in-flight runs would silently
    // switch content mid-run. Post-fix: a NEW row is inserted; the hashV1
    // row is immutable history.
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    const rows = await db.withBypass((tx) =>
      tx.select({ hash: policySnapshots.hash, instructions: policySnapshots.instructions })
        .from(policySnapshots)
        .where(eq(policySnapshots.assistantVersionId, versionId)),
    );
    expect(rows.length).toBe(2);
    const byHash = new Map(rows.map((r) => [r.hash, r]));
    // The old row is byte-identical to before the edit (immutable).
    expect(byHash.get(hashV1)?.instructions).toBe(v1Instructions);
    // The new row pins the edited content.
    expect(byHash.get(hashV2)?.instructions).toBe('edited instructions');
    // Idempotent: a second call for the same content adds nothing.
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    const rows2 = await db.withBypass((tx) =>
      tx.select({ hash: policySnapshots.hash }).from(policySnapshots).where(eq(policySnapshots.assistantVersionId, versionId)),
    );
    expect(rows2.length).toBe(2);
  });

  it('in-flight edit race: an eval dispatched at H1 pins H1 in provenance even after the draft is edited to H2', async () => {
    // The live-proven defect (2026-09-22): R1 dispatched while the draft
    // carried H1; the draft was edited to H2; R1 completed afterwards and
    // its provenance pinned evaluated_content_hash=H2 (completion-time read
    // of the mutable snapshot row). W2.4 (drizzle/0070): startRun pins the
    // snapshot ONCE; completeRun attests the pin (verified against the
    // executions), never the version row's live hash.
    const { assistantInstalls, assistantVersions } = await import('../../src/modules/assistants/schema');
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const assistantId = await plantAssistant(`egf-race-${assistantIds.length}`);
    const hashH1 = `egf-raceh1-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const hashH2 = `egf-raceh2-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash: hashH1 });
    const datasetId = await plantDataset();
    const evalRunId = randomUUID();
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    const snapH1 = await snapshotIdFor(versionId, hashH1);
    await db.withBypass(async (tx) => {
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId });
      // The run as startRun would have created it: pinned to the H1
      // snapshot row at start time.
      await tx.insert(evalRuns).values({
        id: evalRunId,
        organizationId: orgId,
        datasetId,
        assistantVersionId: versionId,
        state: 'running',
        startedBy: actor,
        policySnapshotId: snapH1,
      });
    });
    // R1's execution dispatched against the H1 snapshot row.
    await plantDispatchedExecution({ evalRunId, assistantId, versionId, snapshotId: snapH1, datasetId });
    // The draft is edited mid-eval: new content hash, new immutable snapshot row.
    await db.withBypass((tx) =>
      tx.update(assistantVersions).set({ hash: hashH2 }).where(sql`${assistantVersions.id} = ${versionId}::uuid`),
    );
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    // R1 completes AFTER the edit.
    const result = (await evals.completeRun({
      orgId,
      evalRunId,
      results: { cases: [{ case_id: 'c1', attempt: 1, passed: true, score: 1 }] },
      actor,
    })) as { decision: string; provenance: { evaluated_content_hash?: string; block_reasons?: string[] } };
    expect(result.decision).toBe('PASS');
    // Pre-fix: H2 (misattributed to content the eval never executed).
    expect(result.provenance.evaluated_content_hash).toBe(hashH1);
  });

  it('mixed-content execution: executions split across an edit BLOCK fail-closed with a null pin', async () => {
    // An edit landing mid-dispatch under the PRE-pin executor: one
    // execution ran H1, another ran H2. No single evaluated content exists
    // — attributing a PASS to either hash would be a lie, so the run BLOCKS
    // and the provenance pin stays NULL (the gate fails it closed).
    const { assistantInstalls, assistantVersions } = await import('../../src/modules/assistants/schema');
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const assistantId = await plantAssistant(`egf-mixed-${assistantIds.length}`);
    const hashH1 = `egf-mixh1-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const hashH2 = `egf-mixh2-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash: hashH1 });
    const datasetId = await plantDataset();
    const evalRunId = randomUUID();
    const ensure = assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    };
    await ensure.ensureVersionSnapshot(orgId, assistantId, versionId);
    const snapH1 = await snapshotIdFor(versionId, hashH1);
    await db.withBypass(async (tx) => {
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId });
      await tx.insert(evalRuns).values({
        id: evalRunId,
        organizationId: orgId,
        datasetId,
        assistantVersionId: versionId,
        state: 'running',
        startedBy: actor,
        policySnapshotId: snapH1,
      });
    });
    // First execution dispatched against H1…
    await plantDispatchedExecution({ evalRunId, assistantId, versionId, snapshotId: snapH1, datasetId });
    // …then the draft is edited and the second execution dispatches against H2.
    await db.withBypass((tx) =>
      tx.update(assistantVersions).set({ hash: hashH2 }).where(sql`${assistantVersions.id} = ${versionId}::uuid`),
    );
    await ensure.ensureVersionSnapshot(orgId, assistantId, versionId);
    const snapH2 = await snapshotIdFor(versionId, hashH2);
    await plantDispatchedExecution({ evalRunId, assistantId, versionId, snapshotId: snapH2, datasetId });
    const result = (await evals.completeRun({
      orgId,
      evalRunId,
      results: {
        cases: [
          { case_id: 'c1', attempt: 1, passed: true, score: 1 },
          { case_id: 'c2', attempt: 1, passed: true, score: 1 },
        ],
      },
      actor,
    })) as { decision: string; provenance: { block_reasons?: string[]; evaluated_content_hash?: string | null } };
    // Pre-fix: no mixed-content check existed — this scored 1.0 → PASS.
    expect(result.decision).toBe('BLOCK');
    expect((result.provenance.block_reasons ?? []).join(' ')).toContain('mixed content');
    // The pin is NULL: no single content was evaluated, so nothing is
    // attributed (the publish gate fails null pins closed).
    expect(result.provenance.evaluated_content_hash).toBeNull();
  });

  it('startRun pins the version\'s current snapshot and carries the pin on eval.run_requested', async () => {
    // W2.4 (drizzle/0070): the authoritative content pin is witnessed ONCE
    // at start time — in the same transaction as the run insert — and
    // travels on the dispatch payload so the executor never re-resolves
    // mutable "current" content.
    const { outboxEvents } = await import('../../src/common/infra/outbox/schema');
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const assistantId = await plantAssistant(`egf-pin-${assistantIds.length}`);
    const hash = `egf-pinh1-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash });
    const datasetId = await plantDataset();
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    const expectedSnap = await snapshotIdFor(versionId, hash);
    const run = (await evals.startRun({
      orgId,
      datasetId,
      assistantVersionId: versionId,
      attemptsPerCase: 1,
      actor,
    })) as { id: string; policySnapshotId: string };
    expect(run.policySnapshotId).toBe(expectedSnap);
    const events = await db.withBypass((tx) =>
      tx
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.organizationId, orgId),
            eq(outboxEvents.aggregateId, run.id),
            eq(outboxEvents.eventType, 'eval.run_requested'),
          ),
        )
        .limit(1),
    );
    expect(events.length).toBe(1);
    expect((events[0].payload as { policy_snapshot_id?: string }).policy_snapshot_id).toBe(expectedSnap);
    // The row the executor would read also carries the pin (payload/row
    // fallback path).
    const rows = await db.withBypass((tx) =>
      tx.select({ policySnapshotId: evalRuns.policySnapshotId }).from(evalRuns).where(eq(evalRuns.id, run.id)).limit(1),
    );
    expect(rows[0].policySnapshotId).toBe(expectedSnap);
  });

  it('acceptMessage with pinSnapshotId dispatches the PINNED snapshot even after a mid-dispatch edit', async () => {
    // The true in-flight edit race at the conversation plane: the version
    // is edited AFTER the eval pinned H1 but BEFORE this case dispatches.
    // Without the pin the case would resolve the version's CURRENT snapshot
    // (H2 — mixed-content execution); with the pin it runs H1.
    const { assistantVersions, policySnapshots } = await import('../../src/modules/assistants/schema');
    const { runs } = await import('../../src/modules/conversations/schema');
    const { buildConversationsService } = await import('../helpers/db');
    const conversationsSvc = await buildConversationsService(db);
    const assistantId = await plantAssistant(`egf-acceptpin-${assistantIds.length}`);
    const hashH1 = `egf-acch1-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const hashH2 = `egf-acch2-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash: hashH1 });
    const ensure = assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    };
    await ensure.ensureVersionSnapshot(orgId, assistantId, versionId);
    const snapH1 = await snapshotIdFor(versionId, hashH1);
    // The edit lands mid-dispatch: version row now carries H2, with its own
    // immutable snapshot row.
    await db.withBypass((tx) =>
      tx.update(assistantVersions).set({ hash: hashH2 }).where(sql`${assistantVersions.id} = ${versionId}::uuid`),
    );
    await ensure.ensureVersionSnapshot(orgId, assistantId, versionId);
    const snapH2 = await snapshotIdFor(versionId, hashH2);
    expect(snapH2).not.toBe(snapH1);
    // Case dispatched WITH the run's pin → executes H1's immutable content.
    const convPinned = await conversationsSvc.createConversation({
      orgId,
      assistantId,
      createdBy: actor,
      participantScope: 'org',
    });
    const pinned = await conversationsSvc.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: convPinned.id,
      content: { text: 'probe' },
      pinVersionId: versionId,
      pinSnapshotId: snapH1,
      runKind: 'eval',
    });
    const pinnedRuns = await db.withBypass((tx) =>
      tx.select({ policySnapshotId: runs.policySnapshotId }).from(runs).where(eq(runs.id, pinned.run_id as string)).limit(1),
    );
    expect(pinnedRuns[0].policySnapshotId).toBe(snapH1);
    // Contrast — the pre-pin behavior still resolves CURRENT content (H2):
    // this is the race the pin eliminates for eval dispatch.
    const convCurrent = await conversationsSvc.createConversation({
      orgId,
      assistantId,
      createdBy: actor,
      participantScope: 'org',
    });
    const current = await conversationsSvc.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: convCurrent.id,
      content: { text: 'probe' },
      pinVersionId: versionId,
      runKind: 'eval',
    });
    const currentRuns = await db.withBypass((tx) =>
      tx.select({ policySnapshotId: runs.policySnapshotId }).from(runs).where(eq(runs.id, current.run_id as string)).limit(1),
    );
    expect(currentRuns[0].policySnapshotId).toBe(snapH2);
    void policySnapshots;
  });

  it('completeRun with no dispatched executions records a null content pin (fail-closed provenance)', async () => {
    // Studio write-back / legacy direct completion: the engine did not
    // observe the execution, so it cannot attest the content. The
    // provenance pin stays NULL (never the version's mutable current
    // snapshot) → the publish gate fails it closed (re-evaluate).
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const assistantId = await plantAssistant(`egf-nopinx-${assistantIds.length}`);
    const hash = `egf-nopinx-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const versionId = await plantVersion({ assistantId, version: 0, status: 'DRAFT', hash });
    const datasetId = await plantDataset();
    const evalRunId = randomUUID();
    await (assistantsSvc as unknown as {
      ensureVersionSnapshot(o: string, a: string, v: string): Promise<void>;
    }).ensureVersionSnapshot(orgId, assistantId, versionId);
    const snap = await snapshotIdFor(versionId, hash);
    await db.withBypass(async (tx) => {
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId });
      // Pinned at start (as startRun does) but completed with no dispatched
      // executions — the Studio write-back shape.
      await tx.insert(evalRuns).values({
        id: evalRunId,
        organizationId: orgId,
        datasetId,
        assistantVersionId: versionId,
        state: 'running',
        startedBy: actor,
        policySnapshotId: snap,
      });
    });
    const result = (await evals.completeRun({
      orgId,
      evalRunId,
      results: { cases: [{ case_id: 'c1', attempt: 1, passed: true, score: 1 }] },
      actor,
    })) as { decision: string; provenance: { evaluated_content_hash?: string | null } };
    expect(result.decision).toBe('PASS');
    // Pre-fix: fell back to the version's CURRENT snapshot hash — claiming
    // content the engine never observed.
    expect(result.provenance.evaluated_content_hash).toBeNull();
  });
});
