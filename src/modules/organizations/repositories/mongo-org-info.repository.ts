import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { PlatformCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { binUuid, ensureInfoIndexes, nowIso, toOrgBrief } from './mongo-documents';
import type { InfoTenantMongoDoc } from './mongo-documents';
import type { IOrgInfoRepository, OrgBrief } from './org-info.repository';

/**
 * MongoDB lane for `IOrgInfoRepository` (P3).
 *
 * The Python-owned `tenants` seam: every access is by explicit id (or an
 * explicit id list), never a table scan — so reads go through an unscoped
 * `PlatformCollection` with a justifying comment, mirroring the pg lane's
 * `db.root` escape hatch. The `getName` fallback ('your organization') is
 * the service-layer contract — preserved here, never in the callers.
 */
export class MongoOrgInfoRepository implements IOrgInfoRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /**
   * Deliberately UNSCOPED — `tenants` is Python-owned DDL with no tenant
   * guard on either lane; every query below filters by explicit id,
   * mirroring the pg lane's `db.root` reads.
   */
  private tenants(db: Db): PlatformCollection<InfoTenantMongoDoc> {
    return new PlatformCollection<InfoTenantMongoDoc>(db.collection<InfoTenantMongoDoc>('tenants'));
  }

  async getBrief(orgId: string): Promise<OrgBrief | null> {
    const db = this.mongo.root;
    await ensureInfoIndexes(db);
    const doc = await this.tenants(db).findOne({ id: binUuid(orgId, 'orgId') });
    return doc ? toOrgBrief(doc) : null;
  }

  async getName(orgId: string): Promise<string> {
    const brief = await this.getBrief(orgId);
    return brief?.name ?? 'your organization';
  }

  async listBriefs(orgIds: string[]): Promise<OrgBrief[]> {
    if (orgIds.length === 0) {
      return [];
    }
    const db = this.mongo.root;
    await ensureInfoIndexes(db);
    // Justification (unscoped): cross-org read for exactly the caller's
    // membership orgs — ids come from the filtered membership query
    // upstream, never an unbounded scan.
    const docs = await this.tenants(db)
      .find({ id: { $in: orgIds.map((id) => binUuid(id, 'orgId')) } })
      .toArray();
    return docs.map(toOrgBrief);
  }

  async getTenantFields(orgId: string): Promise<{ region: string | null; retentionDays: number | null } | null> {
    const db = this.mongo.root;
    await ensureInfoIndexes(db);
    const doc = await this.tenants(db).findOne({ id: binUuid(orgId, 'orgId') });
    return doc ? { region: doc.region ?? null, retentionDays: doc.retention_days ?? null } : null;
  }

  async updateTenantProfile(
    orgId: string,
    patch: { name?: string; region?: string; retentionDays?: number },
  ): Promise<void> {
    const db = this.mongo.root;
    await ensureInfoIndexes(db);
    const set: Record<string, unknown> = { updated_at: nowIso() };
    if (patch.name !== undefined) {
      set.name = patch.name;
    }
    if (patch.region !== undefined) {
      set.region = patch.region;
    }
    // The pg lane maps this to the `retention_days` column (the old
    // service's camelCase key was silently dropped — FOUND BUG, fixed in
    // the pg lane); the mongo field is `retention_days` likewise.
    if (patch.retentionDays !== undefined) {
      set.retention_days = patch.retentionDays;
    }
    await this.tenants(db).updateOne({ id: binUuid(orgId, 'orgId') }, { $set: set });
  }
}
