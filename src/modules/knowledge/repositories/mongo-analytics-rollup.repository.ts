/**
 * MongoDB implementation of the analytics-rollup repository port (P3) — the
 * typed read side of the analytics rollups (FL-2.22/2.23/2.24).
 *
 * Rollup computation is a writer outside this port; this port only reads
 * the durable buckets (org-scoped, bounded).
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { AnalyticsRollupMongoDoc } from './mongo-documents';
import type { RollupRow } from './repository-types';
import type { IAnalyticsRollupRepository } from './analytics-rollup.repository';
import { sessionOf } from './mongo-knowledge-shared';

const ANALYTICS_ROLLUPS = 'analytics_rollups';

function toRollupRow(doc: AnalyticsRollupMongoDoc): RollupRow {
  return {
    id: doc.id.toUUID().toString(),
    kind: doc.kind,
    period_start: doc.period_start,
    scope: doc.scope,
    metrics: doc.metrics,
    computed_at: doc.computed_at,
  };
}

/** yyyy-mm-dd in UTC, `days` days before today. */
function cutoffDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class MongoAnalyticsRollupRepository implements IAnalyticsRollupRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async rollups(
    orgId: string,
    opts: { kind?: string; windowDays: number; assistantId?: string; limit: number },
  ): Promise<RollupRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const rollups = new TenantScopedCollection<AnalyticsRollupMongoDoc>(
        db.collection(ANALYTICS_ROLLUPS),
      );
      // Mirrors the pg lane byte-for-byte: window strictly after
      // (current_date - windowDays), assistant scope as a string match on
      // scope.assistant_id, newest period first then kind. Window clamping
      // and UUID validation stay in the service — the repository binds
      // exactly what it is given.
      const filter: Record<string, unknown> = {
        period_start: { $gt: cutoffDate(opts.windowDays) },
      };
      if (opts.kind !== undefined) filter.kind = opts.kind;
      if (opts.assistantId !== undefined) filter['scope.assistant_id'] = opts.assistantId;
      const docs = await rollups
        .find(orgId, filter, {
          ...sessionOf(ctx),
          sort: { period_start: -1, kind: 1 },
          limit: Math.max(opts.limit, 0),
        })
        .toArray();
      return docs.map(toRollupRow);
    });
  }
}
