/**
 * Shared MongoDB document shapes + row mappers for the deployment-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings,
 * jsonb columns are subdocuments/arrays, pg integers are numbers. The pg
 * `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Collection names are the P1-provisioned names (`0001_engine_core.ts`):
 * `product_deployment_pipelines`, `product_deployment_pipeline_stages`,
 * `product_deployment_environments`, `product_deployment_deployments`,
 * `product_deployment_deployment_events`, `product_deployment_secrets`,
 * `product_deployment_deployment_settings`.
 */
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  DeploymentEventRow,
  DeploymentRow,
  EnvironmentRow,
  PipelineRow,
  SettingsRow,
  StageRow,
} from '../schema';

/** Tenant-guarded handle for a collection (plan D6 — explicit org predicate). */
export function tenantCollection<T extends Document>(db: Db, name: string): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name));
}

/** True for MongoDB duplicate-key errors (plan D7: the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** Clamp a listing limit into the [1, 500] window (default 50). */
export function clampLimit(limit: number | undefined, def = 50, max = 500): number {
  if (limit === undefined || Number.isNaN(limit)) return def;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

// ── pipelines ─────────────────────────────────────────────────────────────

export interface PipelineMongoDoc {
  id: Binary;
  organization_id: Binary;
  project_id: Binary | null;
  name: string;
  description: string | null;
  source_agent: string;
  status: string;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export function toPipeline(doc: WithId<PipelineMongoDoc>): PipelineRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.organization_id),
    projectId: doc.project_id ? uuidOf(doc.project_id) : null,
    name: doc.name,
    description: doc.description,
    sourceAgent: doc.source_agent,
    status: doc.status,
    createdBy: doc.created_by ? uuidOf(doc.created_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function pipelineDoc(input: {
  id: string;
  orgId: string;
  projectId?: string | null;
  name: string;
  description?: string;
  sourceAgent: string;
  now: string;
}): PipelineMongoDoc {
  return {
    id: binUuid(input.id),
    organization_id: binUuid(input.orgId, 'orgId'),
    project_id: input.projectId ? binUuid(input.projectId, 'projectId') : null,
    name: input.name,
    description: input.description ?? null,
    source_agent: input.sourceAgent,
    status: 'active',
    created_by: null,
    created_at: input.now,
    updated_at: input.now,
  };
}

// ── pipeline stages ───────────────────────────────────────────────────────

export interface StageMongoDoc {
  id: Binary;
  pipeline_id: Binary;
  organization_id: Binary;
  environment_id: Binary;
  name: string | null;
  position: number;
  gate_policy: unknown;
  rollout_policy: unknown;
  auto_promote: number;
  rollback_on_failure: number;
  created_at: string;
  updated_at: string;
}

export function toStage(doc: WithId<StageMongoDoc>): StageRow {
  return {
    id: uuidOf(doc.id),
    pipelineId: uuidOf(doc.pipeline_id),
    orgId: uuidOf(doc.organization_id),
    environmentId: uuidOf(doc.environment_id),
    name: doc.name,
    position: doc.position,
    gatePolicy: doc.gate_policy,
    rolloutPolicy: doc.rollout_policy,
    autoPromote: doc.auto_promote,
    rollbackOnFailure: doc.rollback_on_failure,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── environments ──────────────────────────────────────────────────────────

export interface EnvironmentMongoDoc {
  id: Binary;
  organization_id: Binary;
  project_id: Binary | null;
  name: string;
  tier: string;
  region: string | null;
  description: string | null;
  pinned_agent_version: string | null;
  guardrail_profile: string | null;
  quota_ref: string | null;
  approval_mode: string;
  auto_promote: number;
  status: string;
  concurrency: number;
  live_deployment_id: Binary | null;
  live_version: string | null;
  last_deployed_at: string | null;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export function toEnvironment(doc: WithId<EnvironmentMongoDoc>): EnvironmentRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.organization_id),
    projectId: doc.project_id ? uuidOf(doc.project_id) : null,
    name: doc.name,
    tier: doc.tier,
    region: doc.region,
    description: doc.description,
    pinnedAgentVersion: doc.pinned_agent_version,
    guardrailProfile: doc.guardrail_profile,
    quotaRef: doc.quota_ref,
    approvalMode: doc.approval_mode,
    autoPromote: doc.auto_promote,
    status: doc.status,
    concurrency: doc.concurrency,
    liveDeploymentId: doc.live_deployment_id ? uuidOf(doc.live_deployment_id) : null,
    liveVersion: doc.live_version,
    lastDeployedAt: doc.last_deployed_at,
    createdBy: doc.created_by ? uuidOf(doc.created_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── deployments ───────────────────────────────────────────────────────────

export interface DeploymentMongoDoc {
  id: Binary;
  organization_id: Binary;
  pipeline_id: Binary;
  stage_id: Binary;
  environment_id: Binary;
  agent_version: string;
  status: string;
  strategy: string;
  canary_percent: number | null;
  ladder: unknown;
  rollout_state: unknown;
  git_commit: string | null;
  git_branch: string | null;
  git_message: string | null;
  snapshot: unknown;
  metrics: unknown;
  last_error: string | null;
  triggered_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toDeployment(doc: WithId<DeploymentMongoDoc>): DeploymentRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.organization_id),
    pipelineId: uuidOf(doc.pipeline_id),
    stageId: uuidOf(doc.stage_id),
    environmentId: uuidOf(doc.environment_id),
    agentVersion: doc.agent_version,
    status: doc.status,
    strategy: doc.strategy,
    canaryPercent: doc.canary_percent,
    ladder: doc.ladder,
    rolloutState: doc.rollout_state,
    gitCommit: doc.git_commit,
    gitBranch: doc.git_branch,
    gitMessage: doc.git_message,
    snapshot: doc.snapshot,
    metrics: doc.metrics,
    lastError: doc.last_error,
    triggeredBy: doc.triggered_by,
    startedAt: doc.started_at,
    completedAt: doc.completed_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── deployment events ─────────────────────────────────────────────────────

export interface DeploymentEventMongoDoc {
  id: Binary;
  organization_id: Binary;
  deployment_id: Binary;
  kind: string;
  payload: unknown;
  actor: string | null;
  created_at: string;
}

export function toDeploymentEvent(doc: WithId<DeploymentEventMongoDoc>): DeploymentEventRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.organization_id),
    deploymentId: uuidOf(doc.deployment_id),
    kind: doc.kind,
    payload: doc.payload,
    actor: doc.actor,
    createdAt: doc.created_at,
  };
}

// ── secrets ───────────────────────────────────────────────────────────────

export interface SecretMongoDoc {
  id: Binary;
  organization_id: Binary;
  environment_id: Binary;
  key: string;
  value_ciphertext: string;
  kms_ref: string | null;
  preview: string | null;
  expires_at: string | null;
  rotation_interval_days: number | null;
  version: number;
  rotated_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── deployment settings ───────────────────────────────────────────────────

export interface DeploymentSettingsMongoDoc {
  organization_id: Binary;
  default_strategy: string;
  default_ladder: unknown;
  auto_rollback: number;
  default_canary_weight: number;
  updated_by: Binary | null;
  updated_at: string;
}

export function toSettings(doc: WithId<DeploymentSettingsMongoDoc>): SettingsRow {
  return {
    orgId: uuidOf(doc.organization_id),
    defaultStrategy: doc.default_strategy,
    defaultLadder: doc.default_ladder,
    autoRollback: doc.auto_rollback,
    defaultCanaryWeight: doc.default_canary_weight,
    updatedBy: doc.updated_by ? uuidOf(doc.updated_by) : null,
    updatedAt: doc.updated_at,
  };
}

// ── collection handles ────────────────────────────────────────────────────

export function deploymentCollections(db: Db) {
  return {
    pipelines: tenantCollection<PipelineMongoDoc>(db, 'product_deployment_pipelines'),
    stages: tenantCollection<StageMongoDoc>(db, 'product_deployment_pipeline_stages'),
    environments: tenantCollection<EnvironmentMongoDoc>(db, 'product_deployment_environments'),
    deployments: tenantCollection<DeploymentMongoDoc>(db, 'product_deployment_deployments'),
    events: tenantCollection<DeploymentEventMongoDoc>(db, 'product_deployment_deployment_events'),
    secrets: tenantCollection<SecretMongoDoc>(db, 'product_deployment_secrets'),
    settings: tenantCollection<DeploymentSettingsMongoDoc>(db, 'product_deployment_deployment_settings'),
  };
}
