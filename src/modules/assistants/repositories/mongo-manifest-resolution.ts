/**
 * MongoDB publish-time manifest resolution — module-internal.
 *
 * The session-based reimplementation of the PostgreSQL resolution reads in
 * `pg-manifest-resolution.ts`. Every read runs inside the CALLER's session
 * (the publish transaction's snapshot), with explicit `organization_id`
 * tenant predicates (there is no RLS on this lane). The pure builders
 * (`buildToolBindings`, `buildKnowledgePin`, `buildModelRef`,
 * `manifestHashFor`) are shared with the pg lane, so both lanes resolve
 * identical manifests from identical inputs.
 *
 * `published_configs` uses the org-furniture `org_id` tenant field (same
 * convention as `product_entitlements` in the conversations lane); the
 * latest-config read is fail-soft (null when missing), mirroring
 * `makeLatestConfigFn` on the pg lane. Unlike the pg lane there is no
 * separate transaction involved — the read joins the caller's session —
 * so no failure-swallowing is needed beyond the null case.
 */
import { Binary } from 'mongodb';
import type { ClientSession, Db } from 'mongodb';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency';
import { BUILT_IN_TOOLS } from '../tool-catalog.service';
import {
  buildKnowledgeConfigRef,
  buildModelRef,
  buildResolvedKnowledgePin,
  buildToolBindings,
  buildUnresolvedKnowledgePin,
  manifestHashFor,
  type CatalogToolRow,
  type PlatformModelEntry,
} from './pg-manifest-resolution';
import { binToUuid, binUuid } from './mongo-assistant-documents';
import type { AssistantPayload } from '../validation';
import type {
  EmbeddingCoverage,
  KnowledgePin,
  ModelRef,
  ResolvedManifest,
  ToolBinding,
} from '../manifest-resolution.service';

// ── Minimal BSON shapes for the collections read here ────────────────────

interface ToolCatalogMongoDoc {
  id: Binary;
  name: string;
  version: string;
  hash: string;
  effect_class: unknown;
  approval_requirement: string;
  http_binding: { timeout_ms?: unknown } | null;
  execution_environment: unknown;
  allowed_egress_domains: unknown;
  credential_sealed: unknown;
  rate_limit_per_run: number | null;
  enabled: boolean;
}

interface DocumentMongoDoc {
  id: Binary;
  embedding_model: string | null;
}

interface DocumentVersionMongoDoc {
  id: Binary;
  version: number;
  sha256: Binary;
  parser_version: string | null;
}

interface ChunkMongoDoc {
  id: Binary;
}

interface EmbeddingMongoDoc {
  chunk_id: Binary;
}

interface PublishedConfigMongoDoc {
  id: Binary;
  scope: string;
  version: number;
  payload: unknown;
}

interface AssistantInstallMongoDoc {
  slug: string;
  template_version: string;
}

interface AssistantTemplateMongoDoc {
  hash: string | null;
  release_policy: unknown;
}

interface SessionOpts {
  session: ClientSession;
}

// ── Tools ────────────────────────────────────────────────────────────────

async function resolveToolBindingsMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  tools: Array<{
    name: string;
    access: string;
    approval?: string;
    schema_hash?: string;
    execution_mode?: string;
  }>,
): Promise<ToolBinding[]> {
  const catalogNames = tools.map((t) => t.name).filter((n) => !BUILT_IN_TOOLS.has(n));
  const toolCatalog = new TenantScopedCollection<ToolCatalogMongoDoc>(
    db.collection<ToolCatalogMongoDoc>('tool_catalog'),
  );
  const rows =
    catalogNames.length === 0
      ? []
      : await toolCatalog.find(orgId, {}, { session: s.session }).toArray();
  const byName = new Map<string, CatalogToolRow>(
    rows.map((r) => [
      r.name,
      {
        id: binToUuid(r.id),
        name: r.name,
        version: r.version,
        hash: r.hash,
        effectClass: r.effect_class,
        approvalRequirement: r.approval_requirement,
        httpBinding: r.http_binding,
        executionEnvironment: r.execution_environment,
        allowedEgressDomains: r.allowed_egress_domains,
        credentialSealed: r.credential_sealed,
        rateLimitPerRun: r.rate_limit_per_run,
        enabled: r.enabled,
      },
    ]),
  );
  return buildToolBindings(tools, byName);
}

// ── Knowledge ────────────────────────────────────────────────────────────

async function latestPublishedConfigMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  scope: 'knowledge_config' | 'model_catalog',
): Promise<{ id: string; payload: unknown } | null> {
  const configs = new TenantScopedCollection<PublishedConfigMongoDoc>(
    db.collection<PublishedConfigMongoDoc>('published_configs'),
    { tenantField: 'org_id' },
  );
  const row = await configs.findOne(
    orgId,
    { scope },
    { session: s.session, sort: { version: -1 } },
  );
  if (!row) return null;
  return { id: binToUuid(row.id), payload: row.payload ?? null };
}

async function resolveEmbeddingCoverageMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  documentVersionId: Binary,
  model: string | null,
): Promise<EmbeddingCoverage | null> {
  if (!model) {
    return null;
  }
  const chunks = new TenantScopedCollection<ChunkMongoDoc>(db.collection<ChunkMongoDoc>('chunks'));
  const chunkRows = await chunks
    .find(orgId, { document_version_id: documentVersionId }, { session: s.session })
    .toArray();
  const total = chunkRows.length;
  // Vacuous truth (pg parity): a chunkless version has nothing to index.
  if (total === 0) {
    return { model, chunk_total: 0, chunk_embedded: 0, complete: true };
  }
  const embeddings = new TenantScopedCollection<EmbeddingMongoDoc>(
    db.collection<EmbeddingMongoDoc>('embeddings'),
  );
  const embeddedRows = await embeddings
    .find(
      orgId,
      { chunk_id: { $in: chunkRows.map((c) => c.id) }, model },
      { session: s.session },
    )
    .toArray();
  const embeddedChunkIds = new Set(embeddedRows.map((e) => e.chunk_id.toUUID().toString()));
  const embedded = chunkRows.filter((c) => embeddedChunkIds.has(c.id.toUUID().toString())).length;
  return { model, chunk_total: total, chunk_embedded: embedded, complete: embedded === total };
}

async function pinKnowledgeSourceMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  slug: string,
  configRef: KnowledgePin['knowledge_config'],
): Promise<KnowledgePin> {
  const unresolved = buildUnresolvedKnowledgePin(slug, configRef);
  const documents = new TenantScopedCollection<DocumentMongoDoc>(
    db.collection<DocumentMongoDoc>('documents'),
  );
  const doc = await documents.findOne(
    orgId,
    { source_slug: slug, state: 'ready' },
    { session: s.session },
  );
  if (!doc) {
    return unresolved;
  }
  const documentVersions = new TenantScopedCollection<DocumentVersionMongoDoc>(
    db.collection<DocumentVersionMongoDoc>('document_versions'),
  );
  const version = await documentVersions.findOne(
    orgId,
    { document_id: doc.id },
    { session: s.session, sort: { version: -1 } },
  );
  if (!version) {
    return unresolved;
  }
  const coverage = await resolveEmbeddingCoverageMongo(db, s, orgId, version.id, doc.embedding_model);
  return buildResolvedKnowledgePin({
    slug,
    documentId: binToUuid(doc.id),
    documentVersionId: binToUuid(version.id),
    documentVersion: version.version,
    sha256Hex: Buffer.from(version.sha256.buffer).toString('hex'),
    parserVersion: version.parser_version,
    embeddingModel: doc.embedding_model,
    coverage,
    configRef,
  });
}

async function resolveKnowledgePinsMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  sources: string[],
): Promise<KnowledgePin[]> {
  if (sources.length === 0) {
    return [];
  }
  const knowledgeConfig = await latestPublishedConfigMongo(db, s, orgId, 'knowledge_config');
  const configRef = buildKnowledgeConfigRef(knowledgeConfig);
  const pins: KnowledgePin[] = [];
  for (const slug of sources) {
    pins.push(await pinKnowledgeSourceMongo(db, s, orgId, slug, configRef));
  }
  return pins;
}

// ── Models ───────────────────────────────────────────────────────────────

async function resolveModelRefMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  payload: Pick<AssistantPayload, 'model_policy' | 'model_params'>,
): Promise<ModelRef> {
  const catalog = await latestPublishedConfigMongo(db, s, orgId, 'model_catalog');
  const entries = new PlatformCollection<{ provider: string; model_id: string }>(
    db.collection<{ provider: string; model_id: string }>('model_catalog_entries'),
  );
  const platformRows = await entries.find({ status: 'active' }, { session: s.session }).toArray();
  const platform: PlatformModelEntry[] = platformRows.map((r) => ({
    provider: r.provider,
    modelId: r.model_id,
  }));
  return buildModelRef(payload, platform, catalog);
}

// ── Template provenance ──────────────────────────────────────────────────

async function resolveTemplateRefMongo(
  db: Db,
  s: SessionOpts,
  orgId: string,
  assistantId: string,
): Promise<ResolvedManifest['templateRef']> {
  const installs = new TenantScopedCollection<AssistantInstallMongoDoc>(
    db.collection<AssistantInstallMongoDoc>('assistant_installs'),
  );
  const install = await installs.findOne(
    orgId,
    { assistant_id: binUuid(assistantId, 'assistantId') },
    { session: s.session },
  );
  if (!install) {
    return null;
  }
  const templates = new PlatformCollection<AssistantTemplateMongoDoc>(
    db.collection<AssistantTemplateMongoDoc>('assistant_templates'),
  );
  const template = await templates.findOne(
    { slug: install.slug, version: install.template_version },
    { session: s.session },
  );
  return {
    slug: install.slug,
    version: install.template_version,
    definition_hash: template?.hash ?? null,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Resolve the full publish manifest inside the caller's Mongo session.
 * Lane twin of `resolveForPublishPg` — identical inputs resolve identical
 * manifests (shared pure builders).
 */
export async function resolveForPublishMongo(
  db: Db,
  session: ClientSession,
  orgId: string,
  assistantId: string,
  payload: AssistantPayload,
): Promise<ResolvedManifest> {
  const s: SessionOpts = { session };
  const toolBindings = await resolveToolBindingsMongo(db, s, orgId, payload.tool_policy.tools);
  const knowledgePins = await resolveKnowledgePinsMongo(
    db,
    s,
    orgId,
    payload.context_policy.knowledge_sources ?? [],
  );
  const modelRef = await resolveModelRefMongo(db, s, orgId, payload);
  const templateRef = await resolveTemplateRefMongo(db, s, orgId, assistantId);
  const manifestHash = manifestHashFor(toolBindings, knowledgePins, modelRef, templateRef, payload);
  return { toolBindings, knowledgePins, modelRef, templateRef, manifestHash };
}
