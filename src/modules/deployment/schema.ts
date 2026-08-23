import { index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * The deployment product domain (D-1, eng-0005 + eng-0017, schema
 * `product_deployment` per partitioning P-6): pipelines, stages with gate
 * policies and rollout ladders, environments with protection rules,
 * deployments with the explicit status machine + PERSISTED rollout state,
 * the immutable event log, the envelope-encrypted secrets vault, and the
 * org-level settings singleton.
 *
 * org_id is varchar(36) matching tenants.id — reference by id, never by FK
 * across system boundaries. deployment_events carries a denormalized org_id
 * so RLS isolates the log with the same policy shape as everything else;
 * the log is append-only (no update path exists in code).
 */
export const deploymentSchema = pgSchema('product_deployment');

export const pipelines = deploymentSchema.table(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    projectId: uuid('project_id'),
    name: varchar('name', { length: 128 }).notNull(),
    description: varchar('description', { length: 512 }),
    /** Agent reference this pipeline promotes (agent id or slug in the studio). */
    sourceAgent: varchar('source_agent', { length: 128 }).notNull(),
    /** active | paused | archived — paused blocks triggers but stays visible. */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_deployment_pipelines_org_name').on(t.orgId, t.name), index('ix_deployment_pipelines_org').on(t.orgId)],
);

export const environments = deploymentSchema.table(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    projectId: uuid('project_id'),
    /** dev | staging | prod | custom names */
    name: varchar('name', { length: 64 }).notNull(),
    /** shared | dedicated */
    tier: varchar('tier', { length: 32 }).notNull().default('shared'),
    /** Home region for the environment's serving fleet (display + routing hint). */
    region: varchar('region', { length: 64 }),
    description: varchar('description', { length: 512 }),
    pinnedAgentVersion: varchar('pinned_agent_version', { length: 64 }),
    guardrailProfile: varchar('guardrail_profile', { length: 64 }),
    /** Quota-engine reference for per-environment spend buckets (D-5). */
    quotaRef: varchar('quota_ref', { length: 64 }),
    /** Protection rule (GitHub-environment style): manual = every promotion needs ≥1 approval. */
    approvalMode: varchar('approval_mode', { length: 16 }).notNull().default('auto'),
    /** Default for stages bound to this environment (stage flag still wins). */
    autoPromote: integer('auto_promote').notNull().default(1),
    /** active | maintenance — maintenance blocks new triggers. */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    /** Max concurrent active runs (Vercel-style production concurrency; 1 = serialize). */
    concurrency: integer('concurrency').notNull().default(1),
    /** Live serving state, maintained by the workflow (not writable by hand). */
    liveDeploymentId: uuid('live_deployment_id'),
    liveVersion: varchar('live_version', { length: 64 }),
    lastDeployedAt: timestamp('last_deployed_at', { withTimezone: true, mode: 'string' }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_deployment_environments_org_name').on(t.orgId, t.name)],
);

export const pipelineStages = deploymentSchema.table(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'restrict' }),
    /** Human label for the promotion ladder step (defaults to the env name). */
    name: varchar('name', { length: 128 }),
    /** Ordered position within the pipeline (1-based). */
    position: integer('position').notNull(),
    /** Gate policy JSONB — evaluated by the engine gate evaluator (see gate-evaluator.ts). */
    gatePolicy: jsonb('gate_policy').notNull().default({ require: 'all', checks: [], min_approvals: 0 }),
    /** Rollout policy JSONB — per-stage ladder override (see rollout.ts). */
    rolloutPolicy: jsonb('rollout_policy'),
    autoPromote: integer('auto_promote').notNull().default(1),
    rollbackOnFailure: integer('rollback_on_failure').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_deployment_stages_pipeline_position').on(t.pipelineId, t.position),
    index('ix_deployment_stages_org').on(t.orgId),
    index('ix_deployment_stages_env').on(t.orgId, t.environmentId),
  ],
);

