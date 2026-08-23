import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Project-scoped key bindings (S-4, eng-0006): which API key belongs to
 * which project. The key ROWS stay Python-owned (api_keys — write authority
 * transfers at handover A-1); the BINDING is engine-owned from creation.
 * This keeps a single authority per fact: the engine never writes key rows,
 * the runtime never knows projects.
 *
 * Reference-by-id discipline (partitioning §5): api_key_id points at the
 * Python-owned api_keys.id (varchar 36, no FK); project_id points at the
 * engine-owned projects.id (uuid, validated in the service — RLS makes a
 * cross-schema FK awkward and the org-furniture pattern forbids it).
 *
 * One binding per key: spend emitted under the key carries the project tag
 * (S-5), so a key in two projects would blur per-project ledgers.
 */
export const studioProjectKeys = pgTable(
  'studio_project_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    apiKeyId: varchar('api_key_id', { length: 36 }).notNull(),
    projectId: uuid('project_id').notNull(),
    boundBy: uuid('bound_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_studio_project_keys_key').on(t.orgId, t.apiKeyId),
    index('ix_studio_project_keys_project').on(t.orgId, t.projectId),
  ],
);

export type ProjectKeyBinding = typeof studioProjectKeys.$inferSelect;
