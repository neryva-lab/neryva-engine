import { Binary } from 'mongodb';
import type {
  AggregationCursor,
  AggregateOptions,
  BulkWriteOptions,
  Collection,
  CountDocumentsOptions,
  DeleteOptions,
  DeleteResult,
  Document,
  Filter,
  FindCursor,
  FindOneAndDeleteOptions,
  FindOneAndUpdateOptions,
  FindOptions,
  InsertManyResult,
  InsertOneOptions,
  InsertOneResult,
  OptionalUnlessRequiredId,
  UpdateFilter,
  UpdateOptions,
  UpdateResult,
  WithId,
} from 'mongodb';
import { uuidToBinary } from '../mongo-tx';

/**
 * Defense in depth for the RLS gap (see plan D6/D7).
 *
 * MongoDB has no row-level security: the 71 tenant tables whose isolation is
 * enforced by PostgreSQL (`ENABLE + FORCE` RLS on `organization_id`) lose
 * their database-level backstop on the Mongo lane. The replacement is
 * layered; this file is layer (a): tenant scoping enforced in code, at the
 * single choke point through which every tenant-collection access flows.
 *
 * Rules, fail-closed throughout:
 * - `orgId` is the FIRST parameter of every method. Missing/empty orgId
 *   throws — an unscoped query is never silently issued.
 * - The tenant predicate `{ [tenantField]: orgId }` is ANDed into every
 *   filter. A filter that already constrains the tenant field to a DIFFERENT
 *   tenant throws (never silently broadened).
 * - `insertOne`/`insertMany` inject the tenant field into the document. A
 *   document already carrying the tenant field for a DIFFERENT tenant throws
 *   (never silently overwritten or cross-written).
 * - Updates that attempt to move the tenant field (`$set`/`$setOnInsert` to
 *   another tenant) throw.
 *
 * `tenantField` defaults to `organization_id`; the org-furniture group uses
 * `org_id` — pass `{ tenantField: 'org_id' }`.
 *
 * Platform-plane collections (inbox, satellites, corporate, staff,
 * notifications) are deliberately unscoped by schema design — see
 * `PlatformCollection`, whose name makes the unscoped choice visible in
 * review. `unsafeNative` on both classes is the escape hatch for operations
 * these wrappers do not cover; its name is the warning.
 */

export interface TenantScopedOptions {
  /** Tenant key field. Default `'organization_id'`; org furniture uses `'org_id'`. */
  tenantField?: string;
}

function assertOrgId(orgId: string): void {
  if (typeof orgId !== 'string' || orgId.trim().length === 0) {
    throw new Error(
      'TenantScopedCollection: orgId must be a non-empty string — refusing unscoped query',
    );
  }
}

/**
 * Org ids may arrive as UUID strings or BSON Binary subtype 4 (D4: all UUID
 * fields are stored as Binary subtype 4). Normalized to Binary at the choke
 * point so filters and documents are always consistent with storage.
 */
export type OrgId = string | Binary;

/** Normalize to Binary subtype 4; fail closed on empty/malformed input. */
function normalizeOrgId(orgId: OrgId): Binary {
  if (typeof orgId === 'string') {
    assertOrgId(orgId);
    return uuidToBinary(orgId); // rejects malformed UUIDs
  }
  if (orgId instanceof Binary) return orgId;
  throw new Error(
    'TenantScopedCollection: orgId must be a UUID string or BSON Binary — refusing unscoped query',
  );
}

/** Byte equality for BSON Binary values. */
function binaryEquals(a: Binary, b: Binary): boolean {
  if (a.sub_type !== b.sub_type) return false;
  const ab = a.buffer;
  const bb = b.buffer;
  if (ab.byteLength !== bb.byteLength) return false;
  for (let i = 0; i < ab.byteLength; i++) {
    if (ab[i] !== bb[i]) return false;
  }
  return true;
}

/** Tenant-value equality across string/Binary representations. */
function tenantEquals(existing: unknown, tenant: Binary): boolean {
  if (existing instanceof Binary) return binaryEquals(existing, tenant);
  if (typeof existing === 'string') {
    try {
      return binaryEquals(uuidToBinary(existing), tenant);
    } catch {
      return false;
    }
  }
  return false;
}

function assertTenantField(tenantField: string): void {
  if (typeof tenantField !== 'string' || tenantField.length === 0) {
    throw new Error('TenantScopedCollection: tenantField must be a non-empty string');
  }
}

