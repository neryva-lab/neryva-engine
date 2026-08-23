import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EntitlementState } from '../../common/auth/ports';
import { productEntitlements } from './schema';

/**
 * The platform-owned entitlement state machine (O-2). Products read state;
 * only billing events move it. Every transition is validated against the
 * explicit table below and audited as `entitlement.transitioned`.
 *
 * Dense pass (eng-0009): seats + source travel with the state; console
 * trial starts (owner/billing per the access-model) are the ONE non-billing
 * writer, tagged source=console.trial so the audit distinguishes them; and
 * effective limits resolve row-limits over the product's plan catalog.
 */
export const TRANSITIONS: Record<string, readonly string[]> = {
  none: ['trial', 'active'],
  trial: ['active', 'past_due', 'suspended', 'expired'],
  active: ['past_due', 'suspended', 'expired'],
  past_due: ['active', 'suspended', 'expired'],
  suspended: ['active', 'expired'],
  expired: ['active'], // renewal
};

export type TransitionSource = 'console.trial' | 'billing.payment' | 'billing.dunning' | 'billing.admin' | 'org.deletion';

export interface EntitlementView {
  id: string;
  product: string;
  plan: string;
  status: EntitlementState;
  limits: Record<string, unknown>;
  seats: number | null;
  source: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  updatedAt: string;
  /** Milliseconds until period end (trials render "days left"); null when open-ended. */
  msRemaining: number | null;
}

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

  async listForOrg(orgId: string): Promise<EntitlementView[]> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(productEntitlements).where(eq(productEntitlements.orgId, orgId)));
    return rows.map(toView);
  }

  async getFor(orgId: string, product: string): Promise<EntitlementView | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(productEntitlements).where(and(eq(productEntitlements.orgId, orgId), eq(productEntitlements.product, product))).limit(1),
    );
    return rows[0] ? toView(rows[0]) : null;
  }

  /**
   * Start a console trial (access-model: the [Start trial] CTA, owner/billing
   * only). One trial per (org, product) — a second attempt is a 409, not a
   * silent extension; extending trials is a billing-side act.
   */
  async startTrial(input: { orgId: string; product: string; days?: number; actorId: string }): Promise<EntitlementView> {
    const current = await this.getState(input.orgId, input.product);
    if (current !== 'none') {
      throw ApiError.conflict(`product "${input.product}" already has an entitlement (state: ${current}) — trials start once`);
    }
    const days = Math.min(Math.max(Math.floor(input.days ?? env.ORG_TRIAL_DEFAULT_DAYS), 1), 90);
    const start = new Date();
    const end = new Date(start.getTime() + days * 86_400_000);
    return this.transition({
      orgId: input.orgId,
      product: input.product,
      target: 'trial',
      plan: 'trial',
      period: { start: start.toISOString(), end: end.toISOString() },
      source: 'console.trial',
      actorId: input.actorId,
    });
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
    seats?: number | null;
    period?: { start: string; end: string };
    source?: TransitionSource | string;
    actorId: string;
  }): Promise<EntitlementView> {
    const current = await this.getState(input.orgId, input.product);
    if (current === 'none') {
      if (input.target !== 'trial' && input.target !== 'active') {
        throw ApiError.conflict(`cannot move a product with no entitlement to ${input.target}`);
      }
    } else if (!TRANSITIONS[current].includes(input.target)) {
      throw ApiError.conflict(`invalid entitlement transition ${current} -> ${input.target}`);
    }
    if (input.seats !== undefined && input.seats !== null && (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > 100_000)) {
      throw ApiError.validation({ seats: 'must be a positive integer' });
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
    await this.audit.add({
      action: 'entitlement.transitioned',
      resourceType: 'product_entitlement',
      resourceId: upserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: input.product,
      details: { from: current, to: input.target, plan: upserted[0].plan, ...(input.source ? { source: input.source } : {}) },
    });
    await this.events.emit(EngineEvents.EntitlementTransitioned, {
      orgId: input.orgId,
      product: input.product,
      from: current,
      to: input.target,
    });
    return toView(upserted[0]);
  }

  /**
   * Effective limits for a (org, product): the entitlement row's limits,
   * with status-aware overlays so callers never re-derive policy:
   *   trial          → { trial: true, period_end }
   *   past_due       → { read_only: true }
   *   suspended      → { read_only: true }
   *   expired/none   → { entitled: false }
   */
  async effectiveLimits(orgId: string, product: string): Promise<Record<string, unknown>> {
    const row = await this.getFor(orgId, product);
    if (!row) {
      return { entitled: false };
    }
    const base: Record<string, unknown> = { entitled: true, status: row.status, plan: row.plan, limits: row.limits, ...(row.seats !== null ? { seats: row.seats } : {}) };
    if (row.status === 'trial') {
      base.trial = true;
      if (row.periodEnd) {
        base.period_end = row.periodEnd;
        base.ms_remaining = row.msRemaining;
      }
    }
    if (row.status === 'past_due' || row.status === 'suspended') {
      base.read_only = true;
    }
    if (row.status === 'expired') {
      base.entitled = false;
    }
    return base;
  }
}

function toView(row: typeof productEntitlements.$inferSelect): EntitlementView {
  return {
    id: row.id,
    product: row.product,
    plan: row.plan,
    status: row.status as EntitlementState,
    limits: (row.limits ?? {}) as Record<string, unknown>,
    seats: row.seats ?? null,
    source: row.source ?? null,
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    updatedAt: row.updatedAt,
    msRemaining: row.periodEnd ? Math.max(0, Date.parse(row.periodEnd) - Date.now()) : null,
  };
}
