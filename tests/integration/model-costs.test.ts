import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * G6 console price visibility (customer-setup-review.md): listActivePoints
 * returns the latest effective unretired point per provider/model —
 * future-dated points are not prices yet, retired points never price.
 * db-suites lane.
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

describeIfDb('model cost active points (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let costs: import('../../src/modules/assistants/model-cost.service').ModelCostService;
  const provider = `probe-${randomUUID().slice(0, 8)}`;
  const model = 'probe-model';

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { ModelCostService } = await import('../../src/modules/assistants/model-cost.service');
    db = new DbService();
    costs = new ModelCostService(db, new AuditService(db));
    const { modelCostEntries } = await import('../../src/modules/assistants/model-cost.schema');
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await db.withBypass((tx) =>
      tx.insert(modelCostEntries).values([
        { id: randomUUID(), provider, model, costMicrosPer1kInput: 100, costMicrosPer1kOutput: 200, currency: 'USD', effectiveFrom: past, createdBy: 'g6-test' },
        { id: randomUUID(), provider, model, costMicrosPer1kInput: 150, costMicrosPer1kOutput: 250, currency: 'USD', effectiveFrom: future, createdBy: 'g6-test' },
        { id: randomUUID(), provider, model: `${model}-retired`, costMicrosPer1kInput: 1, costMicrosPer1kOutput: 1, currency: 'USD', effectiveFrom: past, retiredAt: past, createdBy: 'g6-test' },
      ]),
    );
  });

  afterAll(async () => {
    await db.withBypass((tx) => tx.execute(sql`delete from model_cost_entries where provider = ${provider}`));
    await db.onModuleDestroy();
  });

  it('returns the latest effective unretired point only', async () => {
    const rows = await costs.listActivePoints();
    const ours = rows.filter((r) => r.provider === provider);
    // Future-dated + retired rows excluded; only the past effective point remains.
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ provider, model, costMicrosPer1kInput: 100, costMicrosPer1kOutput: 200, currency: 'USD' });
  });
});
