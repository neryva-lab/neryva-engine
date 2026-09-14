import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * REL-4.6 quota property tests (release_ledger.md) — the reservation layer
 * against a real database (db-suites lane):
 * - concurrent reserves at the exact boundary admit exactly one winner
 *   (the transaction-scoped advisory lock serializes the check);
 * - commit/release are exactly-once in every order, including after expiry;
 * - lapsed reservations reap and can never commit afterwards;
 * - one org's full dimension never blocks another org;
 * - trial expiry moves status without touching caps (limits govern, status
 *   doesn't), and the sweep is idempotent.
 *
 * Deliberately NOT asserted here: reference-based redelivery dedup does not
 * exist at this layer — two reserves with the same reference both succeed
 * while headroom remains. Redelivery safety belongs to the caller's
 * transaction idempotency (the start-message TX claims one run per message),
 * and this test locks that layering in so nobody assumes otherwise.
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

describeIfDb('quota reservation properties (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let ledger: import('../../src/modules/billing/usage-ledger.service').UsageLedgerService;
  let entitlements: import('../../src/modules/organizations/entitlements.service').EntitlementsService;
  let sweep: import('../../src/modules/billing/trial-expiry.service').TrialExpiryService;
  const orgId = randomUUID();
  const orgB = randomUUID();
  const trialOrg = randomUUID();

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { UsageLedgerService } = await import('../../src/modules/billing/usage-ledger.service');
    const { EntitlementsService } = await import('../../src/modules/organizations/entitlements.service');
    const { TrialExpiryService } = await import('../../src/modules/billing/trial-expiry.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { EventBus } = await import('../../src/common/events/event-bus');
    db = new DbService();
    ledger = new UsageLedgerService(db);
    const audit = new AuditService(db);
    const events = new EventBus();
    entitlements = new EntitlementsService(db, audit, events);
    sweep = new TrialExpiryService(db, entitlements, events);
  });

  afterAll(async () => {
    await db.withBypass(async (tx) => {
      for (const org of [orgId, orgB, trialOrg]) {
        await tx.execute(sql`delete from quota_reservations where organization_id = ${org}::uuid`);
        await tx.execute(sql`delete from product_entitlements where org_id = ${org}`);
      }
    });
    await db.onModuleDestroy();
  });

  it('concurrent reserves at the boundary admit exactly one winner', async () => {
    const dimension = `race-${randomUUID().slice(0, 8)}`;
    const attempts = await Promise.allSettled([
      ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 9, limit: 10, reference: 'race-1' }),
      ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 9, limit: 10, reference: 'race-2' }),
    ]);
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
  });

  it('the boundary itself is deterministic: exactly-at-limit passes, one-over fails', async () => {
    const dimension = `edge-${randomUUID().slice(0, 8)}`;
    await ledger.reserve({ orgId, dimension, quantity: 2, currentUsage: 8, limit: 10, reference: 'edge-ok' });
    await expect(
      ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 8, limit: 10, reference: 'edge-over' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('same-reference redelivery is NOT deduped here (caller TX owns it)', async () => {
    const dimension = `redeliver-${randomUUID().slice(0, 8)}`;
    const first = await ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 0, limit: 100, reference: 'same-ref' });
    const second = await ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 0, limit: 100, reference: 'same-ref' });
    expect(first.id).not.toBe(second.id);
  });

  it('commit/release are exactly-once in every order', async () => {
    const dimension = `once-${randomUUID().slice(0, 8)}`;
    const committed = await ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 0, limit: 10, reference: 'commit-me' });
    await ledger.commit(committed.id);
    await expect(ledger.commit(committed.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(ledger.release(committed.id)).rejects.toMatchObject({ code: 'conflict' });

    const released = await ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 0, limit: 10, reference: 'release-me' });
    await ledger.release(released.id);
    await expect(ledger.release(released.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(ledger.commit(released.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lapsed reservations reap and can never commit afterwards', async () => {
    const dimension = `lapse-${randomUUID().slice(0, 8)}`;
    const reservation = await ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 0, limit: 10, reference: 'lapse-me', ttlSeconds: 0 });
    // No count assertion: expireLapsed reaps globally, and a parallel suite
    // may reap this row first — either way the row ends EXPIRED, which is
    // what the conflict assertions below pin.
    await ledger.expireLapsed();
    await expect(ledger.commit(reservation.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(ledger.release(reservation.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a full dimension in one org never blocks another org', async () => {
    const dimension = `shared-${randomUUID().slice(0, 8)}`;
    await ledger.reserve({ orgId, dimension, quantity: 10, currentUsage: 0, limit: 10, reference: 'fill-a' });
    await expect(
      ledger.reserve({ orgId, dimension, quantity: 1, currentUsage: 0, limit: 10, reference: 'over-a' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const other = await ledger.reserve({ orgId: orgB, dimension, quantity: 1, currentUsage: 0, limit: 10, reference: 'fill-b' });
    expect(other.state).toBe('RESERVED');
  });

  it('trial expiry moves status without touching caps, and the sweep is idempotent', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await entitlements.transition({
      orgId: trialOrg,
      product: 'agents',
      target: 'trial',
      plan: 'trial',
      limits: { monthly_spend_usd: 50, monthly_events: 100 },
      period: { start: new Date(Date.now() - 30 * 86_400_000).toISOString(), end: past },
      source: 'console.trial',
      actorId: 'rel46-test',
    });
    const first = await sweep.sweep();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(await entitlements.getState(trialOrg, 'agents')).toBe('expired');

    // Caps survive expiry: the wall reads limits, never status.
    const rows = await entitlements.listForOrg(trialOrg);
    const agents = rows.find((row) => row.product === 'agents');
    expect(agents?.limits).toMatchObject({ monthly_spend_usd: 50, monthly_events: 100 });

    const second = await sweep.sweep();
    expect(second.expired).toBe(0);
  });
});
