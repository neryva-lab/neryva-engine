/**
 * Cutover collection registry — derived from the migration manifest, not hand-written.
 *
 * The authoritative collection list comes from `ENGINE_CORE_COLLECTIONS` in
 * `src/common/infra/db/mongo/migrations/mongo/0001_engine_core.ts` (the same
 * manifest that provisions the mongo collections). The per-column type info
 * comes from runtime introspection of the drizzle table objects via
 * `getTableColumns()` — this tells us exactly which columns are UUIDs,
 * timestamps, numerics, etc., without name heuristics.
 *
 * To regenerate: the registry is built at import time from the manifest +
 * drizzle schemas. No code generation step is needed; if the manifest or a
 * schema changes, the registry picks it up automatically.
 */
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { ENGINE_CORE_COLLECTIONS } from '../common/infra/db/mongo/migrations/mongo/0001_engine_core';

// Import all module schemas. Each exports drizzle table objects.
import * as assistantsSchema from '../modules/assistants/schema';
import * as assistantsModelCatalogSchema from '../modules/assistants/model-catalog.schema';
import * as assistantsModelCostSchema from '../modules/assistants/model-cost.schema';
import * as assistantsProviderCredsSchema from '../modules/assistants/provider-credentials.schema';
import * as assistantsTemplateBlocksSchema from '../modules/assistants/template-blocks.schema';
import * as assistantsToolCatalogSchema from '../modules/assistants/tool-catalog.schema';
import * as billingSchema from '../modules/billing/schema';
import * as billingExtensionSchema from '../modules/billing/billing-extension.schema';
import * as billingUsageLedgerSchema from '../modules/billing/usage-ledger.schema';
import * as channelsSchema from '../modules/channels/schema';
import * as configPublishSchema from '../modules/config-publish/config-publish.schema';
import * as consoleAnnouncementsSchema from '../modules/console/announcements.schema';
import * as conversationsSchema from '../modules/conversations/schema';
import * as conversationsEscalationsSchema from '../modules/conversations/escalations.schema';
import * as conversationsMcpSchema from '../modules/conversations/mcp.schema';
import * as corporateEmailSchema from '../modules/corporate/email/schema';
import * as corporatePublicSchema from '../modules/corporate/public.schema';
import * as deploymentSchema from '../modules/deployment/schema';
import * as identitySchema from '../modules/identity/schema';
import * as knowledgeSchema from '../modules/knowledge/schema';
import * as knowledgeConnectorsSchema from '../modules/knowledge/connectors.schema';
import * as knowledgeEvalSchema from '../modules/knowledge/eval.schema';
import * as lifecycleSchema from '../modules/lifecycle/lifecycle.schema';
import * as notificationsSchema from '../modules/notifications/schema';
import * as organizationsSchema from '../modules/organizations/schema';
import * as satellitesSchema from '../modules/satellites/satellite.schema';
import * as staffSchema from '../modules/staff/schema';
import * as studioFurnitureSchema from '../modules/studio-furniture/schema';
import * as webhooksSchema from '../modules/webhooks/schema';
import * as authPlatformStaffSchema from '../common/auth/platform-staff.schema';
import * as httpIdempotencySchema from '../common/http/idempotency-records';
import * as portsIdempotencySchema from '../common/infra/db/ports/idempotency';
import * as outboxSchema from '../common/infra/outbox/schema';
import * as legacySchema from '../common/infra/db/legacy-schema';

const SCHEMA_MODULES = [
  assistantsSchema,
  assistantsModelCatalogSchema,
  assistantsModelCostSchema,
  assistantsProviderCredsSchema,
  assistantsTemplateBlocksSchema,
  assistantsToolCatalogSchema,
  billingSchema,
  billingExtensionSchema,
  billingUsageLedgerSchema,
  channelsSchema,
  configPublishSchema,
  consoleAnnouncementsSchema,
  conversationsSchema,
  conversationsEscalationsSchema,
  conversationsMcpSchema,
  corporateEmailSchema,
  corporatePublicSchema,
  deploymentSchema,
  identitySchema,
  knowledgeSchema,
  knowledgeConnectorsSchema,
  knowledgeEvalSchema,
  lifecycleSchema,
  notificationsSchema,
  organizationsSchema,
  satellitesSchema,
  staffSchema,
  studioFurnitureSchema,
  webhooksSchema,
  authPlatformStaffSchema,
  httpIdempotencySchema,
  portsIdempotencySchema,
  outboxSchema,
  legacySchema,
];

/** Drizzle column type → cutover column kind. */
export type ColumnKind =
  | 'uuid'
  | 'timestamp'
  | 'numeric'
  | 'integer'
  | 'bigint'
  | 'boolean'
  | 'json'
  | 'text'
  | 'array'
  | 'passthrough';

/**
 * Map a drizzle columnType string to our ColumnKind.
 * Column types observed: PgUUID, PgVarchar, PgText, PgJsonb, PgTimestampString,
 * PgTimestamp, PgBoolean, PgInteger, PgBigInt64, PgNumeric, PgArray, etc.
 */
