import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { productEntitlements } from '../schema';
import type { EntitlementRow, IEntitlementRepository } from './entitlement.repository';

/**
 * PostgreSQL implementation of `IEntitlementRepository` (P3).
 *
 * Mechanical move of the `EntitlementsService` persistence units: every
 * method owns its transaction via `DbService.withOrg`, runs all reads/writes
 * inside it, and commits or rolls back as one. No transaction handle leaks
 * through this interface. `ApiError` throws are preserved inside the repo
 * (the upsert path has no error mapping — the unique (org, product) index
 * only fires on races the service's read-then-upsert already serialized).
 *
 * What stays OUT (still the caller's job): transition validation, trial
 * gating, audit writes, event emission, effective-limits overlays.
 */
export class PgEntitlementRepository implements IEntitlementRepository {
  constructor(private readonly db: DbService) {}

  /** Raw row read; the service maps a miss to the virtual `none` state. */
  async getEntitlement(orgId: string, product: string): Promise<EntitlementRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(productEntitlements)
        .where(and(eq(productEntitlements.orgId, orgId), eq(productEntitlements.product, product)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** All entitlement rows for the org. */
  async listEntitlements(orgId: string): Promise<EntitlementRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(productEntitlements).where(eq(productEntitlements.orgId, orgId)),
    );
  }

  /**
   * The write half of the service's read-then-upsert `transition` (the
   * service performs the read via `getEntitlement` first — the two-step
   * shape is preserved, not merged into a single upsert).
   */
  async upsertEntitlement(input: {
    orgId: string;
    product: string;
    target: 'trial' | 'active' | 'past_due' | 'suspended' | 'expired';
    plan?: string;
    limits?: Record<string, unknown>;
    seats?: number | null;
    period?: { start: string; end: string };
    source?: string;
  }): Promise<EntitlementRow> {
    const now = new Date().toISOString();
    const upserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(productEntitlements)
        .values({
          orgId: input.orgId,
          product: input.product,
          plan: input.plan ?? 'default',
          status: input.target,
          limits: input.limits ?? {},
          ...(input.seats !== undefined ? { seats: input.seats } : {}),
          ...(input.source ? { source: input.source } : {}),
          periodStart: input.period?.start ?? null,
          periodEnd: input.period?.end ?? null,
        })
        .onConflictDoUpdate({
          target: [productEntitlements.orgId, productEntitlements.product],
          set: {
            status: input.target,
            ...(input.plan ? { plan: input.plan } : {}),
            ...(input.limits ? { limits: input.limits } : {}),
            ...(input.seats !== undefined ? { seats: input.seats } : {}),
            ...(input.source ? { source: input.source } : {}),
            ...(input.period ? { periodStart: input.period.start, periodEnd: input.period.end } : {}),
            updatedAt: now,
          },
        })
        .returning(),
    );
    return upserted[0];
  }
}
