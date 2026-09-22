import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';
import { randomUUID } from 'node:crypto';
import { DbService } from '../src/common/infra/db/db.service';
import { evaluatePublishGate } from '../src/modules/assistants/release-gate';
import { sql } from 'drizzle-orm';

const db = new DbService();
const orgId = randomUUID();
const slug = `rel33-${randomUUID().slice(0, 8)}`;
const hash = `rel33-absent-${randomUUID().slice(0, 8)}`.padEnd(64, '0');

async function main() {
  const { assistantTemplates, assistantInstalls, assistants, assistantVersions } = await import('../src/modules/assistants/schema');

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
    console.log('inserted template', slug);
  });

  const assistantId = randomUUID();
  const versionId = randomUUID();
  await db.withBypass(async (tx) => {
    await tx.insert(assistants).values({ id: assistantId, organizationId: orgId, name: `rel33-${assistantId.slice(0, 8)}` });
    await tx.insert(assistantVersions).values({ id: versionId, assistantId, organizationId: orgId, version: 1, status: 'PUBLISHED', hash, modelPolicy: {}, contextPolicy: {}, toolPolicy: {}, guardrailPolicy: {} });
    await tx.insert(assistantInstalls).values({ organizationId: orgId, slug, templateVersion: '1.0.0', assistantId });
    console.log('inserted assistant', assistantId, 'install');
  });

  const refusal = await db.withOrg(orgId, (tx) => evaluatePublishGate(tx, orgId, assistantId, hash));
  console.log('refusal', refusal);

  await db.withOrg(orgId, async (tx) => {
    const rows = await tx.execute(sql`select t.release_policy from assistant_installs i join assistant_templates t on t.slug = i.slug and t.version = i.template_version where i.assistant_id = ${assistantId}::uuid limit 1`);
    console.log('raw policy rows', rows.rows);
  });

  await db.withBypass(async (tx) => {
    await tx.execute(sql`delete from assistant_installs where assistant_id = ${assistantId}::uuid`);
    await tx.execute(sql`delete from assistant_versions where assistant_id = ${assistantId}::uuid`);
    await tx.execute(sql`delete from assistants where id = ${assistantId}::uuid`);
    await tx.execute(sql`delete from assistant_templates where slug = ${slug}`);
  });
  await db.onModuleDestroy();
}
main().catch(e => { console.error(e); process.exit(1); });
