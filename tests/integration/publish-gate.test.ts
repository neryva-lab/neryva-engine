import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * REL-3.3 gate negative matrix (release_ledger.md) — the publish gate against
 * live rows (db-suites lane):
 * - BLOCK → refuse (BLOCK message wins even when required checks are unmet);
 * - stale PASS (decision on another content hash) → refuse;
 * - WARN on a production pointer → refuse;
 * - WARN + approver changes nothing at publish (canary leniency is a
 *   promotion-time concern — the gate still refuses);
 * - absent decision + required check → refuse;
 * - fresh PASS on this hash → allow;
 * - no declared checks → allow (legacy posture; the BLOCK rule still applies);
 * - latest-wins in both directions (re-evaluation clears or sets the bar);
 * - cross-tenant decisions never satisfy the gate.
 *
 * The gate under test is `evaluatePublishGate` — the exact evaluator the
 * publish path calls (AssistantsService delegates to it), driven here
 * inside a tenant-scoped transaction like the publish TX.
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

const POLICIES = { modelPolicy: {}, contextPolicy: {}, toolPolicy: {}, guardrailPolicy: {} };

describeIfDb('publish-gate negative matrix (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let evaluatePublishGate: typeof import('../../src/modules/assistants/release-gate').evaluatePublishGate;
  const orgId = randomUUID();
  const orgB = randomUUID();
  const slug = `rel33-${randomUUID().slice(0, 8)}`;
  const openSlug = `rel33-open-${randomUUID().slice(0, 8)}`;
  const assistantIds: string[] = [];

  async function plantAssistant(hash: string): Promise<{ assistantId: string; versionId: string }> {
    const { assistants, assistantVersions } = await import('../../src/modules/assistants/schema');
    const assistantId = randomUUID();
    const versionId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.insert(assistants).values({ id: assistantId, organizationId: orgId, name: `rel33-${assistantId.slice(0, 8)}` });
      await tx
        .insert(assistantVersions)
        .values({ id: versionId, assistantId, organizationId: orgId, version: 1, status: 'PUBLISHED', hash, ...POLICIES });
    });
    assistantIds.push(assistantId);
    return { assistantId, versionId };
  }

  async function plantDecision(input: {
    versionId: string;
    decision: string;
    finishedAt: string;
    org?: string;
    datasetId?: string;
    /** Content hash the eval executed against (pinned in provenance). Defaults to the version's live hash. */
    evaluatedContentHash?: string;
  }): Promise<void> {
    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const { assistantVersions } = await import('../../src/modules/assistants/schema');
    let datasetId = input.datasetId;
    if (!datasetId) {
      const { evalDatasets } = await import('../../src/modules/knowledge/eval.schema');
      datasetId = randomUUID();
      await db.withBypass((tx) =>
        tx.insert(evalDatasets).values({ id: datasetId as string, organizationId: input.org ?? orgId, name: `rel33-${datasetId}`, createdBy: 'rel33' }),
      );
    }
    let evaluatedContentHash = input.evaluatedContentHash;
    if (!evaluatedContentHash) {
      const rows = await db.withBypass((tx) =>
        tx.select({ hash: assistantVersions.hash }).from(assistantVersions).where(sql`${assistantVersions.id} = ${input.versionId}::uuid`).limit(1),
      );
      evaluatedContentHash = rows[0]?.hash ?? null;
    }
    await db.withBypass((tx) =>
      tx.insert(evalRuns).values({
        id: randomUUID(),
        organizationId: input.org ?? orgId,
        datasetId: datasetId as string,
        assistantVersionId: input.versionId,
        state: 'completed',
        decision: input.decision,
        finishedAt: input.finishedAt,
        startedBy: 'rel33',
        provenance: { evaluated_content_hash: evaluatedContentHash },
      }),
    );
  }

  async function gate(assistantId: string, hash: string, org: string = orgId) {
    return db.withOrg(org, (tx) => evaluatePublishGate(tx, org, assistantId, hash));
  }

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const gateModule = await import('../../src/modules/assistants/release-gate');
    const { assistantTemplates } = await import('../../src/modules/assistants/schema');
    evaluatePublishGate = gateModule.evaluatePublishGate;
    db = new DbService();
    await db.withBypass(async (tx) => {
      await tx.insert(assistantTemplates).values({
        slug,
        version: '1.0.0',
        status: 'stable',
        family: 'rel33',
        definition: {},
        releasePolicy: { required: ['smoke', 'regression'] },
        hash: 't'.repeat(64),
        minEngineSchema: 1,
      });
      await tx.insert(assistantTemplates).values({
        slug: openSlug,
        version: '1.0.0',
        status: 'stable',
        family: 'rel33',
        definition: {},
        releasePolicy: {},
        hash: 'o'.repeat(64),
        minEngineSchema: 1,
      });
    });
    // Every assistant planted below installs the strict template unless noted.
  });

  afterAll(async () => {
    const { assistants, assistantVersions, assistantInstalls, assistantTemplates } = await import('../../src/modules/assistants/schema');
    await db.withBypass(async (tx) => {
      await tx.execute(sql`delete from eval_runs where organization_id in (${orgId}::uuid, ${orgB}::uuid)`);
      await tx.execute(sql`delete from eval_datasets where organization_id in (${orgId}::uuid, ${orgB}::uuid)`);
      for (const assistantId of assistantIds) {
        await tx.delete(assistantInstalls).where(sql`${assistantInstalls.assistantId} = ${assistantId}::uuid`);
        await tx.delete(assistantVersions).where(sql`${assistantVersions.assistantId} = ${assistantId}::uuid`);
        await tx.delete(assistants).where(sql`${assistants.id} = ${assistantId}::uuid`);
      }
      await tx.delete(assistantTemplates).where(sql`${assistantTemplates.slug} in (${slug}, ${openSlug})`);
    });
    await db.onModuleDestroy();
  });

  it('refuses when a required check has no decision at all', async () => {
    const hash = `rel33-absent-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId } = await plantAssistant(hash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId }),
    );
    const refusal = await gate(assistantId, hash);
    expect(refusal?.gate).toBe('required_checks');
    expect(refusal?.message).toContain('absent');
    expect(refusal?.details).toMatchObject({ required_checks: ['smoke', 'regression'], latest_decision: null });
  });

  it('refuses a stale PASS (decision on another content hash)', async () => {
    const liveHash = `rel33-live-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const staleHash = `rel33-stale-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const live = await plantAssistant(liveHash);
    const stale = await plantAssistant(staleHash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass(async (tx) => {
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId: live.assistantId });
      await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId: stale.assistantId });
    });
    await plantDecision({ versionId: stale.versionId, decision: 'PASS', finishedAt: new Date().toISOString() });
    const refusal = await gate(live.assistantId, liveHash);
    expect(refusal?.gate).toBe('required_checks');
    expect(refusal?.message).toContain('absent');
  });

  it('refuses when the draft was edited after the PASS (in-place hash rewrite)', async () => {
    // Regression: updateDraft rewrites the version row's hash in place. The
    // gate must pin the decision to the content hash the eval EXECUTED against
    // (provenance.evaluated_content_hash), not the row's live hash — otherwise
    // a PASS earned by the pre-edit content would publish the edited content.
    const preEditHash = `rel33-preedit-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const postEditHash = `rel33-postedit-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId, versionId } = await plantAssistant(preEditHash);
    const { assistantInstalls, assistantVersions } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId }),
    );
    // PASS earned by the pre-edit content.
    await plantDecision({
      versionId, decision: 'PASS', finishedAt: new Date().toISOString(),
      evaluatedContentHash: preEditHash,
    });
    // Simulate updateDraft: the same row now carries the edited content's hash.
    await db.withBypass((tx) =>
      tx.update(assistantVersions).set({ hash: postEditHash }).where(sql`${assistantVersions.id} = ${versionId}::uuid`),
    );
    // The gate for the EDITED content must refuse: no PASS exists for postEditHash.
    const refusal = await gate(assistantId, postEditHash);
    expect(refusal?.gate).toBe('required_checks');
    expect(refusal?.message).toContain('absent');
    expect(refusal?.details).toMatchObject({ latest_decision: null });
    // And the pre-edit content (if it were still the live hash) would allow —
    // proving the pin is on the evaluated hash, not the row.
    await db.withBypass((tx) =>
      tx.update(assistantVersions).set({ hash: preEditHash }).where(sql`${assistantVersions.id} = ${versionId}::uuid`),
    );
    await expect(gate(assistantId, preEditHash)).resolves.toBeNull();
  });

  it('refuses WARN, with or without a recorded approver', async () => {
    const hash = `rel33-warn-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId, versionId } = await plantAssistant(hash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId }),
    );
    await plantDecision({ versionId, decision: 'WARN', finishedAt: new Date().toISOString() });
    const refusal = await gate(assistantId, hash);
    expect(refusal?.gate).toBe('required_checks');
    expect(refusal?.message).toContain('WARN');
  });

  it('refuses BLOCK with the BLOCK message even when required checks are also unmet', async () => {
    const hash = `rel33-block-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId, versionId } = await plantAssistant(hash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId }),
    );
    await plantDecision({ versionId, decision: 'BLOCK', finishedAt: new Date().toISOString() });
    const refusal = await gate(assistantId, hash);
    expect(refusal?.gate).toBe('blocked_content');
    expect(refusal?.message).toContain('BLOCK');
  });

  it('allows a fresh PASS on this content hash', async () => {
    const hash = `rel33-pass-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId, versionId } = await plantAssistant(hash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId }),
    );
    await plantDecision({ versionId, decision: 'PASS', finishedAt: new Date().toISOString() });
    await expect(gate(assistantId, hash)).resolves.toBeNull();
  });

  it('allows publish with no declared checks, but the BLOCK rule still applies', async () => {
    const hash = `rel33-open-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId, versionId } = await plantAssistant(hash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug: openSlug, templateVersion: '1.0.0', assistantId }),
    );
    await expect(gate(assistantId, hash)).resolves.toBeNull();
    await plantDecision({ versionId, decision: 'BLOCK', finishedAt: new Date().toISOString() });
    const refusal = await gate(assistantId, hash);
    expect(refusal?.gate).toBe('blocked_content');
  });

  it('latest-wins: a re-evaluation that passes clears an earlier BLOCK, and vice versa', async () => {
    const clearedHash = `rel33-clear-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const cleared = await plantAssistant(clearedHash);
    await plantDecision({ versionId: cleared.versionId, decision: 'BLOCK', finishedAt: '2026-01-01T00:00:00.000Z' });
    await plantDecision({ versionId: cleared.versionId, decision: 'PASS', finishedAt: '2026-02-01T00:00:00.000Z' });
    await expect(gate(cleared.assistantId, clearedHash)).resolves.toBeNull();

    const blockedHash = `rel33-reblock-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const blocked = await plantAssistant(blockedHash);
    await plantDecision({ versionId: blocked.versionId, decision: 'PASS', finishedAt: '2026-01-01T00:00:00.000Z' });
    await plantDecision({ versionId: blocked.versionId, decision: 'BLOCK', finishedAt: '2026-02-01T00:00:00.000Z' });
    const refusal = await gate(blocked.assistantId, blockedHash);
    expect(refusal?.gate).toBe('blocked_content');
  });

  it('a cross-tenant PASS never satisfies the gate', async () => {
    const hash = `rel33-xtenant-${randomUUID().slice(0, 8)}`.padEnd(64, '0');
    const { assistantId, versionId } = await plantAssistant(hash);
    const { assistantInstalls } = await import('../../src/modules/assistants/schema');
    await db.withBypass((tx) =>
      tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId }),
    );
    // Org B evaluated the same content and passed — org A's gate must ignore it.
    await plantDecision({ versionId, decision: 'PASS', finishedAt: new Date().toISOString(), org: orgB });
    const refusal = await gate(assistantId, hash);
    expect(refusal?.gate).toBe('required_checks');
  });
});
