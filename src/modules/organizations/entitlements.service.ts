import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { EntitlementState } from '../../common/auth/ports';
import { productEntitlements } from './schema';

/**
 * The platform-owned entitlement state machine (O-2). Products read state;
 * only billing events move it. Every transition is validated against the
 * explicit table below and audited as `entitlement.transitioned`.
 */
export const TRANSITIONS: Record<string, readonly string[]> = {
  none: ['trial', 'active'],
  trial: ['active', 'past_due', 'suspended', 'expired'],
  active: ['past_due', 'suspended', 'expired'],
  past_due: ['active', 'suspended', 'expired'],
  suspended: ['active', 'expired'],
  expired: ['active'], // renewal
};

@Injectable()
export class EntitlementsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async getState(orgId: string, product: string): Promise<EntitlementState> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ status: productEntitlements.status })
        .from(productEntitlements)
        .where(and(eq(productEntitlements.orgId, orgId), eq(productEntitlements.product, product)))
        .limit(1),
    );
    return (rows[0]?.status as EntitlementState) ?? 'none';
  }

  async listForOrg(orgId: string): Promise<Array<typeof productEntitlements.$inferSelect>> {
    return this.db.withOrg(orgId, (tx) => tx.select().from(productEntitlements).where(eq(productEntitlements.orgId, orgId)));
  }

  /**
   * Move an entitlement to `target` (billing-event driven). Returns the row.
   * `none` is virtual — reaching it means the row's state is deleted, which
   * no billing event does; the table starts at trial or active.
   */
  async transition(input: {
    orgId: string;
    product: string;
    target: Exclude<EntitlementState, 'none'>;
    plan?: string;
    limits?: Record<string, unknown>;
    period?: { start: string; end: string };
    actorId: string;
  }): Promise<typeof productEntitlements.$inferSelect> {
    const current = await this.getState(input.orgId, input.product);
    if (current === 'none') {
      if (input.target !== 'trial' && input.target !== 'active') {
        throw ApiError.conflict(`cannot move a product with no entitlement to ${input.target}`);
      }
    } else if (!TRANSITIONS[current].includes(input.target)) {
      throw ApiError.conflict(`invalid entitlement transition ${current} -> ${input.target}`);
    }

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
          periodStart: input.period?.start ?? null,
          periodEnd: input.period?.end ?? null,
        })
        .onConflictDoUpdate({
          target: [productEntitlements.orgId, productEntitlements.product],
          set: {
            status: input.target,
            ...(input.plan ? { plan: input.plan } : {}),
            ...(input.limits ? { limits: input.limits } : {}),
            ...(input.period ? { periodStart: input.period.start, periodEnd: input.period.end } : {}),
            updatedAt: now,
          },
        })
        .returning(),
    );
    await this.audit.add({
      action: 'entitlement.transitioned',
      resourceType: 'product_entitlement',
      resourceId: upserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: input.product,
      details: { from: current, to: input.target, plan: upserted[0].plan },
    });
    await this.events.emit(EngineEvents.EntitlementTransitioned, {
      orgId: input.orgId,
      product: input.product,
      from: current,
      to: input.target,
    });
    return upserted[0];
  }
}
