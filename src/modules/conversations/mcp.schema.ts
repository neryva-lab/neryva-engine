import { customType, index, integer, jsonb, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { runs } from './schema';

/** PostgreSQL bytea — digests are 32 raw bytes, never hex strings. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * MCP authority persistence — Phase 5 (drizzle/0024_mcp_authority.sql).
 * These tables serve the Engine authority side of neryva.mcp.v1; every table
 * is organization-scoped with the standard RLS FORCE policy.
 */

export const runIdempotency = pgTable(
  'run_idempotency',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id').notNull(),
    callerScope: varchar('caller_scope', { length: 128 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('IN_PROGRESS'),
    resourceRef: jsonb('resource_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [index('ix_run_idempotency_run').on(t.runId, t.expiresAt)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    approvalRef: varchar('approval_ref', { length: 64 }).notNull(),
    summary: varchar('summary', { length: 512 }).notNull(),
    actionType: varchar('action_type', { length: 64 }),
    policyVersion: varchar('policy_version', { length: 32 }),
    /** PENDING | APPROVED | DENIED | EXPIRED */
    state: varchar('state', { length: 32 }).notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    decisionActorId: varchar('decision_actor_id', { length: 128 }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
    decisionId: varchar('decision_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_approvals_run_state').on(t.runId, t.state)],
);

export const toolEffects = pgTable(
  'tool_effects',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: varchar('step_id', { length: 64 }),
    toolCallId: varchar('tool_call_id', { length: 128 }).notNull(),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    toolVersion: varchar('tool_version', { length: 32 }),
    argumentDigest: bytea('argument_digest'),
    resultDigest: bytea('result_digest'),
    status: varchar('status', { length: 32 }),
    resultArtifactId: uuid('result_artifact_id'),
    authorizedAt: timestamp('authorized_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [index('ix_tool_effects_run').on(t.runId, t.authorizedAt)],
);

export const checkpoints = pgTable(
  'checkpoints',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    checkpointRef: varchar('checkpoint_ref', { length: 64 }).notNull(),
    checkpointVersion: integer('checkpoint_version').notNull(),
    /** Claim-check forward reference — artifacts land in Phase 7. */
    artifactId: uuid('artifact_id'),
    digest: bytea('digest').notNull(),
    producer: varchar('producer', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_checkpoints_run').on(t.runId, t.createdAt)],
);

export const memoryProposals = pgTable(
  'memory_proposals',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    proposalRef: varchar('proposal_ref', { length: 64 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull(),
    value: varchar('value', { length: 8192 }).notNull(),
    provenance: varchar('provenance', { length: 1024 }),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    visibility: varchar('visibility', { length: 32 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    /** PENDING | APPROVED | REJECTED — a proposal is never durable memory (Phase 7 wires memory_items). */
    decision: varchar('decision', { length: 32 }).notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_memory_proposals_run').on(t.runId, t.decision)],
);

export type RunIdempotency = typeof runIdempotency.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type ToolEffect = typeof toolEffects.$inferSelect;
export type Checkpoint = typeof checkpoints.$inferSelect;
export type MemoryProposal = typeof memoryProposals.$inferSelect;
