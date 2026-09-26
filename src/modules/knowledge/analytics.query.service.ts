import { Inject, Injectable } from '@nestjs/common';
import { ANALYTICS_ROLLUP_REPOSITORY } from './repositories/repository-tokens';
import type { IAnalyticsRollupRepository } from './repositories/analytics-rollup.repository';
import { assertUuid } from './assert';

/**
 * FL-2.22/2.23/2.24 — read side of the analytics rollups computed by the
 * outbox consumer. All aggregation happens in the recompute path; this
 * service only reads the durable buckets (org-scoped, bounded).
 */
@Injectable()
export class AnalyticsQueryService {
  constructor(
    @Inject(ANALYTICS_ROLLUP_REPOSITORY)
    private readonly rollupRepository: IAnalyticsRollupRepository,
  ) {}

  async rollups(orgId: string, kind?: string, days?: number, assistantId?: string): Promise<Array<Record<string, unknown>>> {
    assertUuid(orgId, 'orgId');
    if (assistantId !== undefined) {
      assertUuid(assistantId, 'assistantId');
    }
    const windowDays = Math.min(Math.max(1, days ?? 30), 365);
    const rows = await this.rollupRepository.rollups(orgId, {
      kind,
      windowDays,
      assistantId,
      limit: 400,
    });
    return rows.map((r) => ({
      kind: r.kind,
      period_start: r.period_start,
      scope: r.scope,
      metrics: r.metrics,
      computed_at: r.computed_at,
    }));
  }
}
