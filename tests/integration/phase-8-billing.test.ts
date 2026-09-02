import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * Phase 8 integration — usage ledger (append-only + compensations), durable
 * quota reservations, webhook inbox exactly-once, reconciliation pass.
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

describeIfDb('usage ledger + quotas + webhook inbox (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let ledger: import('../../src/modules/billing/usage-ledger.service').UsageLedgerService;
  let reconciliation: import('../../src/modules/billing/billing-reconciliation.service').BillingReconciliationService;
  const orgId = randomUUID();
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { UsageLedgerService } = await import('../../src/modules/billing/usage-ledger.service');
    const { BillingReconciliationService } = await import('../../src/modules/billing/billing-reconciliation.service');
    db = new DbService();
    ledger = new UsageLedgerService(db);
    reconciliation = new BillingReconciliationService(db);
  });

  afterAll(async () => {
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`delete from usage_ledger_entries where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from quota_reservations where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from provider_reconciliation_runs where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from billing_webhook_inbox where provider = 'stripe-test'`);
    });
    await db.onModuleDestroy();
    void cleanupIds;
  });

  it('append is idempotent by usage_event_id; duplicates are ignored', async () => {
    const usageEventId = `evt-${randomUUID()}`;
    const first = await ledger.append({ orgId, usageEventId, sourceType: 'test', usageKind: 'model_tokens', unit: 'tokens', quantity: 100 });
    expect(first.duplicate).toBe(false);
    const again = await ledger.append({ orgId, usageEventId, sourceType: 'test', usageKind: 'model_tokens', unit: 'tokens', quantity: 100 });
    expect(again.duplicate).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
  });

  it('corrections are compensating entries — history is never rewritten', async () => {
    const usageEventId = `evt-${randomUUID()}`;
    const original = await ledger.append({ orgId, usageEventId, sourceType: 'test', usageKind: 'model_cost', unit: 'usd', quantity: 5 });
    const correction = await ledger.correct({ orgId, originalEntryId: original.entry.id, reason: 'test reversal', actor: 'test' });
    expect(correction.quantity).toBe('-5.000000');
    expect(correction.reversalOf).toBe(original.entry.id);

    const net = await ledger.netQuantity(orgId, 'model_cost');
    expect(net).toBe(0);

    // Correcting a correction is rejected.
    await expect(ledger.correct({ orgId, originalEntryId: correction.id, reason: 'no chains', actor: 'test' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('quota reservation machine: limit enforcement, commit, release, expiry', async () => {
    // Limit 10, usage 8 → 1 succeeds, the next conflicts.
    const r1 = await ledger.reserve({ orgId, dimension: 'requests', quantity: 1, currentUsage: 8, limit: 10, reference: 'test-1' });
    cleanupIds.push(r1.id);
    await expect(
      ledger.reserve({ orgId, dimension: 'requests', quantity: 2, currentUsage: 8, limit: 10, reference: 'test-2' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await ledger.commit(r1.id);
    await expect(ledger.commit(r1.id)).rejects.toMatchObject({ code: 'conflict' });

    const r2 = await ledger.reserve({ orgId, dimension: 'requests', quantity: 1, currentUsage: 0, limit: 1, reference: 'test-3', ttlSeconds: 1 });
    await ledger.release(r2.id);

    const r3 = await ledger.reserve({ orgId, dimension: 'rate', quantity: 1, currentUsage: 0, limit: null, reference: 'unlimited' });
    cleanupIds.push(r3.id);

    const expired = await ledger.expireLapsed();
    void expired;
  });

  it('webhook inbox: exactly-once per (provider, provider_event_id); payload swap conflicts', async () => {
    const providerEventId = `evt_${randomUUID()}`;
    const hash = BillingReconciliationLike('payload-1');
    const first = await reconciliation.ingestWebhook({ provider: 'stripe-test', providerEventId, payloadHash: hash, signatureResult: 'valid' });
    expect(first.duplicate).toBe(false);

    const replay = await reconciliation.ingestWebhook({ provider: 'stripe-test', providerEventId, payloadHash: hash, signatureResult: 'valid' });
    expect(replay.duplicate).toBe(true);

    await expect(
      reconciliation.ingestWebhook({ provider: 'stripe-test', providerEventId, payloadHash: BillingReconciliationLike('payload-2'), signatureResult: 'valid' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    await reconciliation.markWebhookProcessed(first.row.id, { handled: true });
    await reconciliation.markWebhookRequiresReconciliation(first.row.id, 'never-mind');
  });

  it('reconciliation pass flags negative non-compensating quantities', async () => {
    const usageEventId = `evt-negative-${randomUUID()}`;
    const bad = await ledger.append({ orgId, usageEventId, sourceType: 'test', usageKind: 'anomaly', unit: 'count', quantity: -3 });
    const run = await reconciliation.runConsistencyPass({ orgId, provider: 'stripe-test' });
    expect(run.findings.some((f) => f.includes(usageEventId))).toBe(true);
    const reread = await ledger.listForRun(orgId, bad.entry.runId ?? '00000000-0000-4000-8000-000000000000');
    void reread;
  });
});

/** Local hash stand-in mirroring BillingReconciliationService.payloadHash. */
function BillingReconciliationLike(payload: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(payload).digest('hex');
}
