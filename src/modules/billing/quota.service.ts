import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/infra/redis.service';
import { EntitlementsService } from '../organizations/entitlements.service';

/**
 * The engine quota plane with the product + project levels (B-1, partitioning
 * P-2): the full hierarchy is
 *
 *   platform > tenant(org) > product > project > surface > end_user
 *
 * The engine enforces the product and project levels during the strangler
 * window; the runtime keeps enforcing platform/tenant/surface/end_user until
 * the A-3 handover moves quota authority wholesale. Unset levels = current
 * behavior (no cap) — the parity rule from the B-1 gate.
 *
 * Limits live on the entitlement row's `limits` jsonb (set by plan catalogs
 * and billing events): `monthly_spend_usd`, `monthly_events`. A missing key
 * means unlimited at that level — capping is always an explicit plan choice.
 *
 * Counters are Redis monthly windows; the reserve path is an atomic Lua
 * check-and-increment across BOTH relevant buckets (product and project) so
 * concurrent reservations can never overshoot either limit. Redis-down ⇒
 * fail-open with a loud log: quota is not an auth boundary, and the spend
 * ledger (billing.spend_events) remains the source of truth for billing.
 */
export interface QuotaLimits {
  monthlySpendUsd: number | null;
  monthlyEvents: number | null;
}

export interface QuotaReservation {
  orgId: string;
  product: string;
  projectId?: string | null;
  estimatedCostUsd?: number;
  units?: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason: string | null;
  product: { limit_usd: number | null; used_usd: number; limit_events: number | null; used_events: number };
  project: { limit_usd: number | null; used_usd: number; limit_events: number | null; used_events: number } | null;
}

/** Atomic check-and-increment across up to two monthly buckets.
 * KEYS: product cost, product events, project cost (or '' placeholder), project events (or '')
 * ARGV: costDelta, eventDelta, productCostLimit (-1 = none), productEventLimit,
 *       projectCostLimit, projectEventLimit, windowSeconds */
const RESERVE_LUA = `
local pcost = tonumber(redis.call('GET', KEYS[1]) or '0')
local pev = tonumber(redis.call('GET', KEYS[2]) or '0')
local pcLimit = tonumber(ARGV[3])
local peLimit = tonumber(ARGV[4])
if pcLimit >= 0 and pcost + tonumber(ARGV[1]) > pcLimit then return {0, 'product_spend'} end
if peLimit >= 0 and pev + tonumber(ARGV[2]) > peLimit then return {0, 'product_events'} end
if KEYS[3] ~= '' then
  local jcost = tonumber(redis.call('GET', KEYS[3]) or '0')
  local jev = tonumber(redis.call('GET', KEYS[4]) or '0')
  if tonumber(ARGV[5]) >= 0 and jcost + tonumber(ARGV[1]) > tonumber(ARGV[5]) then return {0, 'project_spend'} end
  if tonumber(ARGV[6]) >= 0 and jev + tonumber(ARGV[2]) > tonumber(ARGV[6]) then return {0, 'project_events'} end
  redis.call('INCRBYFLOAT', KEYS[3], tonumber(ARGV[1]))
  redis.call('INCRBY', KEYS[4], tonumber(ARGV[2]))
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[7]))
  redis.call('EXPIRE', KEYS[4], tonumber(ARGV[7]))
end
redis.call('INCRBYFLOAT', KEYS[1], tonumber(ARGV[1]))
redis.call('INCRBY', KEYS[2], tonumber(ARGV[2]))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
return {1, ''}
`;

@Injectable()
export class QuotaService {
  private static readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Limits for (org, product) from the entitlement row; null = unlimited. */
  async limitsFor(orgId: string, product: string): Promise<QuotaLimits> {
    const rows = await this.entitlements.listForOrg(orgId);
    const row = rows.find((r) => r.product === product);
    if (!row) {
      // No entitlement row: no plan, no plan limits (the entitlement GUARD is
      // what blocks unentitled usage — quota is a plan-cap concern).
      return { monthlySpendUsd: null, monthlyEvents: null };
    }
    const limits = (row.limits ?? {}) as Record<string, unknown>;
    return {
      monthlySpendUsd: typeof limits.monthly_spend_usd === 'number' ? limits.monthly_spend_usd : null,
      monthlyEvents: typeof limits.monthly_events === 'number' ? limits.monthly_events : null,
    };
  }