/** AND the tenant predicate into a filter; fail closed on a conflicting tenant. */
function scopedFilter<T extends Document>(
  filter: Filter<T> | undefined,
  tenantField: string,
  orgId: OrgId,
): Filter<T> {
  const tenant = normalizeOrgId(orgId);
  const existing = (filter as Record<string, unknown> | undefined)?.[tenantField];
  if (existing !== undefined && !tenantEquals(existing, tenant)) {
    throw new Error(
      `TenantScopedCollection: filter already constrains ${tenantField} to a different tenant — refusing`,
    );
  }
  return { ...filter, [tenantField]: tenant } as Filter<T>;
}

/** Inject the tenant field into a document to insert; fail closed on mismatch. */
function scopedDoc<T extends Document>(
  doc: OptionalUnlessRequiredId<T>,
  tenantField: string,
  orgId: OrgId,
): OptionalUnlessRequiredId<T> {
  const tenant = normalizeOrgId(orgId);
  const existing = (doc as Record<string, unknown>)[tenantField];
  if (existing !== undefined && !tenantEquals(existing, tenant)) {
    throw new Error(
      `TenantScopedCollection: document already carries ${tenantField} for a different tenant — refusing`,
    );
  }
  return { ...doc, [tenantField]: tenant } as OptionalUnlessRequiredId<T>;
}

/** Refuse updates that would move a document across tenants. */
function assertUpdateKeepsTenant<T extends Document>(
  update: UpdateFilter<T>,
  tenantField: string,
  orgId: OrgId,
): void {
  const tenant = normalizeOrgId(orgId);
  const ops = update as Record<string, unknown>;
  for (const op of ['$set', '$setOnInsert']) {
    const fields = ops[op] as Record<string, unknown> | undefined;
    const value = fields?.[tenantField];
    if (value !== undefined && !tenantEquals(value, tenant)) {
      throw new Error(
        `TenantScopedCollection: update attempts to move ${tenantField} across tenants — refusing`,
      );
    }
  }
}

export class TenantScopedCollection<T extends Document> {
  readonly tenantField: string;

  constructor(
    private readonly collection: Collection<T>,
    opts: TenantScopedOptions = {},
  ) {
    this.tenantField = opts.tenantField ?? 'organization_id';
    assertTenantField(this.tenantField);
  }

  /**
   * Escape hatch for operations not covered here. Prefer the scoped methods;
   * any use of this in tenant code must carry its own org predicate and say so.
   */
  get unsafeNative(): Collection<T> {
    return this.collection;
  }

  get collectionName(): string {
    return this.collection.collectionName;
  }

  findOne(
    orgId: OrgId,
    filter?: Filter<T>,
    options?: FindOptions,
  ): Promise<WithId<T> | null> {
    return this.collection.findOne(scopedFilter(filter, this.tenantField, orgId), options);
  }

  find(orgId: OrgId, filter?: Filter<T>, options?: FindOptions): FindCursor<WithId<T>> {
    return this.collection.find(scopedFilter(filter, this.tenantField, orgId), options);
  }

  updateOne(
    orgId: OrgId,
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    assertUpdateKeepsTenant(update, this.tenantField, orgId);
    return this.collection.updateOne(
      scopedFilter(filter, this.tenantField, orgId),
      update,
      options,
    );
  }

  updateMany(
    orgId: OrgId,
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    assertUpdateKeepsTenant(update, this.tenantField, orgId);
    return this.collection.updateMany(
      scopedFilter(filter, this.tenantField, orgId),
      update,
      options,
    );
  }

  deleteOne(
    orgId: OrgId,
    filter?: Filter<T>,
    options?: DeleteOptions,
  ): Promise<DeleteResult> {
    return this.collection.deleteOne(scopedFilter(filter, this.tenantField, orgId), options);
  }

  deleteMany(
    orgId: OrgId,
    filter?: Filter<T>,
    options?: DeleteOptions,
  ): Promise<DeleteResult> {
    return this.collection.deleteMany(scopedFilter(filter, this.tenantField, orgId), options);
  }

  countDocuments(
    orgId: OrgId,
    filter?: Filter<T>,
    options?: CountDocumentsOptions,
  ): Promise<number> {
    return this.collection.countDocuments(
      scopedFilter(filter, this.tenantField, orgId),
      options,
    );
  }

