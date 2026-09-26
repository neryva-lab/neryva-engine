/**
 * MongoDB lane for `IOrgAuditRepository` (P3).
 *
 * `audit_events` is the shared Tier-0 hash-chain table (Python-owned DDL,
 * no RLS) — every query here filters `tenant_id` explicitly and never
 * writes. `tenant_id` is varchar(36) on pg, so it stays a plain STRING on
 * this lane (never Binary — see the 0001_engine_core entry, which constrains
 * no bsonType for it); reads go through a `PlatformCollection` over
 * `this.mongo.root` with an explicit `tenant_id` predicate, mirroring the pg
 * lane's `DbService.root` justification. The appender in the kernel is the
 * sole write path, append-only by construction.
 *
 * No transaction is needed for these point reads; the explicit tenant
 * predicate is the isolation.
 */
import type { Db, Filter } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  PlatformCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { AuditEventDoc } from './mongo-documents';
import type {
  AuditEventRow,
  AuditQueryFilters,
  IOrgAuditRepository,
} from './org-audit.repository';

export class MongoOrgAuditRepository implements IOrgAuditRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /**
   * Platform-plane handle for the explicitly-filtered chain reads.
   * Deliberately UNSCOPED — `audit_events` has no RLS by schema design on
   * the PostgreSQL lane either; every query below carries an explicit
   * `tenant_id` predicate, mirroring the pg lane's `db.root` reads.
   */
  private chain(db: Db): PlatformCollection<AuditEventDoc> {
    return new PlatformCollection<AuditEventDoc>(
      db.collection<AuditEventDoc>('audit_events'),
    );
  }

  private buildFilter(orgId: string, f: AuditQueryFilters): Filter<AuditEventDoc> {
    const filter: Filter<AuditEventDoc> = { tenant_id: orgId };
    if (f.actorId) {
      filter.actor_id = f.actorId;
    }
    if (f.action) {
      // Exact action or an action prefix filter ("org." → every org.* event).
      filter.action = f.action;
    }
    if (f.resourceType) {
      filter.resource_type = f.resourceType;
    }
    const created: { $gte?: string; $lte?: string } = {};
    if (f.from) {
      created.$gte = f.from;
    }
    if (f.to) {
      created.$lte = f.to;
    }
    if (created.$gte !== undefined || created.$lte !== undefined) {
      filter.created_at = created;
    }
    return filter;
  }

  /**
   * Filtered, paginated events for the org plus the total matching count
   * (two queries, one predicate). Sort is (created_at, id) in the
   * requested direction.
   */
  async query(
    orgId: string,
    filters: AuditQueryFilters,
  ): Promise<{ events: AuditEventRow[]; total: number }> {
    const db = this.mongo.root;
    const coll = this.chain(db);
    const filter = this.buildFilter(orgId, filters);
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const direction = filters.order === 'asc' ? 1 : -1;
    const docs = await coll
      .find(filter)
      .sort({ created_at: direction, id: direction })
      .skip(offset)
      .limit(limit)
      .toArray();
    const total = await coll.countDocuments(filter);
    return { events: docs.map(toRow), total };
  }

  /**
   * Distinct values for the filter dropdowns, bounded: actions ordered by
   * frequency (most useful chips first), resource types alphabetical.
   */
  async filterFacets(orgId: string): Promise<{ actions: string[]; resourceTypes: string[] }> {
    const db = this.mongo.root;
    const coll = this.chain(db);
    const actions = (
      (await coll
        .aggregate([
          { $match: { tenant_id: orgId } },
          { $group: { _id: '$action', n: { $sum: 1 } } },
          { $sort: { n: -1, _id: 1 } },
          { $limit: 500 },
        ])
        .toArray()) as unknown as Array<{ _id: string }>
    ).map((r) => r._id);
    const resourceTypes = (
      (await coll
        .aggregate([
          { $match: { tenant_id: orgId } },
          { $group: { _id: '$resource_type' } },
          { $sort: { _id: 1 } },
          { $limit: 200 },
        ])
        .toArray()) as unknown as Array<{ _id: string }>
    ).map((r) => r._id);
    return { actions, resourceTypes };
  }
}

function toRow(doc: AuditEventDoc): AuditEventRow {
  return {
    id: doc.id,
    actor_type: doc.actor_type,
    actor_id: doc.actor_id ?? null,
    action: doc.action,
    resource_type: doc.resource_type,
    resource_id: doc.resource_id ?? null,
    details: doc.details ?? {},
    created_at: doc.created_at,
  };
}
