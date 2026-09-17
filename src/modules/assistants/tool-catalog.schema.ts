import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Tool catalog — org-scoped, versioned tool definitions (ai_harness_plan.md
 * H0.2, drizzle/0032). Assistant versions pin catalog entries by `hash` at
 * publish time (tool_policy.tools[].schema_hash), so a run can never see a
 * mutated schema. Contract v1.1 ToolDescriptor carries
 * description/input_schema_json/annotations from here.
 */
export const toolCatalog = pgTable(
  'tool_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    version: varchar('version', { length: 32 }).notNull().default('1.0.0'),
    description: varchar('description', { length: 2048 }),
    inputSchema: jsonb('input_schema').notNull(),
    outputSchema: jsonb('output_schema'),
    /** READ_ONLY | MUTATING | DESTRUCTIVE — orthogonal to approval. */
    effectClass: varchar('effect_class', { length: 16 }).notNull().default('READ_ONLY'),
    /** NONE | REQUIRED — orthogonal to effect class. */
    approvalRequirement: varchar('approval_requirement', { length: 16 }).notNull().default('NONE'),
    /** Advisory MCP-aligned hints: {read_only, destructive, idempotent, open_world}. */
    annotations: jsonb('annotations').notNull().default({}),
    /** FL-2.10: customer HTTP endpoint binding {url, method, timeout_ms, header_name}. */
    httpBinding: jsonb('http_binding'),
    /**
     * P4 (execution perimeter): in_process | sandboxed_microvm |
     * external_gateway. Default external_gateway (the pre-P4 posture).
     * in_process rows must carry no http_binding and no egress list (pure
     * compute over arguments — enforced at upsert, not here).
     */
    executionEnvironment: varchar('execution_environment', { length: 24 })
      .notNull()
      .default('external_gateway'),
    /** P4: declared egress allowlist (JSON string array) — null = none declared. */
    allowedEgressDomains: jsonb('allowed_egress_domains'),
    /** FL-2.10: envelope-sealed (enc:v1:) per-tool credential — never in the manifest. */
    credentialSealed: text('credential_sealed'),
    /** FL-2.10: max executions per run (default platform cap when null). */
    rateLimitPerRun: integer('rate_limit_per_run'),
    /** Canonical sha256 of the tool definition — the publish pin target. */
    hash: varchar('hash', { length: 64 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_tool_catalog_org_name').on(t.organizationId, t.name),
    index('ix_tool_catalog_org_enabled').on(t.organizationId, t.enabled, t.updatedAt),
  ],
);

export type ToolCatalogEntry = typeof toolCatalog.$inferSelect;

export const TOOL_EFFECT_CLASSES = ['READ_ONLY', 'MUTATING', 'DESTRUCTIVE'] as const;
export const TOOL_APPROVAL_REQUIREMENTS = ['NONE', 'REQUIRED'] as const;
/** P4: where a tool may execute. */
export const TOOL_EXECUTION_ENVIRONMENTS = [
  'in_process',
  'sandboxed_microvm',
  'external_gateway',
] as const;
/** P4: per-binding execution mode (version payload choice, default live). */
export const TOOL_EXECUTION_MODES = ['live', 'shadow'] as const;

export interface ToolAnnotations {
  read_only?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  open_world?: boolean;
}
