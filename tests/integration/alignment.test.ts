import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool } from '../helpers/db';

/**
 * P5 (ai-native-review.md continuous alignment + degraded lifecycle):
 * - shadow evals never gate releases (BLOCK ignored) and never surface as
 *   the version verdict; formal BLOCK still refuses;
 * - drift detection compares pinned refs to the live catalog (changed /
 *   removed / disabled), fail-open when no catalog exists;
 * - shadow start dedupes to one per version per 24h, reports no_dataset
 *   honestly, and the drift worker alerts either way;
 * - publish-with-bypass starts the 7-day degraded clock; healthy publish
 *   clears it; the sweep suspends the overdue and warns once at T-24h.
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  const { TEST_DATABASE_URL } = await import('../helpers/db');
  if (!TEST_DATABASE_URL) return false;
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
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

const basePayload = (extra: Record<string, unknown> = {}) => ({
  instructions: 'You are an alignment test agent.',
  model_policy: { allowed_models: ['driftprov/drift-model'] },
  context_policy: { history_limit: 5 },
  tool_policy: { tools: [] },
  guardrail_policy: {},
  ...extra,
});

describeIfDb('alignment: shadow evals + degraded lifecycle (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  const orgId = randomUUID();
  const actor = 'integration-test';

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    db = new DbService();
    assistants = await buildAssistantsService(db);
    conversations = await buildConversationsService(db);
  });

  afterAll(async () => {
    // eval_runs / datasets / installs reference versions without cascade —
    // delete them first (draft-eval precedent), then full org cleanup.
    const { sql } = await import('drizzle-orm');
    await db.withBypass(async (tx) => {
      await tx.execute(sql`delete from eval_runs where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from eval_datasets where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from assistant_installs where organization_id = ${orgId}::uuid`);
    });
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  async function publishedAssistant(
    payload: Record<string, unknown>,
  ): Promise<{ assistantId: string; versionId: string }> {
    const { assistant } = await assistants.create({
      orgId,
      name: `align-${randomUUID().slice(0, 8)}`,
      createdBy: actor,
    });
    const draft = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: payload as never,
      createdBy: actor,
    });
    const v1 = await assistants.publish({
      orgId,
      assistantId: assistant.id,
      versionId: draft.id,
      publishedBy: actor,
    });
    return { assistantId: assistant.id, versionId: v1.id };
  }

  async function insertEvalDecision(
    versionId: string,
    decision: 'BLOCK' | 'PASS',
    shadow: boolean,
  ) {
    const { sql } = await import('drizzle-orm');
    const datasetId = randomUUID();
    // The publish gate is provenance-hash keyed: a decision only gates the
    // content its provenance pins (evaluated_content_hash). Plant the pin so
    // the decision is attributable to this version's content (for a
    // PUBLISHED version the row hash is the immutable snapshot hash).
    const hashRows = await db.withBypass((tx) =>
      tx.execute(sql`select hash from assistant_versions where id = ${versionId}::uuid`),
    );
    const contentHash = (hashRows.rows[0] as { hash: string } | undefined)?.hash;
    if (!contentHash) throw new Error(`insertEvalDecision: no version ${versionId}`);
    await db.withBypass(async (tx) => {
      await tx.execute(
        sql`insert into eval_datasets (id, organization_id, name, created_by) values (${datasetId}::uuid, ${orgId}::uuid, ${`align-${datasetId.slice(0, 8)}`}, 'test')`,
      );
      await tx.execute(sql`
        insert into eval_runs (id, organization_id, dataset_id, assistant_version_id, state, attempts_per_case, started_by, decision, finished_at, is_shadow, provenance)
        values (${randomUUID()}::uuid, ${orgId}::uuid, ${datasetId}::uuid, ${versionId}::uuid, 'completed', 1, 'test', ${decision}, now(), ${shadow}, ${JSON.stringify({ evaluated_content_hash: contentHash })}::jsonb)`);
    });
  }

  it('ignores shadow BLOCK in gates and verdicts; formal BLOCK still refuses', async () => {
    const { assistantId, versionId: v1 } = await publishedAssistant(basePayload());
    // Move active to v2 (changed prompt) so rollbacks restore real history.
    const drafts = await assistants.listVersions(orgId, assistantId);
    const stale = drafts.find((v) => v.status === 'DRAFT')!;
    await assistants.discardDraft({ orgId, assistantId, versionId: stale.id, actorId: actor });
    const redraft = await assistants.createVersion({
      orgId,
      assistantId,
      payload: basePayload({ instructions: 'You are an alignment test agent v2.' }) as never,
      createdBy: actor,
    });
    await assistants.publish({ orgId, assistantId, versionId: redraft.id, publishedBy: actor });

    await insertEvalDecision(v1, 'BLOCK', true);
    // Shadow BLOCK neither gates the rollback (hash-keyed gate skips it) nor
    // surfaces as v1's verdict.
    const rolled = await assistants.rollback({
      orgId,
      assistantId,
      toVersionId: v1,
      publishedBy: actor,
    });
    expect(rolled.rollbackOf).toBe(v1);
    const provenance = await assistants.getVersionProvenance(orgId, assistantId, v1);
    expect(provenance.last_evaluation).toBeNull();

    // Formal BLOCK on the same content refuses the same rollback shape.
    // (Active is v3 = v1's payload; move away with v4 first so the refusal
    // is the gate, not the joint no-op rule.)
    await insertEvalDecision(v1, 'BLOCK', false);
    const drafts2 = await assistants.listVersions(orgId, assistantId);
    const stale2 = drafts2.find((v) => v.status === 'DRAFT');
    if (stale2) {
      await assistants.discardDraft({ orgId, assistantId, versionId: stale2.id, actorId: actor });
    }
    const redraft2 = await assistants.createVersion({
      orgId,
      assistantId,
      payload: basePayload({ instructions: 'You are an alignment test agent v4.' }) as never,
      createdBy: actor,
    });
    await assistants.publish({ orgId, assistantId, versionId: redraft2.id, publishedBy: actor });
    await expect(
      assistants.rollback({ orgId, assistantId, toVersionId: v1, publishedBy: actor }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('detects catalog drift, dedupes shadow evals, and alerts', async () => {
    const { canonicalHash } = await import('../../src/common/crypto/canonical-hash');
    const { EvalService } = await import('../../src/modules/knowledge/eval.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    // Live catalog: entry present but CHANGED (regions added) + disabled twin.
    const liveModels = [
      { provider: 'driftprov', model: 'drift-model', enabled: true, regions: ['global', 'eu'] },
      { provider: 'driftprov', model: 'gone-model', enabled: false, regions: ['global'] },
    ];
    const fakeConfig = { latest: async () => ({ payload: { models: liveModels } }) } as never;
    const evals = new EvalService(db, new AuditService(db), undefined as never, fakeConfig);

    const { assistantId } = await publishedAssistant(basePayload());
    // Simulate a pin taken when the catalog was smaller: hash the OLD entry.
    const oldEntry = { provider: 'driftprov', model: 'drift-model', enabled: true };
    const { sql } = await import('drizzle-orm');
    await db.withBypass(async (tx) => {
      await tx.execute(sql`
        update policy_snapshots set model_ref = jsonb_build_object('models', jsonb_build_array(
          jsonb_build_object('provider', 'driftprov', 'model', 'drift-model', 'catalog_config_id', 'cfg', 'catalog_payload_hash', 'ph', 'entry_hash', ${canonicalHash(oldEntry)}::text, 'catalog_enabled', true),
          jsonb_build_object('provider', 'driftprov', 'model', 'retired-model', 'catalog_config_id', 'cfg', 'catalog_payload_hash', 'ph', 'entry_hash', 'deadbeef', 'catalog_enabled', true)
        ))
        where assistant_version_id in (select active_version_id from assistants where id = ${assistantId}::uuid)`);
    });

    const detected = await evals.detectModelDrift(orgId, assistantId);
    expect(detected.versionId).toBeTruthy();
    const reasons = new Map(detected.drifted.map((d) => [d.alias, d.reason]));
    expect(reasons.get('driftprov/drift-model')).toBe('entry_changed');
    expect(reasons.get('driftprov/retired-model')).toBe('entry_removed');

    // No seeded dataset → honest no_dataset (no throw).
    const noDataset = await evals.startShadowEval({
      orgId,
      assistantId,
      versionId: detected.versionId as string,
      drifted: detected.drifted,
    });
    expect(noDataset.status).toBe('no_dataset');

    // Seed install + dataset → started, then deduped within 24h.
    await db.withBypass(async (tx) => {
      await tx.execute(
        sql`insert into assistant_installs (id, organization_id, slug, template_version, assistant_id) values (${randomUUID()}::uuid, ${orgId}::uuid, 'drift-tpl', '1.0.0', ${assistantId}::uuid)`,
      );
      await tx.execute(
        sql`insert into eval_datasets (id, organization_id, name, created_by) values (${randomUUID()}::uuid, ${orgId}::uuid, 'template:drift-tpl@1.0.0', 'test')`,
      );
    });
    const started = await evals.startShadowEval({
      orgId,
      assistantId,
      versionId: detected.versionId as string,
      drifted: detected.drifted,
    });
    expect(started.status).toBe('started');
    const again = await evals.startShadowEval({
      orgId,
      assistantId,
      versionId: detected.versionId as string,
      drifted: detected.drifted,
    });
    expect(again.status).toBe('deduped');
    const rows = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select is_shadow, started_by from eval_runs where assistant_version_id = ${detected.versionId}::uuid and is_shadow = true`,
      );
      return r.rows as Array<{ is_shadow: boolean; started_by: string }>;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].started_by).toBe('system:model-drift');

    // Worker tick alerts (fake notifications sink, scoped to this org).
    const { ModelDriftWorker } = await import('../../src/workers/model-drift.worker');
    const calls: Array<{ kind: string }> = [];
    const fakeNotifications = {
      notifyOrgRoles: async (_o: string, _r: string[], input: { kind: string }) =>
        void calls.push({ kind: input.kind }),
    } as never;
    const worker = new ModelDriftWorker(db, evals, fakeNotifications);
    await worker.tick(orgId);
    expect(calls.some((c) => c.kind === 'assistant.model_drift')).toBe(true);
  });

  it('starts the degraded clock on waived publish, clears on healthy, sweeps on expiry', async () => {
    // Waived publish: unresolvable slug + explicit ack.
    const waived = await assistants.create({
      orgId,
      name: `deg-${randomUUID().slice(0, 8)}`,
      createdBy: actor,
    });
    const waivedDraft = await assistants.createVersion({
      orgId,
      assistantId: waived.assistant.id,
      payload: basePayload({
        context_policy: { knowledge_sources: ['missing-slug-xyz'] },
      }) as never,
      createdBy: actor,
    });
    await assistants.publish({
      orgId,
      assistantId: waived.assistant.id,
      versionId: waivedDraft.id,
      publishedBy: actor,
      acknowledgeDegradedKnowledge: true,
    });
    const { sql } = await import('drizzle-orm');
    const degradedRow = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select degraded_until, degraded_reason from assistants where id = ${waived.assistant.id}::uuid`,
      );
      return r.rows[0] as { degraded_until: string | null; degraded_reason: string | null };
    });
    expect(degradedRow.degraded_until).toBeTruthy();
    expect(Date.parse(degradedRow.degraded_until as string) - Date.now()).toBeGreaterThan(
      6 * 86_400_000,
    );
    expect(degradedRow.degraded_reason).toContain('missing-slug-xyz');

    // Healthy publish on ANOTHER assistant leaves no clock.
    const { assistantId: healthyId } = await publishedAssistant(basePayload());
    const healthyRow = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select degraded_until from assistants where id = ${healthyId}::uuid`,
      );
      return r.rows[0] as { degraded_until: string | null };
    });
    expect(healthyRow.degraded_until).toBeNull();

    // Sweep: overdue suspends (reversible disable), due-soon warns once.
    await db.withBypass(async (tx) => {
      await tx.execute(
        sql`update assistants set degraded_until = now() - interval '1 hour' where id = ${waived.assistant.id}::uuid`,
      );
      await tx.execute(
        sql`update assistants set degraded_until = now() + interval '1 hour', degraded_reason = 'test' where id = ${healthyId}::uuid`,
      );
    });
    const notifCalls: Array<{ kind: string; ids: string[] }> = [];
    const fakeNotifications = {
      notifyOrgRoles: async (
        _o: string,
        _r: string[],
        input: { kind: string; data?: { assistant_id?: string } },
      ) =>
        void notifCalls.push({ kind: input.kind, ids: [String(input.data?.assistant_id ?? '')] }),
    } as never;
    const { DegradedSweepWorker } = await import('../../src/workers/degraded-sweep.worker');
    const worker = new DegradedSweepWorker(assistants, fakeNotifications);
    await worker.tick(orgId);
    const states = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select id, disabled_at, disabled_reason, degraded_alerted_at from assistants where id in (${waived.assistant.id}::uuid, ${healthyId}::uuid)`,
      );
      return r.rows as Array<{
        id: string;
        disabled_at: string | null;
        disabled_reason: string | null;
        degraded_alerted_at: string | null;
      }>;
    });
    const byId = new Map(states.map((s) => [s.id, s]));
    expect(byId.get(waived.assistant.id)?.disabled_at).toBeTruthy();
    expect(byId.get(waived.assistant.id)?.disabled_reason).toContain('7-day waiver');
    expect(byId.get(healthyId)?.disabled_at).toBeNull();
    expect(byId.get(healthyId)?.degraded_alerted_at).toBeTruthy();
    expect(notifCalls.some((c) => c.kind === 'assistant.degraded_suspended')).toBe(true);
    expect(notifCalls.some((c) => c.kind === 'assistant.degraded')).toBe(true);
    // Second sweep is quiet (alerted marked, overdue already disabled).
    notifCalls.length = 0;
    await worker.tick(orgId);
    expect(notifCalls.length).toBe(0);

    // Suspended assistant refuses new runs at acceptance (kill-switch truth).
    const convos = await import('../../src/modules/conversations/conversations.service');
    void convos;
    const conversation = await conversations.createConversation({
      orgId,
      assistantId: waived.assistant.id,
      createdBy: actor,
    });
    await expect(
      conversations.acceptMessage({
        orgId,
        principalId: actor,
        conversationId: conversation.id,
        content: { text: 'hi' },
        idempotencyKey: `idem-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
