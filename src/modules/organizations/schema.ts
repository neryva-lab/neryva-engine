import { randomUUID } from 'node:crypto';
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Org furniture (doc-06 §11, Δ2/Δ3/Δ4, engine-owned from creation — eng-0002).
 *
 * CRITICAL: `org_id` is varchar(36), NOT uuid, and carries NO foreign key —
 * it references the Python-owned `tenants.id` (String(36) in SQLAlchemy).
 * Cross-system references go by id + contract reads (partitioning §5),
 * never by FK into another system's table. RLS isolates by org_id (see
 * eng-0002 policies) with the documented engine-bypass escape hatch.
 */

/** org = the existing tenants table; memberships are the tenant-scoped junction (doc-06 §4). */
export const orgMemberships = pgTable('org_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  role: varchar('role', { length: 16 }).notNull(), // owner | admin | billing | developer | reader
  status: varchar('status', { length: 16 }).notNull().default('active'), // active | suspended | removed
  invitedBy: uuid('invited_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_org_memberships_account_org').on(t.accountId, t.orgId),
  index('ix_org_memberships_org').on(t.orgId),
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_org_invites_org').on(t.orgId)]);

/** Projects: sub-org containers scoping keys, limits, usage (Δ2). */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: varchar('description', { length: 512 }),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_projects_org_name').on(t.orgId, t.name)]);

/**
 * Entitlements (O-1/O-2): which product, which plan, which state. The state
 * machine (none→trial→active→past_due→suspended→expired) is platform-owned
 * — products read state; only billing events move it, each transition audited.
 */
export const productEntitlements = pgTable('product_entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  product: varchar('product', { length: 64 }).notNull(),
  plan: varchar('plan', { length: 64 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(), // trial | active | past_due | suspended | expired
  limits: jsonb('limits').notNull().default({}),
  periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }),
  periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_product_entitlements_org_product').on(t.orgId, t.product)]);

export type OrgRole = 'owner' | 'admin' | 'billing' | 'developer' | 'reader';
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'billing', 'developer', 'reader'] as const;

export function newId(): string {
  return randomUUID();
}
