/**
 * Shared MongoDB document shapes + row mappers for the assistants-module
 * mongo repositories (P3: model catalog, model cost, provider credentials,
 * fleet staff).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field
 * names are the pg snake_case column names, timestamps are ISO-8601
 * strings. The pg `id` column is kept as the Binary field `id`; `_id` is
 * left to the driver's default ObjectId (never overridden).
 *
 * Index note: the unique constraints the mongo lane relies on
 * (model_catalog (provider, model_id), model_cost (provider, model,
 * effective_from), provider_credentials (organization_id, provider,
 * external_ref), provider_enablements (organization_id, provider),
 * template_platform_blocks active (slug)) are declared in the mongo
 * migrator registry (`src/common/infra/db/mongo/migrations/mongo/
 * 0001_engine_core.ts`) — the pg lane's unique constraints are mirrored
 * there, so no defensive ensurement is repeated here.
 */
import { Binary, MongoServerError } from 'mongodb';
import type { Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { ModelCatalogEntry, ModelCapabilities } from '../model-catalog.schema';
import type { ModelCostEntry } from '../model-cost.schema';
import type { ProviderCredential, ProviderEnablement } from '../provider-credentials.schema';
import type { TemplatePlatformBlock } from '../template-blocks.schema';

/** Parse a UUID into BSON Binary subtype 4; fails closed with a validation error. */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

export function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

/** True for MongoDB duplicate-key errors (plan D7: the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Project a BSON document to a plain JSON-serializable row: `_id` is
 * dropped (the pg `id` is kept), Binary UUIDs become uuid strings — the
 * same shape the pg lane's raw SQL rows carry.
 */
export function plainRow(doc: WithId<Document>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id') continue;
    out[key] = value instanceof Binary ? uuidOf(value) : value;
  }
  return out;
}

// ── model_catalog_entries (GLOBAL) ─────────────────────────────────────────

export interface ModelCatalogMongoDoc {
  id: Binary;
  provider: string;
  model_id: string;
  display_name: string;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
  capabilities: unknown;
  residency: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function toModelCatalogEntry(doc: WithId<ModelCatalogMongoDoc>): ModelCatalogEntry {
  return {
    id: uuidOf(doc.id),
    provider: doc.provider,
    modelId: doc.model_id,
    displayName: doc.display_name,
    contextWindowTokens: doc.context_window_tokens,
    maxOutputTokens: doc.max_output_tokens,
    capabilities: doc.capabilities as ModelCapabilities,
    residency: doc.residency,
    status: doc.status,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── model_cost_entries (GLOBAL) ────────────────────────────────────────────

export interface ModelCostMongoDoc {
  id: Binary;
  provider: string;
  model: string;
  cost_micros_per_1k_input: number;
  cost_micros_per_1k_output: number;
  cost_micros_per_1k_cached_input: number | null;
  currency: string;
  effective_from: string;
  retired_at: string | null;
  created_by: string;
  created_at: string;
}

export function toModelCostEntry(doc: WithId<ModelCostMongoDoc>): ModelCostEntry {
  return {
    id: uuidOf(doc.id),
    provider: doc.provider,
    model: doc.model,
    costMicrosPer1kInput: doc.cost_micros_per_1k_input,
    costMicrosPer1kOutput: doc.cost_micros_per_1k_output,
    costMicrosPer1kCachedInput: doc.cost_micros_per_1k_cached_input,
    currency: doc.currency,
    effectiveFrom: doc.effective_from,
    retiredAt: doc.retired_at,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
  };
}

// ── provider_credentials (tenant) ──────────────────────────────────────────

export interface ProviderCredentialMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  label: string;
  external_ref: string;
  source: string;
  status: string;
  secret_sealed: string;
  secret_fingerprint: string;
  created_by: string;
  rotated_by: string | null;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  compromised: boolean;
}

export function toProviderCredential(doc: WithId<ProviderCredentialMongoDoc>): ProviderCredential {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    provider: doc.provider,
    label: doc.label,
    externalRef: doc.external_ref,
    source: doc.source,
    status: doc.status,
    secretSealed: doc.secret_sealed,
    secretFingerprint: doc.secret_fingerprint,
    createdBy: doc.created_by,
    rotatedBy: doc.rotated_by,
    createdAt: doc.created_at,
    rotatedAt: doc.rotated_at,
    revokedAt: doc.revoked_at,
    revocationReason: doc.revocation_reason,
    compromised: doc.compromised,
  };
}

// ── provider_enablements (tenant) ──────────────────────────────────────────

export interface ProviderEnablementMongoDoc {
  organization_id: Binary;
  provider: string;
  enabled: boolean;
  updated_by: string;
  updated_at: string;
}

export function toProviderEnablement(doc: WithId<ProviderEnablementMongoDoc>): ProviderEnablement {
  return {
    organizationId: uuidOf(doc.organization_id),
    provider: doc.provider,
    enabled: doc.enabled,
    updatedBy: doc.updated_by,
    updatedAt: doc.updated_at,
  };
}

// ── template_platform_blocks (GLOBAL, staff scope) ─────────────────────────

export interface TemplatePlatformBlockMongoDoc {
  id: Binary;
  slug: string;
  reason: string;
  created_by: string;
  created_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
}

export function toTemplatePlatformBlock(
  doc: WithId<TemplatePlatformBlockMongoDoc>,
): TemplatePlatformBlock {
  return {
    id: uuidOf(doc.id),
    slug: doc.slug,
    reason: doc.reason,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    liftedAt: doc.lifted_at,
    liftedBy: doc.lifted_by,
  };
}

// ── assistant_installs (tenant-owned; staff reads cross-org for inventory) ─

export interface AssistantInstallMongoDoc {
  organization_id: Binary;
  slug: string;
  template_version: string;
  assistant_id: Binary;
  installed_by: string;
  installed_at: string;
}
