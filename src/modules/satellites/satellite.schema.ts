import { jsonb, pgTable, timestamp, varchar, index } from 'drizzle-orm/pg-core';

/**
 * The satellite registry (ADR-006 D2 contract part 4, engine side): one row
 * per connected capability deployment. Products appear on /console/home via
 * MANIFESTS; satellites are the deployables behind them — this table is the
 * operational view: what is connected, where it routes, and whether it is
 * alive (heartbeats).
 *
 * `inference` is PRE-REGISTERED as a placeholder row exactly per its ledger
 * ("placeholder — trigger-gated so the pattern is fixed before the pressure
 * arrives"): it exists here with status `placeholder`, gets NO routes, NO
 * manifest, and NO entitlements until an ADR-002 register amendment opens
 * it (ADR-006 D4).
 */
export const satellites = pgTable('satellites', {
  /** Stable key, e.g. "agent-runtime", "inference". */
  key: varchar('key', { length: 64 }).primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(), // agent-runtime | inference | custom
  status: varchar('status', { length: 16 }).notNull().default('active'), // active | placeholder | offline | retired
  /** Route prefixes this satellite serves behind the proxy (informational mirror of the proxy table). */
  routePrefixes: jsonb('route_prefixes').notNull().default([]),
  /** The L3 service client id it authenticates as. */
  serviceClientId: varchar('service_client_id', { length: 64 }),
  /** The product keys it provides capacity for (join to manifests). */
  products: jsonb('products').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'string' }),
  lastHeartbeatVersion: varchar('last_heartbeat_version', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_satellites_status').on(t.status)]);

export type Satellite = typeof satellites.$inferSelect;

/** A satellite is considered degraded when its heartbeat is older than this. */
export const HEARTBEAT_TIMEOUT_SECONDS = 120;
