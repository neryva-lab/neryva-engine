import { index, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Lifecycle & compliance persistence — Phase 9 (drizzle/0028_lifecycle.sql).
 * Deletion/retention/export/legal-hold are first-class workflows (invariant 11).
 */

export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    retentionClass: varchar('retention_class', { length: 32 }).notNull(),
    /** { keep_days: number } — evaluated against the resource's created_at. */
    keepUntilRule: jsonb('keep_until_rule').notNull(),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_retention_policies_org').on(t.organizationId, t.resourceType)],
);

export const legalHolds = pgTable(
  'legal_holds',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    /** organization | user | conversation | assistant */
    scopeType: varchar('scope_type', { length: 32 }).notNull(),
    scopeId: uuid('scope_id'),
    holdReason: varchar('hold_reason', { length: 512 }).notNull(),
    placedBy: varchar('placed_by', { length: 128 }).notNull(),
    /** active | released */
    status: varchar('status', { length: 32 }).notNull().default('active'),
    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [index('ix_legal_holds_scope').on(t.organizationId, t.scopeType, t.scopeId, t.status)],
);

export const exportRequests = pgTable('export_requests', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  actorId: varchar('actor_id', { length: 128 }).notNull(),
  scope: jsonb('scope').notNull(),
  manifest: jsonb('manifest'),
  /** pending | generating | ready | expired | failed */
  state: varchar('state', { length: 32 }).notNull().default('pending'),
  artifactId: uuid('artifact_id'),
  encryptionKeyRef: varchar('encryption_key_ref', { length: 128 }),
  /** SHA-256 of the one-time download token — the token itself is never stored. */
  downloadTokenHash: varchar('download_token_hash', { length: 64 }),
  downloadCount: integer('download_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
});

export const purgeTasks = pgTable(
  'purge_tasks',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    /** organization | user | conversation | assistant */
    scopeType: varchar('scope_type', { length: 32 }).notNull(),
    scopeId: uuid('scope_id').notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    /** pending | in_progress | done | failed | blocked */
    state: varchar('state', { length: 32 }).notNull().default('pending'),
    /** authorize → check_holds → mark_unavailable → emit_derived_deletion → purge_objects → purge_content → tombstone → done */
    step: varchar('step', { length: 32 }).notNull().default('authorize'),
    lastError: varchar('last_error', { length: 4096 }),
    evidence: jsonb('evidence'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [index('ix_purge_tasks_state').on(t.state, t.createdAt)],
);

export const tombstones = pgTable(
  'tombstones',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id'),
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    purgedAt: timestamp('purged_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_tombstones_resource').on(t.resourceType, t.resourceId)],
);

export const dataAccessRecords = pgTable(
  'data_access_records',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id'),
    actorType: varchar('actor_type', { length: 32 }).notNull(),
    actorId: varchar('actor_id', { length: 128 }).notNull(),
    /** export_download | sensitive_read | support_access | policy_change | impersonation */
    accessType: varchar('access_type', { length: 32 }).notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    resourceId: uuid('resource_id'),
    justification: varchar('justification', { length: 512 }),
    traceId: varchar('trace_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_dar_created').on(t.createdAt)],
);

export type RetentionPolicy = typeof retentionPolicies.$inferSelect;
export type LegalHold = typeof legalHolds.$inferSelect;
export type ExportRequest = typeof exportRequests.$inferSelect;
export type PurgeTask = typeof purgeTasks.$inferSelect;
export type Tombstone = typeof tombstones.$inferSelect;
