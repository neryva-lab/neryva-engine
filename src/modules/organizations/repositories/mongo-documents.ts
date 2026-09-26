/**
 * Shared MongoDB document-shaping helpers for the organizations-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Tenant key: every org-furniture collection keys tenancy on `org_id`
 * (varchar(36) on the pg lane; Binary-or-string per the migration
 * validators during the port transition). `orgCollection` pins the
 * `TenantScopedCollection` tenant field to `org_id` (plan D6 — explicit org
 * predicate on every tenant collection access; there is no RLS on this
 * lane). The Python-owned `tenants` table and the cross-tenant
 * token-hash/auth lookups are deliberately unscoped — repositories use
 * `PlatformCollection` for those with a justifying comment, mirroring the
 * pg lane's `db.root`/`withBypass` escape hatches.
 *
 * Small cross-repo helpers live here (binary uuid conversion, duplicate-key
 * detection, tenant-scope narrowing) so the repositories stay focused on
 * their own transaction bodies. Cluster agents: APPEND your aggregate doc
 * shapes + row mappers below the marker. Do not redefine the helpers.
 */
import { Binary, MongoServerError } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';

/** Fail closed when a withOrg callback somehow carries no tenant scope. */
export function requireOrg(ctx: MongoTxContext): string {
  const orgId = ctx.orgId;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error('mongo repository: refusing unscoped access — withOrg guarantees a tenant scope');
  }
  return orgId;
}

/** True for MongoDB duplicate-key errors (the unique-index conflict signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Sentinel for "duplicate key → benign null/false" inside a transaction.
 *
 * Never swallow a caught 11000 and return normally from inside a
 * `withTransaction` callback: the failed write aborts the transaction, and
 * the driver's `withTransaction` then retries the callback indefinitely
 * (each retry re-hits the duplicate — an infinite loop, observed as a hung
 * `createProject`/`createGroup`/`addGroupMember` on the mongo lane).
 * Throw this instead: it carries no transient labels, so `withTransaction`
 * (and the `runInTransaction` retry loop) propagate it immediately. The
 * repository catches it OUTSIDE `withOrg` and maps it to the benign
 * null/false the interface promises.
 */
export class DuplicateKeySignal extends Error {
  constructor() {
    super('duplicate key');
    this.name = 'DuplicateKeySignal';
  }
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** Render a Binary subtype-4 UUID back to its canonical string form. */
export function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

/** Tenant-guarded handle for an org-furniture collection (tenant key `org_id`). */
export function orgCollection<T extends Document>(
  db: Db,
  name: string,
): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name), { tenantField: 'org_id' });
}

/** ISO-8601 UTC timestamp, the mongo-lane equivalent of pg `defaultNow()`. */
export function nowIso(): string {
  return new Date().toISOString();
}

// ── cluster agents append aggregate doc shapes + row mappers below ────────

// ── furniture cluster doc shapes + row mappers (P3) ───────────────────────
// Plan D4: snake_case fields, UUIDs as BSON Binary subtype 4, timestamps as
// ISO-8601 strings. The pg `id` column is kept as the Binary field `id`
// (`_id` stays the driver's default ObjectId, never overridden) — except
// `org_settings`, whose pg primary key IS `org_id` (no separate id column),
// and `org_group_members`, whose pg primary key is the (group_id,
// account_id) pair. `audit_events.tenant_id` is varchar(36) on pg, so it
// stays a plain string on this lane (never Binary).
//
// `org_service_accounts.token_hash` / `token_prefix` are OMITTED (not set
// to null) when the account holds no token; repositories pair that with a
// sparse unique index so multiple token-less docs stay legal exactly like
// pg's NULL-distinct unique semantics.
import type {
  orgGroups,
  orgServiceAccounts,
  orgSettings,
  productEntitlements,
  projects,
} from '../schema';

