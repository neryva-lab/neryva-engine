import { randomUUID } from 'node:crypto';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Org furniture (doc-06 §11, Δ2/Δ3/Δ4, engine-owned from creation — eng-0002;
 * dense pass eng-0009: groups, service accounts, settings, audit/export).
 *
 * CRITICAL: `org_id` is varchar(36), NOT uuid, and carries NO foreign key —
 * it references the Python-owned `tenants.id` (String(36) in SQLAlchemy).
 * Cross-system references go by id + contract reads (partitioning §5),
 * never by FK into another system's table. RLS isolates by org_id (see
 * eng-0002/eng-0009 policies) with the documented engine-bypass escape hatch.
 */

/** org = the existing tenants table; memberships are the tenant-scoped junction (doc-06 §4). */
export const orgMemberships = pgTable('org_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  role: varchar('role', { length: 16 }).notNull(), // owner | admin | billing | developer | reader
  status: varchar('status', { length: 16 }).notNull().default('active'), // active | suspended | removed
  invitedBy: uuid('invited_by'),
  /** Org-context activity heartbeat (throttled write from the roles guard read path). */
  lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'string' }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true, mode: 'string' }),
  suspendedBy: uuid('suspended_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_org_memberships_account_org').on(t.accountId, t.orgId),
  index('ix_org_memberships_org').on(t.orgId),
  index('ix_org_memberships_org_status').on(t.orgId, t.status),
]);

/** Invites are the only sanctioned join path (Δ3). Token: sha256 at rest, single-use, expiring. */
export const orgInvites = pgTable('org_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  role: varchar('role', { length: 16 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }),
  attempts: integer('attempts').notNull().default(0),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  resendCount: integer('resend_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  index('ix_org_invites_org').on(t.orgId),
  index('ix_org_invites_org_email').on(t.orgId, t.email),
]);

/** Projects: sub-org containers scoping keys, limits, usage (Δ2). */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: varchar('description', { length: 512 }),
  createdBy: uuid('created_by'),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  archivedBy: uuid('archived_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_projects_org_name').on(t.orgId, t.name)]);

/**
 * Entitlements (O-1/O-2): which product, which plan, which state. The state
 * machine (none→trial→active→past_due→suspended→expired) is platform-owned
 * — products read state; only billing events move it, each transition audited.
 * `seats` is the purchased seat count when the plan is seat-based (billing
 * writes it; the member surfaces read it for utilization). `source` tags the
 * moving event family (console.trial | billing.payment | billing.dunning |
 * billing.admin | org.deletion).
 */
export const productEntitlements = pgTable('product_entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  product: varchar('product', { length: 64 }).notNull(),
  plan: varchar('plan', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(), // trial | active | past_due | suspended | expired
  limits: jsonb('limits').notNull().default({}),
  seats: integer('seats'),
  source: varchar('source', { length: 32 }),
  periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }),
  periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_product_entitlements_org_product').on(t.orgId, t.product)]);

/** Engine-owned org profile/settings (one row per org, created lazily). */
export const orgSettings = pgTable('org_settings', {
  orgId: varchar('org_id', { length: 36 }).primaryKey(),
  supportEmail: varchar('support_email', { length: 320 }),
  defaultProjectId: uuid('default_project_id'),
  /** { logo_dataurl?, brand_color? } — caps enforced at the service layer. */
  branding: jsonb('branding').notNull().default({}),
  /** { default_runtime?, audit_retention_days?, log_retention_days?, auto_rollback?, canary_percentage? } */
  preferences: jsonb('preferences').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * Groups (WorkOS/benchmark pattern): named collections of memberships for
 * finer-grained access control. Products may map group membership to
 * capability grants; the org module owns only the furniture.
 */
export const orgGroups = pgTable('org_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: varchar('description', { length: 512 }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_org_groups_org_name').on(t.orgId, t.name)]);

/** Group membership junction. org_id is denormalized for the RLS policy shape. */
export const orgGroupMembers = pgTable('org_group_members', {
  groupId: uuid('group_id').notNull(),
  accountId: uuid('account_id').notNull(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  addedBy: uuid('added_by'),
  addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.groupId, t.accountId] }),
  index('ix_org_group_members_org').on(t.orgId),
  index('ix_org_group_members_account').on(t.accountId),
]);

/**
 * Service accounts (OpenAI-platform pattern): org-owned machine identities
 * shown in the member inventory alongside humans. Each holds at most one
 * active token (`nrv_sa_` prefix, sha256 at rest, returned exactly once on
 * create/rotate). Disabling or rotating voids the previous token — the
 * AuthGuard resolves these as L2 principals scoped to the org.
 */
export const orgServiceAccounts = pgTable('org_service_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: varchar('description', { length: 512 }),
  status: varchar('status', { length: 16 }).notNull().default('active'), // active | disabled
  scopes: jsonb('scopes').notNull().default([]),
  tokenHash: varchar('token_hash', { length: 64 }),
  tokenPrefix: varchar('token_prefix', { length: 32 }),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true, mode: 'string' }),
  tokenLastUsedAt: timestamp('token_last_used_at', { withTimezone: true, mode: 'string' }),
  tokenLastRotatedAt: timestamp('token_last_rotated_at', { withTimezone: true, mode: 'string' }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_org_service_accounts_token_hash').on(t.tokenHash),
  index('ix_org_service_accounts_org').on(t.orgId),
]);

export type OrgRole = 'owner' | 'admin' | 'billing' | 'developer' | 'reader';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'billing', 'developer', 'reader'] as const;
/** Roles that may be granted by invitation — ownership arrives only via transfer. */
export const INVITABLE_ROLES: readonly OrgRole[] = ['admin', 'billing', 'developer', 'reader'] as const;

/**
 * Staged org deletion (eng-0012): request → grace window (cancel-able) →
 * purge. Immediate effects on request: entitlements expired (audited),
 * invites revoked, org keys revoked, service-account tokens voided. The
 * purge job erases engine-owned rows after the grace window; financial
 * records (billing.*), the audit chain (append-only by construction), and
 * the tenants row itself (Python-owned DDL — marked deleted via its
 * features jsonb, a documented seam) are retained: billing keeps its legal
 * retention with a pseudonymous org id.
 */
export const orgDeletions = pgTable('org_deletions', {
  orgId: varchar('org_id', { length: 36 }).primaryKey(),
  requestedBy: uuid('requested_by').notNull(),
  /** requested | cancelled | purged */
  status: varchar('status', { length: 16 }).notNull().default('requested'),
  scheduledPurgeAt: timestamp('scheduled_purge_at', { withTimezone: true, mode: 'string' }).notNull(),
  purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'string' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_org_deletions_status_purge').on(t.status, t.scheduledPurgeAt)]);

export function newId(): string {
  return randomUUID();
}