  findOneAndUpdate(
    orgId: OrgId,
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: FindOneAndUpdateOptions,
  ): Promise<WithId<T> | null> {
    assertUpdateKeepsTenant(update, this.tenantField, orgId);
    return this.collection.findOneAndUpdate(
      scopedFilter(filter, this.tenantField, orgId),
      update,
      options ?? {},
    );
  }

  findOneAndDelete(
    orgId: OrgId,
    filter: Filter<T>,
    options?: FindOneAndDeleteOptions,
  ): Promise<WithId<T> | null> {
    return this.collection.findOneAndDelete(
      scopedFilter(filter, this.tenantField, orgId),
      options ?? {},
    );
  }

  insertOne(
    orgId: OrgId,
    doc: OptionalUnlessRequiredId<T>,
    options?: InsertOneOptions,
  ): Promise<InsertOneResult<T>> {
    return this.collection.insertOne(scopedDoc(doc, this.tenantField, orgId), options);
  }

  insertMany(
    orgId: OrgId,
    docs: OptionalUnlessRequiredId<T>[],
    options?: BulkWriteOptions,
  ): Promise<InsertManyResult<T>> {
    return this.collection.insertMany(
      docs.map((doc) => scopedDoc(doc, this.tenantField, orgId)),
      options,
    );
  }

  /**
   * Tenant-scoped aggregation: a `$match` on the tenant field is prepended
   * to the pipeline, so no stage can observe another tenant's documents.
   */
  aggregate(
    orgId: OrgId,
    pipeline: Document[] = [],
    options?: AggregateOptions,
  ): AggregationCursor<T> {
    return this.collection.aggregate<T>(
      [{ $match: { [this.tenantField]: normalizeOrgId(orgId) } }, ...pipeline],
      options,
    );
  }
}

/**
 * Deliberately UNSCOPED collection wrapper for platform-plane collections
 * (inbox, satellites, corporate, staff, notifications) — the tables that have
 * no RLS by schema design on the PostgreSQL lane either.
 *
 * The class name is the control: unscoped access must always be a visible,
 * deliberate choice in code review. Never use this for tenant-owned data.
 */
export class PlatformCollection<T extends Document> {
  constructor(private readonly collection: Collection<T>) {}

  /** Escape hatch, same contract as on TenantScopedCollection. */
  get unsafeNative(): Collection<T> {
    return this.collection;
  }

  get collectionName(): string {
    return this.collection.collectionName;
  }

  findOne(filter?: Filter<T>, options?: FindOptions): Promise<WithId<T> | null> {
    return this.collection.findOne(filter ?? {}, options);
  }

  find(filter?: Filter<T>, options?: FindOptions): FindCursor<WithId<T>> {
    return this.collection.find(filter ?? {}, options);
  }

  updateOne(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    return this.collection.updateOne(filter, update, options);
  }

  updateMany(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: UpdateOptions,
  ): Promise<UpdateResult> {
    return this.collection.updateMany(filter, update, options);
  }

  deleteOne(filter?: Filter<T>, options?: DeleteOptions): Promise<DeleteResult> {
    return this.collection.deleteOne(filter, options);
  }

  deleteMany(filter?: Filter<T>, options?: DeleteOptions): Promise<DeleteResult> {
    return this.collection.deleteMany(filter, options);
  }

  countDocuments(filter?: Filter<T>, options?: CountDocumentsOptions): Promise<number> {
    return this.collection.countDocuments(filter, options);
  }

  findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: FindOneAndUpdateOptions,
  ): Promise<WithId<T> | null> {
    return this.collection.findOneAndUpdate(filter, update, options ?? {});
  }

  findOneAndDelete(
    filter: Filter<T>,
    options?: FindOneAndDeleteOptions,
  ): Promise<WithId<T> | null> {
    return this.collection.findOneAndDelete(filter, options ?? {});
  }

  insertOne(
    doc: OptionalUnlessRequiredId<T>,
    options?: InsertOneOptions,
  ): Promise<InsertOneResult<T>> {
    return this.collection.insertOne(doc, options);
  }

  insertMany(
    docs: OptionalUnlessRequiredId<T>[],
    options?: BulkWriteOptions,
  ): Promise<InsertManyResult<T>> {
    return this.collection.insertMany(docs, options);
  }

  aggregate(
    pipeline: Document[] = [],
    options?: AggregateOptions,
  ): AggregationCursor<T> {
    return this.collection.aggregate<T>(pipeline, options);
  }
}
