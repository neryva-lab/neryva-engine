import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool } from '../helpers/db';

/**
 * P3 (ai-native-review.md memory governance + guardrail modes):
 * - org memory policy (org_settings.preferences): scrub off/redact/block +
 *   default TTL, enforced on both memory write paths;
 * - content-addressed purge (tombstones, hashed audit, bounded query);
 * - guardrail execution_mode versioned through publish → snapshot → context.
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
const PII_CONTENT = 'Call the on-call engineer at 415-555-0132 about the outage';
const CLEAN_CONTENT = 'The deploy window opens at midnight UTC';

describeIfDb('memory governance (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let memory: import('../../src/modules/knowledge/memory.service').MemoryService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const nullConfig = { latest: async () => null } as never;

  async function setPreferences(prefs: Record<string, unknown>) {
    const { sql } = await import('drizzle-orm');
    await db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into org_settings (org_id, preferences) values (${orgId}, ${JSON.stringify(prefs)}::jsonb)
        on conflict (org_id) do update set preferences = ${JSON.stringify(prefs)}::jsonb`);
    });
  }

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { MemoryService } = await import('../../src/modules/knowledge/memory.service');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    db = new DbService();
    memory = new MemoryService(db, new AuditService(db), new EmbeddingService(), nullConfig);
  });

  afterAll(async () => {
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`delete from org_settings where org_id = ${orgId}`);
    });
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  it('stores verbatim by default (no policy row = legacy posture)', async () => {
    const item = await memory.create({
      orgId,
      content: PII_CONTENT,
      scopeType: 'organization',
      actor,
    });
    expect(item.content).toBe(PII_CONTENT);
    expect(item.expiresAt).toBeNull();
  });

  it('redacts + audits counts (never content) under redact policy', async () => {
    await setPreferences({ memory_pii_scrubbing: 'redact' });
    const item = await memory.create({
      orgId,
      content: PII_CONTENT,
      scopeType: 'organization',
      actor,
    });
    expect(item.content).toContain('[PHONE]');
    expect(item.content).not.toContain('415-555-0132');
    const { sql } = await import('drizzle-orm');
    const rows = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select details from audit_events where tenant_id = ${orgId} and action = 'memory.pii_redacted' order by created_at desc limit 1`,
      );
      return r.rows as Array<{ details: unknown }>;
    });
    const details = (
      typeof rows[0]?.details === 'string'
        ? JSON.parse(rows[0].details as string)
        : rows[0]?.details
    ) as Record<string, unknown>;
    expect(details.match_count).toBe(1);
    expect(JSON.stringify(details)).not.toContain('415-555-0132');
  });

  it('refuses PII-bearing memories under block policy', async () => {
    await setPreferences({ memory_pii_scrubbing: 'block' });
    await expect(
      memory.create({ orgId, content: PII_CONTENT, scopeType: 'organization', actor }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const clean = await memory.create({
      orgId,
      content: CLEAN_CONTENT,
      scopeType: 'organization',
      actor,
    });
    expect(clean.content).toBe(CLEAN_CONTENT);
  });

  it('applies the default TTL only when no expiry is set', async () => {
    await setPreferences({ memory_ttl_default_seconds: 7200 });
    const before = Date.now();
    const item = await memory.create({
      orgId,
      content: 'ttl probe memory',
      scopeType: 'organization',
      actor,
    });
    expect(item.expiresAt).toBeTruthy();
    const expires = Date.parse(item.expiresAt as string);
    expect(expires - before).toBeGreaterThan(7190_000);
    expect(expires - before).toBeLessThan(7300_000);
  });

  it('purges by content with hashed audit, and rejects short queries', async () => {
    await setPreferences({});
    const marker = `sunset riders ${randomUUID().slice(0, 8)}`;
    await memory.create({
      orgId,
      content: `first ${marker} note`,
      scopeType: 'organization',
      actor,
    });
    await memory.create({
      orgId,
      content: `second ${marker} note`,
      scopeType: 'organization',
      actor,
    });
    await memory.create({
      orgId,
      content: 'unrelated standing memory',
      scopeType: 'organization',
      actor,
    });
    await expect(memory.purgeByContent({ orgId, substring: 'ab', actor })).rejects.toMatchObject({
      code: 'validation_failed',
    });

    // Self-diagnosing precondition: the two marker rows must be visible before
    // the purge runs (guards against silent setup drift, not the purge itself).
    const preList = await memory.list(orgId);
    expect(preList.filter((m) => m.content.includes(marker))).toHaveLength(2);
    const result = await memory.purgeByContent({ orgId, substring: marker, actor });
    expect(result.purged).toBe(2);
    const remaining = await memory.list(orgId);
    expect(remaining.some((m) => m.content.includes(marker))).toBe(false);
    expect(remaining.some((m) => m.content === 'unrelated standing memory')).toBe(true);

    const { sql } = await import('drizzle-orm');
    const rows = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select details from audit_events where tenant_id = ${orgId} and action = 'memory.purged' order by created_at desc limit 1`,
      );
      return r.rows as Array<{ details: unknown }>;
    });
    const details = (
      typeof rows[0]?.details === 'string'
        ? JSON.parse(rows[0].details as string)
        : rows[0]?.details
    ) as Record<string, unknown>;
    expect(details.purged_count).toBe(2);
    // The audit names ids + a query hash — never the (possibly PII-bearing) substring.
    expect(JSON.stringify(details)).not.toContain(marker);
    expect(typeof details.query_hash).toBe('string');
    // Repeat purge finds nothing (tombstones don't rematch) — runs AFTER the
    // audit read so its own (purged_count: 0) audit row doesn't shadow it.
    expect((await memory.purgeByContent({ orgId, substring: marker, actor })).purged).toBe(0);
  });

  it('versions execution_mode through publish into the authorized context', async () => {
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    const assistants = await buildAssistantsService(db);
    const conversationsSvc = await buildConversationsService(db);
    const { McpAuthorityService } =
      await import('../../src/modules/conversations/mcp-authority.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    const { RetrievalService } = await import('../../src/modules/knowledge/retrieval.service');
    const { RerankerService } = await import('../../src/modules/knowledge/reranker.port');
    const { QueryRewriteService } = await import('../../src/modules/knowledge/query-rewrite.port');
    const retrieval = new RetrievalService(
      db,
      new EmbeddingService(),
      new RerankerService(),
      new QueryRewriteService(),
      nullConfig,
    );
    const authority = new McpAuthorityService(
      db,
      new AuditService(db),
      undefined as never,
      undefined as never,
      retrieval,
      undefined as never,
    );

    async function assistantWithMode(
      mode?: string,
    ): Promise<{ assistantId: string; runId: string }> {
      const { assistant } = await assistants.create({
        orgId,
        name: `mode-${randomUUID().slice(0, 8)}`,
        createdBy: actor,
      });
      const draft = await assistants.createVersion({
        orgId,
        assistantId: assistant.id,
        payload: {
          instructions: 'You are a mode test agent.',
          model_policy: { allowed_models: ['econ/split-model'] },
          context_policy: { history_limit: 5 },
          tool_policy: { tools: [] },
          guardrail_policy: mode === undefined ? {} : { execution_mode: mode },
        } as never,
        createdBy: actor,
      });
      await assistants.publish({
        orgId,
        assistantId: assistant.id,
        versionId: draft.id,
        publishedBy: actor,
      });
      const conversation = await conversationsSvc.createConversation({
        orgId,
        assistantId: assistant.id,
        createdBy: actor,
      });
      const accepted = await conversationsSvc.acceptMessage({
        orgId,
        principalId: actor,
        conversationId: conversation.id,
        content: { text: 'mode check' },
        idempotencyKey: `idem-${randomUUID()}`,
      });
      return { assistantId: assistant.id, runId: accepted.run_id as string };
    }

    const logged = await assistantWithMode('logging');
    const ctxLogged = await authority.getAuthorizedRunContext({ orgId, runId: logged.runId });
    expect(ctxLogged.guardrailPolicy.executionMode).toBe('logging');

    const legacy = await assistantWithMode(undefined);
    const ctxLegacy = await authority.getAuthorizedRunContext({ orgId, runId: legacy.runId });
    expect(ctxLegacy.guardrailPolicy.executionMode).toBe('blocking');
  });
});
