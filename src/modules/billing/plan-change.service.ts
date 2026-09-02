import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { EntitlementView, EntitlementsService, TransitionSource } from '../organizations/entitlements.service';
import { BillingCreditsService } from './billing-credits.service';
import { STUDIO_PLANS, StudioPlan } from '../studio-furniture/plans';

/**
 * The plan-change path (H-4): the one billing-side writer that swaps an
 * entitlement's plan (and the plan's limits) without touching the status
 * machine more than the transition table demands. Plan catalogs are code
 * per product (the agent-studio pattern — plans.ts); this service resolves
 * the target plan against the catalog registry, prices the proration as a
 * single signed adjustment on the ledger (credit note for a downgrade,
 * debit note for an upgrade, pro-rated by the remaining period fraction),
 * and moves the row through EntitlementsService.transition so validation,
 * audit and the state machine stay platform-owned. A `billing.plan_changed`
 * event lands on the bus for notification/webhook sinks.
 */
const PLAN_CATALOGS: Record<string, Record<string, StudioPlan>> = {
  agent_studio: STUDIO_PLANS,
};

export interface PlanChangeResult {
  entitlement: EntitlementView;
  adjustment: Record<string, unknown> | null;
}

@Injectable()
export class PlanChangeService {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly credits: BillingCreditsService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async changePlan(input: { orgId: string; product: string; targetPlan: string; actorId: string }): Promise<PlanChangeResult> {
    const catalog = PLAN_CATALOGS[input.product];
    if (!catalog) {
      throw ApiError.validation({ product: `product "${input.product}" has no plan catalog` });
    }
    const target = catalog[input.targetPlan];
    if (!target) {
      throw ApiError.validation({ plan: `plan "${input.targetPlan}" does not exist for product "${input.product}"` });
    }

    const current = await this.entitlements.getFor(input.orgId, input.product);
    if (!current) {
      throw ApiError.notFound(`entitlement for product "${input.product}"`);
    }
    if (current.status === 'past_due' || current.status === 'suspended') {
      throw ApiError.pastDue(input.product);
    }
    const currentPlan = catalog[current.plan];
    if (current.plan === input.targetPlan) {
      return { entitlement: current, adjustment: null }; // idempotent no-op
    }

    const adjustment = await this.recordProration(input, currentPlan ?? null, target, current);

    // Status-preserving when trial/active; recovery states ride their renewal
    // edges (past_due/suspended/expired → active), which the table allows.
    const targetState = current.status === 'trial' ? 'trial' : 'active';
    const source: TransitionSource = 'billing.admin';
    const entitlement = await this.entitlements.transition({
      orgId: input.orgId,
      product: input.product,
      target: targetState,
      plan: target.plan,
      limits: target.limits as unknown as Record<string, unknown>,
      ...(current.status !== 'trial' ? { period: { start: new Date().toISOString(), end: monthFromNow() } } : {}),
      source,
      actorId: input.actorId,
    });

    await this.audit.add({
      action: 'billing.plan_changed',
      resourceType: 'product_entitlement',
      resourceId: entitlement.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: input.product,
      details: {
        from_plan: current.plan,
        to_plan: target.plan,
        proration_usd: adjustment ? String((adjustment as { amount_usd: string }).amount_usd) : '0',
        adjustment_id: adjustment ? String((adjustment as { id: string }).id) : null,
      },
    });
    await this.events.emit(EngineEvents.BillingPlanChanged, {
      orgId: input.orgId,
      product: input.product,
      fromPlan: current.plan,
      toPlan: target.plan,
    });
    return { entitlement, adjustment };
  }

  /**
   * Simple proration: one signed adjustment for (price delta × remaining
   * period fraction), consumed by the next invoice draft like any other
   * note. Unpriced plans (either side null) skip it — contract plans settle
   * outside self-serve.
   */
  private async recordProration(
    input: { orgId: string; product: string; actorId: string },
    currentPlan: StudioPlan | null,
    target: StudioPlan,
    current: EntitlementView,
  ): Promise<Record<string, unknown> | null> {
    const fromPrice = currentPlan?.monthlyPriceUsd ?? null;
    const toPrice = target.monthlyPriceUsd;
    if (fromPrice === null || toPrice === null || !current.periodStart || !current.periodEnd) {
      return null;
    }
    const start = Date.parse(current.periodStart);
    const end = Date.parse(current.periodEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    const remaining = Math.min(Math.max((end - Date.now()) / (end - start), 0), 1);
    const deltaUsd = Math.round((toPrice - fromPrice) * remaining * 100) / 100;
    if (Math.abs(deltaUsd) < 0.01) {
      return null;
    }
    return this.credits.createAdjustment({
      orgId: input.orgId,
      product: input.product,
      kind: deltaUsd > 0 ? 'debit_note' : 'credit_note',
      amountUsd: deltaUsd,
      reason: `plan change ${currentPlan!.plan} -> ${target.plan} (prorated ${(remaining * 100).toFixed(1)}% of period)`,
      createdBy: input.actorId,
    });
  }
}

function monthFromNow(): string {
  return new Date(Date.now() + 30 * 86_400_000).toISOString();
}