export interface ProductEntitlementDoc {
  id: Binary;
  org_id: Binary;
  product: string;
  plan: string;
  status: string;
  limits: unknown;
  seats: number | null;
  source: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectDoc {
  id: Binary;
  org_id: Binary;
  name: string;
  description: string | null;
  created_by: Binary | null;
  archived_at: string | null;
  archived_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export interface OrgGroupDoc {
  id: Binary;
  org_id: Binary;
  name: string;
  description: string | null;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export interface OrgGroupMemberDoc {
  group_id: Binary;
  account_id: Binary;
  org_id: Binary;
  added_by: Binary | null;
  added_at: string;
}

export interface OrgServiceAccountDoc {
  id: Binary;
  org_id: Binary;
  name: string;
  description: string | null;
  status: string;
  scopes: unknown;
  token_hash?: string;
  token_prefix?: string;
  token_expires_at: string | null;
  token_last_used_at: string | null;
  token_last_rotated_at: string | null;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export interface OrgSettingsDoc {
  org_id: Binary;
  kind: string;
  support_email: string | null;
  default_project_id: Binary | null;
  branding: unknown;
  preferences: unknown;
  created_at: string;
  updated_at: string;
}

export interface AuditEventDoc {
  id: string;
  tenant_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: unknown;
  prev_hash: string | null;
  event_hash: string | null;
  created_at: string;
}

/** Minimal accounts shape for the group-member identity join. */
export interface FurnitureAccountDoc {
  id: Binary;
  email: string;
  display_name: string | null;
}

/** Minimal org_memberships shape for the group-member role join. */
export interface FurnitureMembershipDoc {
  account_id: Binary;
  org_id: Binary;
  role: string;
}

// ── row mappers (BSON → pg-shaped rows) ────────────────────────────────────

export function toProductEntitlementRow(
  doc: ProductEntitlementDoc,
): typeof productEntitlements.$inferSelect {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    product: doc.product,
    plan: doc.plan,
    status: doc.status,
    limits: doc.limits ?? {},
    seats: doc.seats ?? null,
    source: doc.source ?? null,
    periodStart: doc.period_start ?? null,
    periodEnd: doc.period_end ?? null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function toProjectRow(doc: ProjectDoc): typeof projects.$inferSelect {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    name: doc.name,
    description: doc.description ?? null,
    createdBy: doc.created_by ? uuidOf(doc.created_by) : null,
    archivedAt: doc.archived_at ?? null,
    archivedBy: doc.archived_by ? uuidOf(doc.archived_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function toOrgGroupRow(doc: OrgGroupDoc): typeof orgGroups.$inferSelect {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    name: doc.name,
    description: doc.description ?? null,
    createdBy: doc.created_by ? uuidOf(doc.created_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function toOrgServiceAccountRow(
  doc: OrgServiceAccountDoc,
): typeof orgServiceAccounts.$inferSelect {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    name: doc.name,
    description: doc.description ?? null,
    status: doc.status,
    scopes: doc.scopes ?? [],
    // Token fields are omitted (not null) on docs with no token — the
    // sparse unique index keeps those docs out of the index entirely.
    tokenHash: doc.token_hash ?? null,
    tokenPrefix: doc.token_prefix ?? null,
    tokenExpiresAt: doc.token_expires_at ?? null,
    tokenLastUsedAt: doc.token_last_used_at ?? null,
    tokenLastRotatedAt: doc.token_last_rotated_at ?? null,
    createdBy: doc.created_by ? uuidOf(doc.created_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function toOrgSettingsRow(doc: OrgSettingsDoc): typeof orgSettings.$inferSelect {
  return {
    orgId: uuidOf(doc.org_id),
    kind: doc.kind,
    supportEmail: doc.support_email ?? null,
    defaultProjectId: doc.default_project_id ? uuidOf(doc.default_project_id) : null,
    branding: doc.branding ?? {},
    preferences: doc.preferences ?? {},
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── unique-index ensurement (plan D7) ───────────────────────────────────────

/**
 * Create the unique indexes the furniture writes rely on, once per `Db`
 * handle. These mirror the PostgreSQL unique constraints the pg lane
 * depends on; the migration registry is owned by another worker, so the
 * repository ensures them defensively here. Idempotent — `createIndex`
 * with the same name and spec is a no-op.
 *
 * `org_service_accounts.token_hash` is ensured as a SPARSE unique index
 * under a lane-specific name: token fields are omitted (not null) on
 * token-less docs, so the sparse index keeps those docs out of the index
 * and multiple null-token docs stay legal exactly like pg's NULL-distinct
 * unique semantics.
 */
const ensuredFurnitureDatabases = new WeakSet<Db>();

export async function ensureFurnitureIndexes(db: Db): Promise<void> {
  if (ensuredFurnitureDatabases.has(db)) return;
  await db
    .collection('product_entitlements')
    .createIndex({ org_id: 1, product: 1 }, { unique: true, name: 'uq_product_entitlements_org_product' });
  await db
    .collection('projects')
    .createIndex({ org_id: 1, name: 1 }, { unique: true, name: 'uq_projects_org_name' });
  await db
    .collection('org_groups')
    .createIndex({ org_id: 1, name: 1 }, { unique: true, name: 'uq_org_groups_org_name' });
  await db
    .collection('org_group_members')
    .createIndex({ group_id: 1, account_id: 1 }, { unique: true, name: 'pk_org_group_members' });
  await db.collection('org_service_accounts').createIndex(
    { token_hash: 1 },
    { unique: true, sparse: true, name: 'uq_org_service_accounts_token_hash_sparse' },
  );
  await db
    .collection('org_settings')
    .createIndex({ org_id: 1 }, { unique: true, name: 'pk_org_settings' });
  ensuredFurnitureDatabases.add(db);
}

// ── cluster agents append aggregate doc shapes + row mappers below ────────

// ═══════════════════════════════════════════════════════════════════════════
// memberships + invites cluster (P3)
// Doc shapes follow plan D4: snake_case pg column names, UUIDs as BSON
// Binary subtype 4, timestamps as ISO-8601 strings. Nullable columns are
// written as explicit nulls on insert (never undefined) so `{ field: null }`
// filters match both null and missing, mirroring pg `IS NULL`.
// ═══════════════════════════════════════════════════════════════════════════

/** org_memberships document. */
export interface MembershipMongoDoc {
  id: Binary;
  account_id: Binary;
  org_id: Binary;
  role: string;
  status: string;
  invited_by: Binary | null;
  last_active_at: string | null;
  suspended_at: string | null;
  suspended_by: Binary | null;
  created_at: string;
  updated_at: string;
}

/** org_invites document. */
export interface InviteMongoDoc {
  id: Binary;
  org_id: Binary;
  email: string;
  role: string;
  token_hash: string;
  invited_by: Binary;
  expires_at: string;
  accepted_at: string | null;
  attempts: number;
  revoked_at: string | null;
  resend_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * org_invite_create_locks document — the mongo-lane serializer for the
 * invite-creation race (see the invite repository). `_id` is deliberately an
 * explicit string (not the driver ObjectId): single-doc insert atomicity on
 * a deterministic key is the whole mechanism. This is the one sanctioned
 * exception to the "never override _id" rule.
 */
export interface InviteCreateLockMongoDoc {
  _id: string;
  created_at: string;
}

/** Minimal identity-plane accounts shape needed by the membership inventory. */
export interface AccountMongoDoc {
  id: Binary;
  email: string;
  display_name: string | null;
  mfa_level: string;
  email_verified_at: string | null;
  last_login_at: string | null;
}

/** org_groups document (name lookup for the member inventory). */
export interface GroupMongoDoc {
  id: Binary;
  org_id: Binary;
  name: string;
}

/** org_group_members junction document. */
export interface GroupMemberMongoDoc {
  group_id: Binary;
  account_id: Binary;
  org_id: Binary;
}

/** Minimal org_service_accounts shape (status counts for the summary card). */
export interface ServiceAccountMongoDoc {
  id: Binary;
  org_id: Binary;
  status: string;
}

/** Minimal product_entitlements shape (seat cards + the addMember seat wall). */
export interface EntitlementMongoDoc {
  id: Binary;
  org_id: Binary;
  product: string;
  plan: string;
  status: string;
  seats: number | null;
}

// ── row mappers (BSON → pg-shaped rows) ────────────────────────────────────
// The repository interfaces carry pg-shaped row types (drizzle $inferSelect).
// These mappers are the mongo lane's side of that contract.

export interface MembershipRowShape {
  id: string;
  accountId: string;
  orgId: string;
  role: string;
  status: string;
  invitedBy: string | null;
  lastActiveAt: string | null;
  suspendedAt: string | null;
  suspendedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toMembershipRow(doc: MembershipMongoDoc): MembershipRowShape {
  return {
    id: uuidOf(doc.id),
    accountId: uuidOf(doc.account_id),
    orgId: uuidOf(doc.org_id),
    role: doc.role,
    status: doc.status,
    invitedBy: doc.invited_by ? uuidOf(doc.invited_by) : null,
    lastActiveAt: doc.last_active_at,
    suspendedAt: doc.suspended_at,
    suspendedBy: doc.suspended_by ? uuidOf(doc.suspended_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export interface InviteRowShape {
  id: string;
  orgId: string;
  email: string;
  role: string;
  tokenHash: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  attempts: number;
  revokedAt: string | null;
  resendCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toInviteRow(doc: InviteMongoDoc): InviteRowShape {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    email: doc.email,
    role: doc.role,
    tokenHash: doc.token_hash,
    invitedBy: uuidOf(doc.invited_by),
    expiresAt: doc.expires_at,
    acceptedAt: doc.accepted_at,
    attempts: doc.attempts,
    revokedAt: doc.revoked_at,
    resendCount: doc.resend_count,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── index ensurement (plan D7) ──────────────────────────────────────────────
// Mirrors the PostgreSQL constraints the pg lane depends on
// (mongo migration registry 0001_engine_core.ts is the authority; the
// repository ensures them defensively). Idempotent — createIndex with the
// same name and spec is a no-op.

const ensuredMembershipDatabases = new WeakSet<Db>();

export async function ensureMembershipIndexes(db: Db): Promise<void> {
  if (ensuredMembershipDatabases.has(db)) return;
  await db.collection('org_memberships').createIndex(
    { id: 1 },
    { unique: true, name: 'pk_org_memberships' },
  );
  await db.collection('org_memberships').createIndex(
    { account_id: 1, org_id: 1 },
    { unique: true, name: 'uq_org_memberships_account_org' },
  );
  // The exactly-one-active-owner backstop (pg uq_one_active_owner_per_org,
  // drizzle/0044): any write that would leave a second active owner fails
  // at the database; repositories translate the duplicate-key into the
  // stable conflict error.
  await db.collection('org_memberships').createIndex(
    { org_id: 1 },
    {
      unique: true,
      name: 'uq_one_active_owner_per_org',
      partialFilterExpression: { role: 'owner', status: 'active' },
    },
  );
  ensuredMembershipDatabases.add(db);
}

const ensuredInviteDatabases = new WeakSet<Db>();

export async function ensureInviteIndexes(db: Db): Promise<void> {
  if (ensuredInviteDatabases.has(db)) return;
  await db.collection('org_invites').createIndex(
    { id: 1 },
    { unique: true, name: 'pk_org_invites' },
  );
  await db.collection('org_invites').createIndex(
    { org_id: 1, email: 1 },
    { name: 'ix_org_invites_org_email' },
  );
  // Leaked-lock hygiene for the create serializer: the lock doc is deleted
  // in a `finally` on the happy path; the TTL reaps it if the process dies
  // between insert and delete (a stale lock only ever degrades to a
  // duplicate-key → poll → replay/conflict, never to a duplicate invite).
  await db.collection('org_invite_create_locks').createIndex(
    { created_at: 1 },
    { expireAfterSeconds: 300, name: 'ttl_org_invite_create_locks' },
  );
  ensuredInviteDatabases.add(db);
}

// ═══════════════════════════════════════════════════════════════════════════
// info + lifecycle + access clusters (P3)
// Doc shapes follow plan D4: snake_case pg column names, UUIDs as BSON
// Binary subtype 4, timestamps as ISO-8601 strings. Nullable columns are
// written as explicit nulls on insert (never undefined) so `{ field: null }`
// filters match both null and missing, mirroring pg `IS NULL`.
// ═══════════════════════════════════════════════════════════════════════════

import type { OrgBrief } from './org-info.repository';
import type { DeletionRow } from './org-lifecycle.repository';

/**
 * `tenants` document (Python-owned table). Mirrors `legacyTenants` column
 * for column: `id`/`slug`/`name` are varchar(36/128/256) on pg and are
 * stored as BSON Binary subtype 4 on this lane per plan D4 (the billing
 * lane's `TenantMongoDoc` already binds `id` as Binary). `features.deleted`
 * is the purge-pass deleted marker (SQL: `coalesce(features->>'deleted',
 * 'false')::boolean` — JSON `true` or the string `'true'` both read true).
 */
export interface InfoTenantMongoDoc {
  id: Binary;
  slug: string;
  name: string;
  allowed_topics: unknown;
  blocked_topics: unknown;
  escalation_threshold: number;
  knowledge_allowlist: unknown;
  default_provider: string;
  default_model: string;
  features: Record<string, unknown>;
  guardrail_config: unknown;
  guardrail_thresholds: unknown;
  region: string | null;
  retention_days: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** `org_deletions` document (pg primary key is `org_id`). */
export interface OrgDeletionMongoDoc {
  org_id: Binary;
  requested_by: Binary;
  status: string;
  scheduled_purge_at: string;
  purged_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Minimal `api_keys` shape for the deletion-request revocation unit. The
 * Python-owned table keys tenancy on `organization_id` (Binary) on this
 * lane, NOT `tenant_id` — the mongo port of the legacy schema flattened the
 * column name; the predicate stays explicit either way.
 */
export interface ApiKeyMongoDoc {
  id: Binary;
  organization_id: Binary;
  revoked: boolean;
  updated_at: string;
}

// ── row mappers (BSON → pg-shaped rows) ────────────────────────────────────

export function toOrgBrief(doc: InfoTenantMongoDoc): OrgBrief {
  const deleted = doc.features?.deleted;
  return {
    id: uuidOf(doc.id),
    name: doc.name,
    slug: doc.slug,
    createdAt: doc.created_at ?? null,
    // Coalesce like the pg lane's
    // `coalesce(features->>'deleted', 'false')::boolean`.
    markedDeleted: deleted === true || deleted === 'true',
  };
}

export function toOrgDeletionRow(doc: OrgDeletionMongoDoc): DeletionRow {
  return {
    orgId: uuidOf(doc.org_id),
    requestedBy: uuidOf(doc.requested_by),
    status: doc.status,
    scheduledPurgeAt: doc.scheduled_purge_at,
    purgedAt: doc.purged_at,
    cancelledAt: doc.cancelled_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── index ensurement (plan D7) ──────────────────────────────────────────────
// The writes in the info/access/lifecycle lanes rely on these unique
// indexes; the migration registry (0001_engine_core.ts) owns them, and the
// repositories ensure them defensively here (idempotent createIndex).

const ensuredInfoDatabases = new WeakSet<Db>();

export async function ensureInfoIndexes(db: Db): Promise<void> {
  if (ensuredInfoDatabases.has(db)) return;
  // The slug-collision → ApiError.conflict('slug_taken') translation in
  // createOrgWithOwner depends on this index.
  await db.collection('tenants').createIndex(
    { slug: 1 },
    { unique: true, name: 'uq_tenants_slug' },
  );
  await db.collection('tenants').createIndex(
    { id: 1 },
    { unique: true, name: 'pk_tenants' },
  );
  ensuredInfoDatabases.add(db);
}

const ensuredLifecycleDatabases = new WeakSet<Db>();

export async function ensureLifecycleIndexes(db: Db): Promise<void> {
  if (ensuredLifecycleDatabases.has(db)) return;
  // requestDeletion upserts on this key; the (status, scheduled_purge_at)
  // scan index is non-unique and already owned by the migration registry.
  await db.collection('org_deletions').createIndex(
    { org_id: 1 },
    { unique: true, name: 'pk_org_deletions' },
  );
  ensuredLifecycleDatabases.add(db);
}