export const deployments = deploymentSchema.table(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'restrict' }),
    agentVersion: varchar('agent_version', { length: 64 }).notNull(),
    /**
     * The status machine (product plan): pending → gated → rolling → live,
     * with rolled_back / failed as terminal-ish exits. Transitions are
     * validated against DEPLOYMENT_TRANSITIONS in the service.
     */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    /** all | canary | blue_green | linear */
    strategy: varchar('strategy', { length: 16 }).notNull().default('all'),
    /** Current canary weight (0-100) while rolling. */
    canaryPercent: integer('canary_percent'),
    /**
     * The rollout ladder FROZEN at trigger time (see rollout.ts): an ordered
     * list of {weight, soak_seconds, manual} steps. Persisted on the row so
     * the run survives Redis loss — the worker is stateless over it.
     */
    ladder: jsonb('ladder').notNull().default([]),
    /** Worker-resumable rollout bookkeeping — the ONLY mutable run state. */
    rolloutState: jsonb('rollout_state').notNull().default({}),
    /** Git context when the run comes from a VCS trigger (releases timeline). */
    gitCommit: varchar('git_commit', { length: 64 }),
    gitBranch: varchar('git_branch', { length: 256 }),
    gitMessage: varchar('git_message', { length: 512 }),
    /** Agent-config snapshot captured at run start (trigger-provided today). */
    snapshot: jsonb('snapshot').notNull().default({}),
    /** Latest canary/rollout metrics feed (gate evaluator input). */
    metrics: jsonb('metrics').notNull().default({}),
    lastError: text('last_error'),
    triggeredBy: varchar('triggered_by', { length: 128 }), // account id or service client id
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_deployment_deployments_org_created').on(t.orgId, t.createdAt),
    index('ix_deployment_deployments_pipeline').on(t.pipelineId),
    index('ix_deployment_deployments_status').on(t.orgId, t.status),
    index('ix_deployment_deployments_env').on(t.orgId, t.environmentId),
  ],
);

/** The immutable run log — append-only by construction (no update path). */
export const deploymentEvents = deploymentSchema.table(
  'deployment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 48 }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    actor: varchar('actor', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_deployment_events_deployment_time').on(t.deploymentId, t.createdAt),
    index('ix_deployment_events_org').on(t.orgId, t.createdAt),
  ],
);

/**
 * The secrets vault (D-5): envelope-encrypted values (enc:v1 AES-256-GCM,
 * kernel crypto) + an optional external KMS reference. Plaintext NEVER
 * persists and NEVER leaves through the console API — `preview` is a
 * write-time-derived masked hint (first chars only); the decrypted value
 * is served exclusively on the internal runtime-config plane.
 */
export const secrets = deploymentSchema.table(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 128 }).notNull(),
    valueCiphertext: text('value_ciphertext').notNull(),
    kmsRef: varchar('kms_ref', { length: 256 }),
    /** Masked hint derived at write time — never decryptable, never the value. */
    preview: varchar('preview', { length: 24 }),
    /** Rotation governance: expiry + cadence drive the expiring-soon scan. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    rotationIntervalDays: integer('rotation_interval_days'),
    /** Bumped on every overwrite/rotate — the audit trail counts versions. */
    version: integer('version').notNull().default(1),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'string' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_deployment_secrets_env_key').on(t.environmentId, t.key), index('ix_deployment_secrets_org').on(t.orgId)],
);

/** Org-level defaults singleton (the settings page): one row per org, lazily created. */
export const deploymentSettings = deploymentSchema.table('deployment_settings', {
  orgId: varchar('org_id', { length: 36 }).primaryKey(),
  /** Default strategy for runs that don't specify one. */
  defaultStrategy: varchar('default_strategy', { length: 16 }).notNull().default('canary'),
  /** Default ladder override (validated by rollout.ts); empty = built-in defaults. */
  defaultLadder: jsonb('default_ladder').notNull().default([]),
  /** Default rollback_on_failure for newly added stages. */
  autoRollback: integer('auto_rollback').notNull().default(1),
  /** First canary weight for generated ladders (5..90). */
  defaultCanaryWeight: integer('default_canary_weight').notNull().default(10),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── explicit status machines ────────────────────────────────────────────────

export type DeploymentStatus = 'pending' | 'gated' | 'rolling' | 'live' | 'rolled_back' | 'failed';

export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  pending: ['gated', 'failed'],
  gated: ['rolling', 'failed'],
  rolling: ['live', 'rolled_back', 'failed'],
  live: ['rolled_back'],
  rolled_back: [],
  failed: [],
};

export type RolloutStrategy = 'all' | 'canary' | 'linear' | 'blue_green';
export const ROLLOUT_STRATEGIES: readonly RolloutStrategy[] = ['all', 'canary', 'linear', 'blue_green'];

export type PipelineStatus = 'active' | 'paused' | 'archived';
export type EnvironmentApprovalMode = 'auto' | 'manual';

export type PipelineRow = typeof pipelines.$inferSelect;
export type StageRow = typeof pipelineStages.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentEventRow = typeof deploymentEvents.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type SettingsRow = typeof deploymentSettings.$inferSelect;