export function columnKindFor(drizzleType: string): ColumnKind {
  switch (drizzleType) {
    case 'PgUUID':
      return 'uuid';
    case 'PgTimestamp':
    case 'PgTimestampString':
      return 'timestamp';
    case 'PgNumeric':
      return 'numeric';
    case 'PgInteger':
    case 'PgSmallInt':
      return 'integer';
    case 'PgBigInt53':
    case 'PgBigInt64':
      return 'bigint';
    case 'PgBoolean':
      return 'boolean';
    case 'PgJsonb':
    case 'PgJson':
      return 'json';
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
      return 'text';
    case 'PgArray':
      return 'array';
    default:
      return 'passthrough';
  }
}

/** Per-collection mapping: mongo name, pg table, and column type info. */
export interface CollectionMapping {
  /** MongoDB collection name (e.g. "channel_accounts"). */
  readonly mongoName: string;
  /** Exact pg table name, schema-qualified where applicable (e.g. "billing.spend_events"). */
  readonly pgTable: string;
  /** SQL-quoted pg table reference for queries (e.g. `"billing"."spend_events"`). */
  readonly pgQuoted: string;
  /** Map from DB column name (snake_case) → ColumnKind. */
  readonly columns: ReadonlyMap<string, ColumnKind>;
  /** Required fields from the mongo validator (must never be undefined). */
  readonly requiredFields: readonly string[];
  /** Primary key column name (for keyset pagination and upsert). Defaults to "id". */
  readonly pkColumn: string;
}

/**
 * Build the pgTable → drizzle table lookup.
 * Key format matches the manifest: "schema.table" or just "table" for public.
 */
function buildTableLookup(): Map<string, PgTable> {
  const lookup = new Map<string, PgTable>();
  const NAME = Symbol.for('drizzle:Name');
  const SCHEMA = Symbol.for('drizzle:Schema');
  for (const mod of SCHEMA_MODULES) {
    for (const val of Object.values(mod)) {
      if (is(val, PgTable)) {
        const table = val as unknown as Record<symbol, unknown>;
        const name = table[NAME] as string;
        const schema = table[SCHEMA] as string | undefined;
        const key = schema ? `${schema}.${name}` : name;
        if (!lookup.has(key)) {
          lookup.set(key, val as PgTable);
        }
      }
    }
  }
  return lookup;
}

/** SQL-quote an identifier. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Build a schema-qualified, quoted table reference. */
function quotedTableRef(pgTable: string): string {
  const parts = pgTable.split('.');
  if (parts.length === 2) {
    return `${quoteIdent(parts[0])}.${quoteIdent(parts[1])}`;
  }
  return quoteIdent(pgTable);
}

/** Extract required field names from a collection's validator. */
function requiredFromValidator(validator: unknown): string[] {
  if (
    validator &&
    typeof validator === 'object' &&
    '$jsonSchema' in validator &&
    validator.$jsonSchema &&
    typeof validator.$jsonSchema === 'object' &&
    'required' in validator.$jsonSchema &&
    Array.isArray(validator.$jsonSchema.required)
  ) {
    return (validator.$jsonSchema.required as unknown[]).filter(
      (f): f is string => typeof f === 'string',
    );
  }
  return [];
}

/** Find the primary key column from the indexes (pk_<name> unique index). */
function pkFromIndexes(
  indexes: readonly import('mongodb').IndexDescription[],
  fallback = 'id',
): string {
  for (const idx of indexes) {
    if (idx.unique && idx.name?.startsWith('pk_')) {
      const key = idx.key;
      const keys = key instanceof Map ? [...key.keys()] : Object.keys(key);
      if (keys.length === 1) return keys[0];
    }
  }
  return fallback;
}

/**
 * The full cutover registry: one entry per collection in the migration manifest.
 * Built once at import time.
 */
export const CUTOVER_REGISTRY: readonly CollectionMapping[] = (() => {
  const tables = buildTableLookup();
  const registry: CollectionMapping[] = [];

  for (const spec of ENGINE_CORE_COLLECTIONS) {
    const table = tables.get(spec.pgTable);
    const columns = new Map<string, ColumnKind>();

    if (table) {
      const drizzleCols = getTableColumns(table);
      for (const col of Object.values(drizzleCols)) {
        const c = col as { name: string; columnType: string };
        columns.set(c.name, columnKindFor(c.columnType));
      }
    }
    // If no drizzle table is found, columns stays empty and the mapper falls
    // back to name-heuristic + passthrough. This is logged at runtime.

    registry.push({
      mongoName: spec.name,
      pgTable: spec.pgTable,
      pgQuoted: quotedTableRef(spec.pgTable),
      columns,
      requiredFields: requiredFromValidator(spec.validator),
      pkColumn: pkFromIndexes(spec.indexes),
    });
  }

  return registry;
})();

/** Look up a collection mapping by mongo name. */
export function getCollection(mongoName: string): CollectionMapping | undefined {
  return CUTOVER_REGISTRY.find((c) => c.mongoName === mongoName);
}

/** Collections that have no drizzle table (mapper falls back to heuristics). */
export function collectionsWithoutSchema(): CollectionMapping[] {
  return CUTOVER_REGISTRY.filter((c) => c.columns.size === 0);
}
