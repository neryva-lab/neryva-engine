import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool } from '../helpers/db';

/**
 * P6 (ai-native-review.md incident flags + lineage):
 * - revoke with compromised:true blocks identically AND pages owner/admin
 *   (routine revokes stay quiet); rotate still refuses revoked rows; the row
 *   (and its history joins) is never deleted;
 * - parent_version_id chains drafts→publishes and marks rollbacks, surfaced
 *   read-only in provenance.
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

const basePayload = {
  instructions: 'You are a lineage test agent.',
  model_policy: { allowed_models: ['test/model'] },
  context_policy: { history_limit: 5 },
  tool_policy: { tools: [] },
  guardrail_policy: {},
};

describeIfDb('incident flags + lineage (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let credentials: import('../../src/modules/assistants/provider-credentials.service').ProviderCredentialsService;
  const notifCalls: Array<{ kind: string; severity: string }> = [];
  const orgId = randomUUID();
  const actor = 'integration-test';

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { ProviderCredentialsService } =
      await import('../../src/modules/assistants/provider-credentials.service');
    const { buildAssistantsService } = await import('../helpers/db');
    db = new DbService();
    const audit = new AuditService(db);
    const fakeNotifications = {
      notifyOrgRoles: async (_o: string, _r: string[], input: { kind: string; severity: string }) =>
        void notifCalls.push({ kind: input.kind, severity: input.severity }),
    } as never;
    credentials = new ProviderCredentialsService(db, audit, fakeNotifications);
    assistants = await buildAssistantsService(db);
  });

  afterAll(async () => {
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  it('distinguishes compromise from routine revoke without deleting history', async () => {
    const routine = await credentials.create({
      orgId,
      provider: 'openai',
      label: 'routine-key',
      secret: 'sk-test-routine-key-material-1234567890',
      source: 'byok',
      actorId: actor,
    });
    const leaked = await credentials.create({
      orgId,
      provider: 'openai',
      label: 'leaked-key',
      secret: 'sk-test-leaked-key-material-0987654321',
      source: 'byok',
      actorId: actor,
    });

    const routineView = await credentials.revoke({
      orgId,
      credentialId: routine.id,
      actorId: actor,
      reason: 'key rotation hygiene',
    });
    expect(routineView.status).toBe('revoked');
    expect(routineView.compromised).toBe(false);
    expect(routineView.revocation_reason).toBe('key rotation hygiene');
    expect(notifCalls.length).toBe(0);

    const leakedView = await credentials.revoke({
      orgId,
      credentialId: leaked.id,
      actorId: actor,
      reason: 'key pasted in a public gist',
      compromised: true,
    });
    expect(leakedView.status).toBe('revoked');
    expect(leakedView.compromised).toBe(true);
    expect(notifCalls).toEqual([{ kind: 'credential.compromised', severity: 'error' }]);

    // Terminal in both cases: rotate refuses, reads exclude, rows stand.
    await expect(
      credentials.rotate({
        orgId,
        credentialId: leaked.id,
        secret: 'sk-test-new-material-abcdefghij',
        actorId: actor,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    const listed = await credentials.list(orgId);
    expect(listed.find((c) => c.id === leaked.id)?.status).toBe('revoked');
    const { sql } = await import('drizzle-orm');
    const rows = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int as n from provider_credentials where organization_id = ${orgId}::uuid`,
      );
      return r.rows as Array<{ n: number }>;
    });
    expect(rows[0].n).toBe(2);

    // Double revoke refuses (no silent re-write of the incident record).
    await expect(
      credentials.revoke({ orgId, credentialId: leaked.id, actorId: actor }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('chains parent versions across drafts, publishes, and rollbacks', async () => {
    const { assistant } = await assistants.create({
      orgId,
      name: `lin-${randomUUID().slice(0, 8)}`,
      createdBy: actor,
    });
    const d1 = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: basePayload as never,
      createdBy: actor,
    });
    expect(d1.parentVersionId).toBeNull();
    const v1 = await assistants.publish({
      orgId,
      assistantId: assistant.id,
      versionId: d1.id,
      publishedBy: actor,
    });
    expect(v1.parentVersionId).toBeNull();

    // One-draft workspace: the v0 row persists after publish, so v2 ships
    // through updateDraft — which REBASES lineage onto the current active
    // (v1). Publish carries it.
    const current = await assistants.getVersion(orgId, d1.id);
    const d2 = await assistants.updateDraft({
      orgId,
      assistantId: assistant.id,
      versionId: d1.id,
      payload: { ...basePayload, instructions: 'You are a lineage test agent v2.' } as never,
      expectedHash: current!.hash,
      actorId: actor,
    });
    expect(d2.parentVersionId).toBe(v1.id);
    const v2 = await assistants.publish({
      orgId,
      assistantId: assistant.id,
      versionId: d2.id,
      publishedBy: actor,
    });
    expect(v2.parentVersionId).toBe(v1.id);

    // Rollback-as-new derives from the restored version.
    const v3 = await assistants.rollback({
      orgId,
      assistantId: assistant.id,
      toVersionId: v1.id,
      publishedBy: actor,
    });
    expect(v3.parentVersionId).toBe(v1.id);
    expect(v3.rollbackOf).toBe(v1.id);

    // Provenance surfaces lineage read-only.
    const provenance = await assistants.getVersionProvenance(orgId, assistant.id, v2.id);
    expect(provenance.parent_version_id).toBe(v1.id);
    const provenanceV1 = await assistants.getVersionProvenance(orgId, assistant.id, v1.id);
    expect(provenanceV1.parent_version_id).toBeNull();
  });
});
