/**
 * MongoDB lane for `IBurnRateRepository` (P3) — the READ-ONLY port for the
 * burn-rate auto-rollback worker.
 *
 * This port never writes. The worker routes any pausing through
 * `IRolloutRepository.pauseRelease` — write ownership for rollouts stays in
 * exactly one place. Each method is one read-consistent unit of work.
 *
 * Posture per call site: `sweepCandidates` and the suppression read
 * (`lastAutoRollbackAt`) are cross-org / global reads on the raw
 * `MongoDbService.root` handle (no RLS exists on this lane; unscoped
 * collections), exactly as the pg lane uses `db.root`. The per-assistant
 * cost windows and newest-active-rollout reads are tenant-scoped via
 * `withOrg` + `TenantScopedCollection` (plan D6).
 *
 * Foreign tables read here (owned by other modules — read as read-only
 * shapes, never mutated): `usage_ledger_entries` (cost windows — pg numeric
 * costs arrive as strings, summed via `$toDouble` on
 * `coalesce(settled_cost, estimated_cost, 0)`, the same dollar the quota
 * wall reads), `assistant_rollouts` (sweep + newest active rollout),
 * `audit_events` (last auto-rollback marker — `tenant_id` may be a UUID
 * string or Binary subtype 4 during the port transition, so both match).
 */
import { Binary } from 'mongodb';
import type { Db, Document } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { ApiError } from '../../../common/http/api-error';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { IBurnRateRepository } from './burn-rate.repository';

// ── document shapes (plan D4: snake_case, UUIDs as Binary subtype 4) ───────

interface UsageLedgerMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  /** pg numeric arrives as a string on this lane. */
  settled_cost: string | null;
  /** pg numeric arrives as a string on this lane. */
  estimated_cost: string | null;
  created_at: string;
}

interface RolloutMongoDoc extends Document {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  state: string;
  environment: string;
  channel: string;
  created_at: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

/** UUID fields may be Binary (D4) or strings during the port transition. */
function idString(value: unknown): string {
  if (value instanceof Binary) return uuidOf(value);
  return String(value);
}

/** Parse a UUID into BSON Binary subtype 4; fail closed with a validation error. */
function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

// ── repository ──────────────────────────────────────────────────────────────

export class MongoBurnRateRepository implements IBurnRateRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async sweepCandidates(limit = 500): Promise<Array<{ orgId: string; assistantId: string }>> {
    const db = this.mongo.root;
    const bounded = Math.min(Math.max(1, limit), 5000);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    // Cross-org sweep: assistants with an ACTIVE production/default rollout
    // in orgs that spent in the last hour. Spend-gated so idle fleets cost
    // one query, not N cost aggregations. Bounded for the worker.
    const rows = await db
      .collection('assistant_rollouts')
      .aggregate<{ _id: { org: Binary; assistant: Binary } }>([
        { $match: { state: 'active', environment: 'production', channel: 'default' } },
        {
          $lookup: {
            from: 'usage_ledger_entries',
            let: { org: '$organization_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ['$organization_id', '$$org'] }, { $gt: ['$created_at', hourAgo] }],
                  },
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: 'spend',
          },
        },
        { $match: { 'spend.0': { $exists: true } } },
        { $group: { _id: { org: '$organization_id', assistant: '$assistant_id' } } },
        { $limit: bounded },
      ])
      .toArray();
    return rows.map((r) => ({ orgId: idString(r._id.org), assistantId: idString(r._id.assistant) }));
  }

  async costWindows(orgId: string): Promise<{ lastHourCost: number; lastDayCost: number }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const entries = new TenantScopedCollection<UsageLedgerMongoDoc>(
        db.collection<UsageLedgerMongoDoc>('usage_ledger_entries'),
      );
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      // The same dollar the quota wall reads: coalesce(settled_cost,
      // estimated_cost, 0) — costs are strings on this lane, hence $toDouble.
      const total = {
        $sum: { $toDouble: { $ifNull: ['$settled_cost', { $ifNull: ['$estimated_cost', '0'] }] } },
      };
      const rows = (await entries
        .aggregate(
          orgId,
          [
            { $match: { created_at: { $gte: dayAgo } } },
            {
              $facet: {
                hour: [{ $match: { created_at: { $gte: hourAgo } } }, { $group: { _id: null, total } }],
                day: [{ $group: { _id: null, total } }],
              },
            },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as Array<{ hour: Array<{ total: number }>; day: Array<{ total: number }> }>;
      const facet = rows[0];
      return {
        lastHourCost: facet?.hour[0]?.total ?? 0,
        lastDayCost: facet?.day[0]?.total ?? 0,
      };
    });
  }

  async lastAutoRollbackAt(orgId: string, assistantId: string): Promise<string | null> {
    const db = this.mongo.root;
    const row = await db.collection('audit_events').findOne(
      {
        tenant_id: { $in: [orgId, binUuid(orgId, 'orgId')] },
        action: 'assistant.auto_rollback',
        'details.assistant_id': assistantId,
      },
      { sort: { created_at: -1 } },
    );
    const createdAt = (row as { created_at?: unknown } | null)?.created_at;
    return typeof createdAt === 'string' ? createdAt : null;
  }

  async newestActiveRolloutCreatedAt(orgId: string, assistantId: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const rollouts = new TenantScopedCollection<RolloutMongoDoc>(
        db.collection<RolloutMongoDoc>('assistant_rollouts'),
      );
      const rows = await rollouts
        .find(
          orgId,
          { assistant_id: binUuid(assistantId, 'assistantId'), state: 'active' },
          { session: ctx.session },
        )
        .sort({ created_at: -1 })
        .limit(1)
        .toArray();
      return rows[0]?.created_at ?? null;
    });
  }
}
