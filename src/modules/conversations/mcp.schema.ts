import { customType, index, integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
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
  (t) => [
    index('ix_run_idempotency_run').on(t.runId, t.expiresAt),
    // uq_run_idempotency_scope (drizzle/0024) — the dedup authority.
    uniqueIndex('uq_run_idempotency_scope').on(t.organizationId, t.callerScope, t.idempotencyKey),
  ],
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
    /** REL-11.4: who triggered the approval (run input message author) — for approver≠author */
    createdBy: varchar('created_by', { length: 128 }),
    /** REL-11.4: 1 = single approver (legacy), 2..5 = multi-approver chain */
    requiredApprovals: integer('required_approvals').notNull().default(1),
    /** REL-11.4: array of {actor, decision, decided_at} for multi-approver */
    approvalsReceived: jsonb('approvals_received').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_approvals_run_state').on(t.runId, t.state),
    // uq_approvals_org_ref (drizzle/0024) — approval_ref replay semantics.
    uniqueIndex('uq_approvals_org_ref').on(t.organizationId, t.approvalRef),
  ],
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
  (t) => [
    index('ix_tool_effects_run').on(t.runId, t.authorizedAt),
    // uq_tool_effects_call (drizzle/0024) — durable tool-effect dedup.
    uniqueIndex('uq_tool_effects_call').on(t.organizationId, t.toolCallId),
  ],
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
  (t) => [
    index('ix_checkpoints_run').on(t.runId, t.createdAt),
    // uq_checkpoints_run_version (drizzle/0024) — checkpoint replay semantics.
    uniqueIndex('uq_checkpoints_run_version').on(t.runId, t.checkpointRef, t.checkpointVersion),
  ],
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
  (t) => [
    index('ix_memory_proposals_run').on(t.runId, t.decision),
    // uq_memory_proposals_org_ref (drizzle/0024) — proposal_ref replay semantics.
    uniqueIndex('uq_memory_proposals_org_ref').on(t.organizationId, t.proposalRef),
  ],
);

export type RunIdempotency = typeof runIdempotency.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type ToolEffect = typeof toolEffects.$inferSelect;
export type Checkpoint = typeof checkpoints.$inferSelect;
export type MemoryProposal = typeof memoryProposals.$inferSelect;