  /**
   * Reserve usage headroom before a metered call (satellites call this with
   * their estimate). Atomic across the product and (when given) project
   * buckets; rejection carries the offending level as the reason.
   */
  async checkAndReserve(input: QuotaReservation): Promise<QuotaDecision> {
    const productLimits = await this.limitsFor(input.orgId, input.product);
    const projectLimits = input.projectId ? await this.projectLimits(input.orgId, input.product, input.projectId) : null;

    const month = monthKey();
    const keys = [
      `quota:${input.orgId}:${input.product}:${month}:usd`,
      `quota:${input.orgId}:${input.product}:${month}:events`,
      input.projectId ? `quota:${input.orgId}:${input.product}:${input.projectId}:${month}:usd` : '',
      input.projectId ? `quota:${input.orgId}:${input.product}:${input.projectId}:${month}:events` : '',
    ];
    const cost = Math.max(0, input.estimatedCostUsd ?? 0);
    const events = Math.max(0, input.units ?? 1);

    try {
      const result = (await this.redis.raw.eval(
        RESERVE_LUA,
        4,
        ...keys,
        String(cost),
        String(events),
        String(productLimits.monthlySpendUsd ?? -1),
        String(productLimits.monthlyEvents ?? -1),
        String(projectLimits?.monthlySpendUsd ?? -1),
        String(projectLimits?.monthlyEvents ?? -1),
        String(32 * 86_400), // counters die with the month window (+ slack)
      )) as [number, string];
      const allowed = result[0] === 1;
      if (!allowed) {
        QuotaService.logger.warn(`quota reservation rejected for ${input.orgId}/${input.product}: ${result[1]}`);
      }
      return {
        allowed,
        reason: allowed ? null : result[1],
        product: await this.bucket(keys[0], keys[1], productLimits),
        project: input.projectId ? await this.bucket(keys[2], keys[3], projectLimits) : null,
      };
    } catch (err) {
      QuotaService.logger.error(`quota plane unavailable (fail-open): ${(err as Error).message}`);
      return {
        allowed: true,
        reason: null,
        product: { limit_usd: productLimits.monthlySpendUsd, used_usd: 0, limit_events: productLimits.monthlyEvents, used_events: 0 },
        project: null,
      };
    }
  }

  /** Read-only view of current month usage (console usage pages). */
  async usageSnapshot(orgId: string, product: string, projectId?: string | null): Promise<QuotaDecision> {
    const productLimits = await this.limitsFor(orgId, product);
    const month = monthKey();
    const productKeys = [`quota:${orgId}:${product}:${month}:usd`, `quota:${orgId}:${product}:${month}:events`];
    const projectLimits = projectId ? await this.projectLimits(orgId, product, projectId) : null;
    const projectKeys = projectId
      ? [`quota:${orgId}:${product}:${projectId}:${month}:usd`, `quota:${orgId}:${product}:${projectId}:${month}:events`]
      : null;
    return {
      allowed: true,
      reason: null,
      product: await this.bucket(productKeys[0], productKeys[1], productLimits),
      project: projectKeys ? await this.bucket(projectKeys[0], projectKeys[1], projectLimits) : null,
    };
  }

  /** Project-level overrides ride the entitlement limits jsonb: `projects` map. */
  private async projectLimits(orgId: string, product: string, projectId: string): Promise<QuotaLimits> {
    const rows = await this.entitlements.listForOrg(orgId);
    const row = rows.find((r) => r.product === product);
    const limits = (row?.limits ?? {}) as Record<string, unknown>;
    const perProject = (limits.projects ?? {}) as Record<string, Record<string, unknown>>;
    const own = perProject[projectId] ?? {};
    return {
      monthlySpendUsd: typeof own.monthly_spend_usd === 'number' ? own.monthly_spend_usd : null,
      monthlyEvents: typeof own.monthly_events === 'number' ? own.monthly_events : null,
    };
  }

  private async bucket(costKey: string, eventKey: string, limits: QuotaLimits | null): Promise<NonNullable<QuotaDecision['product']>> {
    const [usd, events] = await Promise.all([
      this.redis.raw.get(costKey).catch(() => null),
      this.redis.raw.get(eventKey).catch(() => null),
    ]);
    return {
      limit_usd: limits?.monthlySpendUsd ?? null,
      used_usd: usd ? Number(usd) : 0,
      limit_events: limits?.monthlyEvents ?? null,
      used_events: events ? Number(events) : 0,
    };
  }
}

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
