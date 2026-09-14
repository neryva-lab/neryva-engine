import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * REL-9 F1 integration — invoice derivation from the usage ledger
 * (release_ledger.md REL-9.4 finding F1). Before this, an org whose traffic
 * was purely agent runs received no invoice at all: cycle discovery only
 * read `billing.spend_events`, and no line builder read
 * `usage_ledger_entries`.
 *
 * Covered here, against a real database (db-suites lane):
 * - ledger rows (priced + unpriced-token + pure-count) draft onto the
 *   SAME (org, agents, period) invoice as spend lines, in one TX;
 * - amounts equal sum(coalesce(settled_cost, estimated_cost, 0)) — the same
 *   dollar the quota wall enforces;
 * - money corrections (correct() with costDelta) net the draft;
 * - a redraft for the same period adds nothing (existing-invoice guard);
 * - non-agents products never read the ledger;
 * - pure-count runs markers draft no line and discover no invoice.
 *
 * Audit rows written by the cycle run are append-only by design and are
 * intentionally NOT cleaned (deleting would fork the hash chain).
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

function midPreviousMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
}

describeIfDb('invoice derivation from the usage ledger (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let ledger: import('../../src/modules/billing/usage-ledger.service').UsageLedgerService;
  let credits: import('../../src/modules/billing/billing-credits.service').BillingCreditsService;
  let cycle: import('../../src/modules/billing/billing-cycle.service').BillingCycleService;
  const orgId = randomUUID();
  const countOnlyOrgId = randomUUID();
  const backdatedIso = midPreviousMonthIso();

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { UsageLedgerService } = await import('../../src/modules/billing/usage-ledger.service');
    const { BillingCreditsService } = await import('../../src/modules/billing/billing-credits.service');
    const { BillingCycleService } = await import('../../src/modules/billing/billing-cycle.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    db = new DbService();
    ledger = new UsageLedgerService(db);
    const audit = new AuditService(db);
    credits = new BillingCreditsService(db, audit);
    cycle = new BillingCycleService(db, credits, audit);

    // Priced token usage: 1000 prompt + 500 completion tokens at $0.03.
    await ledger.append({
      orgId,
      usageEventId: `f1-priced-${randomUUID()}`,
      sourceType: 'run',
      runId: randomUUID(),
      usageKind: 'model_tokens',
      unit: 'tokens',
      quantity: 1500,
      provider: 'openai',
      model: 'gpt-4o-mini',
      estimatedCost: 0.03,
      metadata: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    // Unpriced token usage: tokens with no cost — must surface, not vanish.
    await ledger.append({
      orgId,
      usageEventId: `f1-unpriced-${randomUUID()}`,
      sourceType: 'run',
      runId: randomUUID(),
      usageKind: 'model_tokens',
      unit: 'tokens',
      quantity: 200,
      provider: 'anthropic',
      model: 'unlisted-model',
      metadata: { prompt_tokens: 200, completion_tokens: 0 },
    });
    // Pure-count run marker: no money, no tokens — drafts no line.
    await ledger.append({
      orgId,
      usageEventId: `f1-count-${randomUUID()}`,
      sourceType: 'engine',
      runId: randomUUID(),
      usageKind: 'runs',
      unit: 'count',
      quantity: 1,
    });
    // A fully refunded run: priced entry + money correction net to zero.
    const refunded = await ledger.append({
      orgId,
      usageEventId: `f1-refund-${randomUUID()}`,
      sourceType: 'run',
      runId: randomUUID(),
      usageKind: 'model_tokens',
      unit: 'tokens',
      quantity: 100,
      provider: 'openai',
      model: 'gpt-4o-mini',
      estimatedCost: 0.01,
      metadata: { prompt_tokens: 100, completion_tokens: 0 },
    });
    await ledger.correct({ orgId, originalEntryId: refunded.entry.id, reason: 'f1 fixture refund', actor: 'f1-test', costDelta: -0.01 });
    // Runs-only org: must discover NO invoice.
    await ledger.append({
      orgId: countOnlyOrgId,
      usageEventId: `f1-countonly-${randomUUID()}`,
      sourceType: 'engine',
      runId: randomUUID(),
      usageKind: 'runs',
      unit: 'count',
      quantity: 1,
    });
    // Backdate every fixture row into the previous calendar month.
    await db.withBypass((tx) =>
      tx.execute(sql`update usage_ledger_entries set created_at = ${backdatedIso}::timestamptz
                     where organization_id in (${orgId}::uuid, ${countOnlyOrgId}::uuid)`),
    );
  });

  afterAll(async () => {
    const { billingInvoiceLines } = await import('../../src/modules/billing/billing-extension.schema');
    const { billingInvoices } = await import('../../src/modules/billing/schema');
    await db.withBypass(async (tx) => {
      const invoices = await tx
        .select({ id: billingInvoices.id })
        .from(billingInvoices)
        .where(sql`${billingInvoices.orgId} in (${orgId}, ${countOnlyOrgId})`);
      for (const invoice of invoices) {
        await tx.delete(billingInvoiceLines).where(sql`${billingInvoiceLines.invoiceId} = ${invoice.id}`);
      }
      await tx.delete(billingInvoices).where(sql`${billingInvoices.orgId} in (${orgId}, ${countOnlyOrgId})`);
      await tx.execute(sql`delete from usage_ledger_entries where organization_id in (${orgId}::uuid, ${countOnlyOrgId}::uuid)`);
    });
    await db.onModuleDestroy();
  });

  it('drafts ledger lines onto the agents invoice with quota-consistent amounts', async () => {
    const result = await cycle.runForPreviousMonth();
    expect(result.drafted).toBeGreaterThanOrEqual(1);

    const { billingInvoices } = await import('../../src/modules/billing/schema');
    const { billingInvoiceLines } = await import('../../src/modules/billing/billing-extension.schema');
    const invoices = await db.withBypass((tx) =>
      tx.select().from(billingInvoices).where(sql`${billingInvoices.orgId} = ${orgId} and ${billingInvoices.product} = 'agents'`),
    );
    expect(invoices).toHaveLength(1);
    // $0.03 priced + $0.00 unpriced-tokens + $0.01 refunded-then-corrected = $0.03.
    expect(invoices[0].totalUsd).toBe('0.03');

    const lines = await db.withBypass((tx) =>
      tx.select().from(billingInvoiceLines).where(sql`${billingInvoiceLines.invoiceId} = ${invoices[0].id}`),
    );
    const kinds = lines.map((line) => line.kind).sort();
    // Two groups: the openai model_tokens group (priced row + refunded row +
    // its money correction net inside the group) and the unpriced-tokens
    // group. The pure-count marker drafts no line.
    expect(kinds).toEqual(['usage:model_tokens', 'usage:model_tokens']);
    const priced = lines.find((line) => line.model === 'gpt-4o-mini' && line.amountUsd === '0.030000');
    expect(priced).toBeDefined();
    expect(priced?.tokensIn).toBe(1100);
    expect(priced?.tokensOut).toBe(500);
    expect(priced?.events).toBe(3);
    expect(priced?.unitPriceNote).toContain('openai');
    const unpriced = lines.find((line) => line.model === 'unlisted-model');
    expect(unpriced?.amountUsd).toBe('0.000000');
    expect(unpriced?.tokensIn).toBe(200);
  });

  it('a redraft for the same period adds nothing (existing-invoice guard)', async () => {
    const { billingInvoices } = await import('../../src/modules/billing/schema');
    const { billingInvoiceLines } = await import('../../src/modules/billing/billing-extension.schema');
    await cycle.runForPreviousMonth();
    const invoices = await db.withBypass((tx) =>
      tx.select().from(billingInvoices).where(sql`${billingInvoices.orgId} = ${orgId} and ${billingInvoices.product} = 'agents'`),
    );
    expect(invoices).toHaveLength(1);
    const lines = await db.withBypass((tx) =>
      tx.select().from(billingInvoiceLines).where(sql`${billingInvoiceLines.invoiceId} = ${invoices[0].id}`),
    );
    expect(lines).toHaveLength(2);
  });

  it('non-agents products never read the ledger', async () => {
    const lines = await db.withOrg(orgId, (tx) =>
      credits.buildUsageLedgerLineItems(tx, orgId, 'deployment', backdatedIso, new Date().toISOString(), randomUUID()),
    );
    expect(lines).toBe(0);
  });

  it('a runs-only org discovers no invoice', async () => {
    const { billingInvoices } = await import('../../src/modules/billing/schema');
    const invoices = await db.withBypass((tx) =>
      tx.select().from(billingInvoices).where(sql`${billingInvoices.orgId} = ${countOnlyOrgId}`),
    );
    expect(invoices).toHaveLength(0);
  });
});
