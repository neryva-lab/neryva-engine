import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Platform announcements (statuspage-grade): maintenance windows, product
 * GA notices, incident posts — staff-authored (L2 operator-gated at the
 * controller), rendered on /console/home and /console/status.
 * `active_from/until` control the visibility window; resolving an incident
 * CLOSES the window (rows are kept — the history IS the status page).
 */
export const consoleAnnouncements = pgTable('console_announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** maintenance | incident | notice | product_release */
  kind: varchar('kind', { length: 32 }).notNull(),
  severity: varchar('severity', { length: 16 }).notNull().default('info'), // info | warn | critical | resolved
  title: varchar('title', { length: 256 }).notNull(),
  body: varchar('body', { length: 4000 }).notNull().default(''),
  /** Console route or external URL the announcement points at (optional). */
  link: varchar('link', { length: 512 }),
  activeFrom: timestamp('active_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  activeUntil: timestamp('active_until', { withTimezone: true, mode: 'string' }),
  publishedBy: varchar('published_by', { length: 128 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_console_announcements_window').on(t.activeFrom, t.activeUntil)]);

export type ConsoleAnnouncementRow = typeof consoleAnnouncements.$inferSelect;
