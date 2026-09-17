import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool } from '../helpers/db';

/**
 * P4 (ai-native-review.md execution perimeter) over live services:
 * - upsert pins env + egress on the catalog row (http default = binding host);
 * - publish carries the perimeter + mode into the snapshot binding;
 * - authorize allows + reports shadow:false on a live tool;
 * - widening the row post-publish denies with a drift message until re-pinned;
 * - shadow-mode bindings authorize with shadow:true (simulation signal).
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
const TOOL = `perim_tool_${randomUUID().slice(0, 8).replace(/-/g, '')}`;

describeIfDb('tool perimeter (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  let authority: import('../../src/modules/conversations/mcp-authority.service').McpAuthorityService;
  const orgId = randomUUID();
  const actor = 'integration-test';

  const payloadFor = (mode?: string) => ({
    instructions: 'You are a perimeter test agent.',
    model_policy: { allowed_models: ['test/model'] },
    context_policy: { history_limit: 5 },
    tool_policy: {
      tools: [
        { name: TOOL, access: 'read', ...(mode === undefined ? {} : { execution_mode: mode }) },
      ],
    },
    guardrail_policy: {},
  });

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { ToolCatalogService } =
      await import('../../src/modules/assistants/tool-catalog.service');
    const { McpAuthorityService } =
      await import('../../src/modules/conversations/mcp-authority.service');
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    db = new DbService();
    const audit = new AuditService(db);
    assistants = await buildAssistantsService(db);
    conversations = await buildConversationsService(db);
    authority = new McpAuthorityService(
      db,
      audit,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const catalog = new ToolCatalogService(db, audit);
    // HTTP tool, no explicit egress → pinned to exactly the binding host.
    const row = await catalog.upsert({
      orgId,
      name: TOOL,
      inputSchema: { type: 'object', properties: {} },
      effectClass: 'READ_ONLY',
      approvalRequirement: 'NONE',
      httpBinding: { url: 'https://hooks.example.com/v1/run' },
      actor,
    });
    expect(row.executionEnvironment).toBe('external_gateway');
    expect(row.allowedEgressDomains).toEqual(['hooks.example.com']);
  });

  afterAll(async () => {
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  async function publishedAssistant(
    mode?: string,
  ): Promise<{ assistantId: string; runId: string }> {
    const { assistant } = await assistants.create({
      orgId,
      name: `perim-${randomUUID().slice(0, 8)}`,
      createdBy: actor,
    });
    const draft = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: payloadFor(mode) as never,
      createdBy: actor,
    });
    await assistants.publish({
      orgId,
      assistantId: assistant.id,
      versionId: draft.id,
      publishedBy: actor,
    });
    const conversation = await conversations.createConversation({
      orgId,
      assistantId: assistant.id,
      createdBy: actor,
    });
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conversation.id,
      content: { text: 'perimeter check' },
      idempotencyKey: `idem-${randomUUID()}`,
    });
    return { assistantId: assistant.id, runId: accepted.run_id as string };
  }

  function authorizeInput(runId: string) {
    return {
      orgId,
      runId,
      toolCallId: randomUUID(),
      toolName: TOOL,
      argumentDigest: Buffer.alloc(32, 7),
    };
  }

  it('pins the perimeter into the snapshot binding', async () => {
    const { assistantId } = await publishedAssistant();
    const versions = await assistants.listVersions(orgId, assistantId);
    const published = versions.find((v) => v.status === 'PUBLISHED')!;
    const snapshot = await assistants.getSnapshotForVersion(orgId, assistantId, published.id);
    const bindings = (snapshot?.toolBindings ?? []) as Array<Record<string, unknown>>;
    const binding = bindings.find((b) => b.name === TOOL)!;
    expect(binding).toBeTruthy();
    expect(binding.execution_environment).toBe('external_gateway');
    expect(binding.allowed_egress_domains).toEqual(['hooks.example.com']);
    expect(binding.execution_mode).toBe('live');
  });

  it('authorizes live tools, denies perimeter drift until re-pinned', async () => {
    const { assistantId, runId } = await publishedAssistant();
    const allowed = await authority.authorizeToolCall(authorizeInput(runId));
    expect(allowed.allowed).toBe(true);
    expect(allowed.shadow).toBe(false);

    // Widen the row post-publish (env flip) → drift deny until re-pinned.
    const { sql } = await import('drizzle-orm');
    await db.withBypass(async (tx) => {
      await tx.execute(
        sql`update tool_catalog set execution_environment = 'sandboxed_microvm' where organization_id = ${orgId}::uuid and name = ${TOOL}`,
      );
    });
    const denied = await authority.authorizeToolCall(authorizeInput(runId));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('perimeter drifted since publish');

    // Re-publish re-pins the new perimeter → allowed again. The consumed
    // DRAFT v0 row still exists (publish inserts, never mutates) — discard
    // it first, then draft + publish the same payload.
    const existing = await assistants.listVersions(orgId, assistantId);
    const staleDraft = existing.find((v) => v.status === 'DRAFT')!;
    await assistants.discardDraft({ orgId, assistantId, versionId: staleDraft.id, actorId: actor });
    const redraft = await assistants.createVersion({
      orgId,
      assistantId,
      payload: payloadFor() as never,
      createdBy: actor,
    });
    await assistants.publish({ orgId, assistantId, versionId: redraft.id, publishedBy: actor });
    const conversation = await conversations.createConversation({
      orgId,
      assistantId,
      createdBy: actor,
    });
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conversation.id,
      content: { text: 're-pinned check' },
      idempotencyKey: `idem-${randomUUID()}`,
    });
    const repinned = await authority.authorizeToolCall(authorizeInput(accepted.run_id as string));
    expect(repinned.allowed).toBe(true);
    expect(repinned.shadow).toBe(false);
  });

  it('still refuses byte-identical re-publishes (content + resolved set)', async () => {
    // Joint no-op rule: same content AND same manifest → 409. Guards the P4
    // change (manifest comparison must not swallow the classic no-op case).
    const { assistantId } = await publishedAssistant();
    const existing = await assistants.listVersions(orgId, assistantId);
    const staleDraft = existing.find((v) => v.status === 'DRAFT')!;
    await assistants.discardDraft({ orgId, assistantId, versionId: staleDraft.id, actorId: actor });
    const redraft = await assistants.createVersion({
      orgId,
      assistantId,
      payload: payloadFor() as never,
      createdBy: actor,
    });
    await expect(
      assistants.publish({ orgId, assistantId, versionId: redraft.id, publishedBy: actor }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('reports shadow:true for shadow-mode bindings', async () => {
    const { runId } = await publishedAssistant('shadow');
    const result = await authority.authorizeToolCall(authorizeInput(runId));
    expect(result.allowed).toBe(true);
    expect(result.shadow).toBe(true);
  });
});
