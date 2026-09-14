import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Platform template kill — REL-6.1 (release_ledger.md, drizzle/0054). A
 * GLOBAL staff-written block: while an active row exists for a slug, new
 * installs refuse and new release pointers for assistants installed from
 * that slug refuse. Not RLS'd (price_catalog posture — the staff surface is
 * the access control); every write is audited. One active block per slug
 * (partial unique index); lifting records who/why and keeps history.
 */
export const templatePlatformBlocks = pgTable(
  'template_platform_blocks',
  {
    id: uuid('id').primaryKey(),
    slug: varchar('slug', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 512 }).notNull(),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    liftedAt: timestamp('lifted_at', { withTimezone: true, mode: 'string' }),
    liftedBy: varchar('lifted_by', { length: 128 }),
  },
  (t) => [
    uniqueIndex('uq_template_platform_blocks_active').on(t.slug).where(sql`lifted_at is null`),
    index('ix_template_platform_blocks_slug').on(t.slug, t.createdAt),
  ],
);

export type TemplatePlatformBlock = typeof templatePlatformBlocks.$inferSelect;
