/**
 * PostgreSQL publish-time manifest resolution helpers — module-internal.
 *
 * The exact read implementations extracted from `ManifestResolutionService`
 * so that BOTH the kept service (`resolveForPublish`, byte-identical
 * signature, now delegating) and the PostgreSQL repository adapters (which
 * own their transaction) share one code path.
 *
 * Transaction discipline is unchanged: every function takes the CALLER's
 * transaction and reads inside it — resolution sees the same snapshot the
 * publish transaction commits. The only exception is the latest-config read
 * (`makeLatestConfigFn`), which goes through `ConfigPublishService.latest`
 * and therefore opens its own read transaction, exactly as before: catalog
 * rows are slow-moving and every resolved value is hash-anchored, so drift
 * surfaces as a typed mismatch at authorize time rather than silent
 * staleness.
 *
 * Resolution NEVER mutates catalog/documents/config rows — it only reads.
 * Anything unresolvable fails closed HERE (the publish/rollback transaction
 * aborts) except explicitly documented degradations (unresolved knowledge
 * pins are recorded, not fatal — retrieval degrades and eval judges
 * quality).
 *
 * The pure builders (`buildToolBindings`, `buildKnowledgePin`,
 * `buildKnowledgeConfigRef`, `buildModelRef`, `manifestHashFor`) carry no
 * PostgreSQL dependency and are shared with the Mongo lane so both lanes
 * resolve identical manifests from identical inputs.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DbService } from '../../../common/infra/db/db.service';
import type { ConfigPublishService } from '../../config-publish/config-publish.service';
import { ApiError } from '../../../common/http/api-error';
import { canonicalHash } from '../../../common/crypto/canonical-hash';
import { qualifyModelAliases } from '../../../common/model-aliases';
import { toolCatalog } from '../tool-catalog.schema';
import { BUILT_IN_TOOLS } from '../tool-catalog.service';
import { assistantInstalls, assistantTemplates } from '../schema';
import { modelCatalogEntries } from '../model-catalog.schema';
import { chunks, documents, documentVersions, embeddings } from '../../knowledge/schema';
import type { AssistantPayload } from '../validation';
import type {
  EmbeddingCoverage,
  KnowledgePin,
  ModelRef,
  ResolvedManifest,
  ToolBinding,
} from '../manifest-resolution.service';

/** Dependencies for the PostgreSQL resolution path. */
export interface PgManifestDeps {
  db: DbService;
  configPublish: ConfigPublishService;
}

/** Minimal catalog-tool row shape shared by the pg and mongo readers. */
export interface CatalogToolRow {
  id: string;
  name: string;
  version: string;
  hash: string;
  effectClass: unknown;
  approvalRequirement: string;
  httpBinding: { timeout_ms?: unknown } | null;
  executionEnvironment: unknown;
  allowedEgressDomains: unknown;
  credentialSealed: unknown;
  rateLimitPerRun: number | null;
  enabled: boolean;
}

/** Minimal platform model-catalog entry shape shared by the pg and mongo readers. */
export interface PlatformModelEntry {
  provider: string;
  modelId: string;
}

/** Default retry posture, versioned with the snapshot (auditable, overridable later). */
export const RETRY_POLICY_V1 = {
  READ_ONLY: { max_attempts: 2, backoff_ms: 500 },
  MUTATING: { max_attempts: 1, backoff_ms: 0 },
  DESTRUCTIVE: { max_attempts: 1, backoff_ms: 0 },
} as const;

/**
 * Latest published-config reader with the original fail-soft semantics: a
 * missing config or a read failure resolves to null (the caller records a
 * null config_ref / falls back), never to a thrown error.
 */
export type LatestConfigFn = (
  orgId: string,
  scope: 'knowledge_config' | 'model_catalog',
) => Promise<{ id: string; payload: unknown } | null>;

export function makeLatestConfigFn(configPublish: ConfigPublishService): LatestConfigFn {
  return async (orgId, scope) => {
    try {
      const latest = await configPublish.latest(orgId, scope, null);
      if (!latest) return null;
      return {
        id: (latest as { id?: string }).id ?? 'unknown',
        payload: (latest as { payload?: unknown }).payload ?? null,
      };
    } catch {
      return null;
    }
  };
}

/** Pure: org knowledge_config at publish (id + payload hash + chunking params). */
export function buildKnowledgeConfigRef(
  knowledgeConfig: { id: string; payload: unknown } | null,
): KnowledgePin['knowledge_config'] {
  const configPayload = (knowledgeConfig?.payload ?? null) as {
    chunk_size?: unknown;
    chunk_overlap?: unknown;
    embedding_model?: unknown;
  } | null;
  return knowledgeConfig !== null && configPayload !== null
    ? {
        config_id: knowledgeConfig.id,
        payload_hash: canonicalHash(knowledgeConfig.payload),
        chunk_size: configPayload.chunk_size ?? null,
        chunk_overlap: configPayload.chunk_overlap ?? null,
        embedding_model: configPayload.embedding_model ?? null,
      }
    : null;
}

/** Pure: the unresolved-pin skeleton (recorded, not fatal). */
export function buildUnresolvedKnowledgePin(
  slug: string,
  configRef: KnowledgePin['knowledge_config'],
): KnowledgePin {
  return {
    source_slug: slug,
    resolved: false,
    document_id: null,
    document_version_id: null,
    document_version: null,
    sha256_hex: null,
    parser_version: null,
    embedding_model: null,
    embedding_coverage: null,
    knowledge_config: configRef,
  };
}

/** Pure: assemble a resolved knowledge pin from its resolved parts. */
export function buildResolvedKnowledgePin(input: {
  slug: string;
  documentId: string;
  documentVersionId: string;
  documentVersion: number;
  sha256Hex: string;
  parserVersion: string | null;
  embeddingModel: string | null;
  coverage: EmbeddingCoverage | null;
  configRef: KnowledgePin['knowledge_config'];
}): KnowledgePin {
  return {
    source_slug: input.slug,
    resolved: true,
    document_id: input.documentId,
    document_version_id: input.documentVersionId,
    document_version: input.documentVersion,
    sha256_hex: input.sha256Hex,
    parser_version: input.parserVersion,
    embedding_model: input.embeddingModel,
    embedding_coverage: input.coverage,
    knowledge_config: input.configRef,
  };
}

/**
 * Pure: map validated tool-policy entries to pinned ToolBindings.
 * Fails closed (typed validation error) when a named tool is missing or
 * disabled in the org catalog, or when its schema_hash is stale.
 */
export function buildToolBindings(
  tools: Array<{
    name: string;
    access: string;
    approval?: string;
    schema_hash?: string;
    execution_mode?: string;
  }>,
  byName: Map<string, CatalogToolRow>,
): ToolBinding[] {
  return tools.map((entry) => {
    const builtin = BUILT_IN_TOOLS.get(entry.name);
    const executionMode = entry.execution_mode === 'shadow' ? ('shadow' as const) : ('live' as const);
    if (builtin) {
      return {
        tool_id: null,
        name: entry.name,
        tool_version: '1.0.0-platform',
        schema_hash: null,
        capability_class: builtin.effectClass,
        authorization_policy: null,
        approval_mode:
          entry.approval === 'required' || builtin.approvalRequirement === 'REQUIRED'
            ? 'REQUIRED'
            : 'NONE',
        credential_binding: null,
        timeout_ms: 30000,
        retry_policy: { ...RETRY_POLICY_V1[builtin.effectClass] },
        rate_limit_per_run: null,
        // Built-ins execute in the platform itself — no egress surface.
        execution_environment: 'in_process',
        allowed_egress_domains: [],
        execution_mode: executionMode,
      } satisfies ToolBinding;
    }
    const row = byName.get(entry.name);
    if (!row || !row.enabled) {
      // assertToolPins runs before resolution in the publish path and
      // rejects this case with a typed error — this is the fail-closed
      // backstop if resolution is ever called without it.
      throw ApiError.validation({
        tool_policy: `tool pins rejected: ${entry.name}: not present in the tool catalog or disabled`,
      });
    }
    if (entry.schema_hash !== undefined && entry.schema_hash !== row.hash) {
      throw ApiError.validation({
        tool_policy: `tool pins rejected: ${entry.name}: schema_hash does not match the catalog entry (pin is stale)`,
      });
    }
    const httpBinding = row.httpBinding ?? {};
    const capability = row.effectClass as ToolBinding['capability_class'];
    // P4: perimeter pinned from the live row. Migration 0066 backfills
    // environment (default external_gateway = historical posture); egress
    // stays null for binding-less rows. Defensive read: a null egress is
    // [] (no declared surface), never "unbounded".
    const envRaw = row.executionEnvironment;
    const executionEnvironment =
      envRaw === 'in_process' || envRaw === 'sandboxed_microvm' || envRaw === 'external_gateway'
        ? envRaw
        : ('external_gateway' as const);
    const egressRaw = row.allowedEgressDomains as unknown;
    const allowedEgress = Array.isArray(egressRaw)
      ? egressRaw.filter((d): d is string => typeof d === 'string')
      : [];
    return {
      tool_id: row.id,
      name: entry.name,
      tool_version: row.version,
      schema_hash: row.hash,
      capability_class: capability,
      authorization_policy: null,
      approval_mode:
        entry.approval === 'required' || row.approvalRequirement === 'REQUIRED'
          ? 'REQUIRED'
          : 'NONE',
      credential_binding: row.credentialSealed != null ? { catalog_tool_id: row.id } : null,
      timeout_ms: typeof httpBinding.timeout_ms === 'number' ? httpBinding.timeout_ms : 30000,
      retry_policy: { ...RETRY_POLICY_V1[capability] },
      rate_limit_per_run: row.rateLimitPerRun,
      execution_environment: executionEnvironment,
      allowed_egress_domains: allowedEgress,
      execution_mode: executionMode,
    } satisfies ToolBinding;
  });
}

/** PostgreSQL: resolve tool bindings inside the caller's transaction. */
export async function resolveToolBindingsPg(
  tx: NodePgDatabase,
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
  const rows =
    catalogNames.length === 0
      ? []
      : await tx.select().from(toolCatalog).where(eq(toolCatalog.organizationId, orgId));
  const byName = new Map<string, CatalogToolRow>(
    rows.map((r) => [
      r.name,
      {
        id: r.id,
        name: r.name,
        version: r.version,
        hash: r.hash,
        effectClass: r.effectClass,
        approvalRequirement: r.approvalRequirement,
        httpBinding: r.httpBinding as CatalogToolRow['httpBinding'],
        executionEnvironment: r.executionEnvironment,
        allowedEgressDomains: r.allowedEgressDomains,
        credentialSealed: r.credentialSealed,
        rateLimitPerRun: r.rateLimitPerRun,
        enabled: r.enabled,
      },
    ]),
  );
  return buildToolBindings(tools, byName);
}

/** PostgreSQL: embedding coverage of the PINNED version for the doc's model, in-TX. */
export async function resolveEmbeddingCoveragePg(
  tx: NodePgDatabase,
  orgId: string,
  documentVersionId: string,
  model: string | null,
): Promise<EmbeddingCoverage | null> {
  if (!model) {
    return null;
  }
  const rows = await tx
    .select({ chunkId: chunks.id, embedded: embeddings.id })
    .from(chunks)
    .leftJoin(embeddings, and(eq(embeddings.chunkId, chunks.id), eq(embeddings.model, model)))
    .where(and(eq(chunks.documentVersionId, documentVersionId), eq(chunks.organizationId, orgId)));
  const total = rows.length;
  const embedded = rows.filter((r) => r.embedded !== null).length;
  // Vacuous truth: a chunkless version has nothing to index, so there is
  // no indexing gap to refuse over — degraded means "vectors missing", not
  // "document empty".
  return { model, chunk_total: total, chunk_embedded: embedded, complete: embedded === total };
}

/** PostgreSQL: pin one knowledge source slug inside the caller's transaction. */
export async function pinKnowledgeSourcePg(
  tx: NodePgDatabase,
  orgId: string,
  slug: string,
  configRef: KnowledgePin['knowledge_config'],
): Promise<KnowledgePin> {
  const unresolved = buildUnresolvedKnowledgePin(slug, configRef);
  // E-2 convention (deterministic): a seed slug matches the READY document
  // carrying it as source_slug — exact, org-unique, immutable except via
  // the explicit rename endpoint. No title match means the corpus is not
  // ingested — recorded unresolved, never invented.
  const docs = await tx
    .select({ id: documents.id, embeddingModel: documents.embeddingModel })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, orgId),
        eq(documents.sourceSlug, slug),
        eq(documents.state, 'ready'),
      ),
    )
    .limit(1);
  if (docs.length === 0) {
    return unresolved;
  }
  const versions = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.organizationId, orgId),
        eq(documentVersions.documentId, docs[0].id),
      ),
    )
    .orderBy(desc(documentVersions.version))
    .limit(1);
  if (versions.length === 0) {
    return unresolved;
  }
  const v = versions[0];
  // P0 (GAP-1): coverage of the PINNED version for the doc's active model.
  // One aggregate: chunks in the pinned version vs embedding rows for the
  // model. A null doc model means legacy vectors — coverage is unknown, not
  // incomplete (null keeps legacy publishes behaving exactly as before).
  const coverage = await resolveEmbeddingCoveragePg(tx, orgId, v.id, docs[0].embeddingModel);
  return buildResolvedKnowledgePin({
    slug,
    documentId: docs[0].id,
    documentVersionId: v.id,
    documentVersion: v.version,
    sha256Hex: Buffer.from(v.sha256 as unknown as Uint8Array).toString('hex'),
    parserVersion: v.parserVersion,
    embeddingModel: docs[0].embeddingModel,
    coverage,
    configRef,
  });
}

/** PostgreSQL: resolve knowledge pins inside the caller's transaction. */
export async function resolveKnowledgePinsPg(
  tx: NodePgDatabase,
  orgId: string,
  sources: string[],
  latestConfig: LatestConfigFn,
): Promise<KnowledgePin[]> {
  if (sources.length === 0) {
    return [];
  }
  const knowledgeConfig = await latestConfig(orgId, 'knowledge_config');
  const configRef = buildKnowledgeConfigRef(knowledgeConfig);
  const pins: KnowledgePin[] = [];
  for (const slug of sources) {
    pins.push(await pinKnowledgeSourcePg(tx, orgId, slug, configRef));
  }
  return pins;
}

/**
 * Pure: resolve the model ref from allowed models + platform entries + the
 * latest model_catalog config. Qualifies bare aliases against the platform
 * catalog so the snapshot's modelRef carries real providers (not "unknown")
 * — the run-time provider check in mcp-authority reads
 * modelRef.models[].provider.
 */
export function buildModelRef(
  payload: Pick<AssistantPayload, 'model_policy' | 'model_params'>,
  platformRows: PlatformModelEntry[],
  catalog: { id: string; payload: unknown } | null,
): ModelRef {
  const entries =
    (
      catalog?.payload as {
        models?: Array<{ provider: string; model: string; enabled: boolean }>;
      } | null
    )?.models ?? null;
  const catalogPayloadHash = catalog !== null ? canonicalHash(catalog.payload) : null;
  const qualified = qualifyModelAliases(payload.model_policy.allowed_models, platformRows);
  return {
    models: qualified.map((alias) => {
      const slash = alias.indexOf('/');
      const provider = slash === -1 ? 'unknown' : alias.slice(0, slash);
      const model = slash === -1 ? alias : alias.slice(slash + 1);
      const entry = entries?.find((m) => `${m.provider}/${m.model}` === alias) ?? null;
      return {
        provider,
        model,
        catalog_config_id: catalog?.id ?? null,
        catalog_payload_hash: catalogPayloadHash,
        entry_hash: entry !== null ? canonicalHash(entry) : null,
        // Honesty bound (plan §8): no provider-revision pinning exists, so
        // an alias without a catalog entry is recorded unresolved — the
        // manifest pins everything Neryva controls, nothing it cannot.
        catalog_enabled: entry?.enabled ?? null,
      };
    }),
    model_params: payload.model_params ?? null,
  };
}

/** PostgreSQL: resolve the model ref (platform catalog via root, config via latest-config). */
export async function resolveModelRefPg(
  deps: PgManifestDeps,
  orgId: string,
  payload: Pick<AssistantPayload, 'model_policy' | 'model_params'>,
  latestConfig: LatestConfigFn,
): Promise<ModelRef> {
  const catalog = await latestConfig(orgId, 'model_catalog');
  const platformRows = await deps.db.root
    .select({
      provider: modelCatalogEntries.provider,
      modelId: modelCatalogEntries.modelId,
    })
    .from(modelCatalogEntries)
    .where(eq(modelCatalogEntries.status, 'active'));
  return buildModelRef(payload, platformRows, catalog);
}

/** PostgreSQL: resolve the template provenance ref inside the caller's transaction. */
export async function resolveTemplateRefPg(
  tx: NodePgDatabase,
  orgId: string,
  assistantId: string,
): Promise<ResolvedManifest['templateRef']> {
  const installs = await tx
    .select()
    .from(assistantInstalls)
    .where(eq(assistantInstalls.assistantId, assistantId))
    .limit(1);
  const install = installs[0];
  if (!install || install.organizationId !== orgId) {
    return null;
  }
  const templates = await tx
    .select({ hash: assistantTemplates.hash })
    .from(assistantTemplates)
    .where(
      and(
        eq(assistantTemplates.slug, install.slug),
        eq(assistantTemplates.version, install.templateVersion),
      ),
    )
    .limit(1);
  return {
    slug: install.slug,
    version: install.templateVersion,
    definition_hash: templates[0]?.hash ?? null,
  };
}

/**
 * Pure: the manifest hash covers exactly the resolved set plus the
 * prompt-affecting policies — rerunning resolution on identical inputs
 * reproduces it byte-identically (TPL-5.7). G4: brand is prompt-affecting —
 * it joins the manifest hash so a voice change is a manifest change (pins,
 * diffs, and audits agree).
 */
export function manifestHashFor(
  toolBindings: ToolBinding[],
  knowledgePins: KnowledgePin[],
  modelRef: ModelRef,
  templateRef: ResolvedManifest['templateRef'],
  payload: Pick<AssistantPayload, 'guardrail_policy' | 'budget_policy' | 'brand'>,
): string {
  return canonicalHash({
    tool_bindings: toolBindings,
    knowledge_pins: knowledgePins,
    model_ref: modelRef,
    template_ref: templateRef,
    guardrail_policy: payload.guardrail_policy,
    budget_policy: payload.budget_policy ?? null,
    brand_voice: payload.brand ?? null,
  });
}

/**
 * PostgreSQL: resolve the full publish manifest inside the caller's
 * transaction. Byte-identical to the former
 * `ManifestResolutionService.resolveForPublish`.
 */
export async function resolveForPublishPg(
  tx: NodePgDatabase,
  deps: PgManifestDeps,
  orgId: string,
  assistantId: string,
  payload: AssistantPayload,
): Promise<ResolvedManifest> {
  const latestConfig = makeLatestConfigFn(deps.configPublish);
  const toolBindings = await resolveToolBindingsPg(tx, orgId, payload.tool_policy.tools);
  const knowledgePins = await resolveKnowledgePinsPg(
    tx,
    orgId,
    payload.context_policy.knowledge_sources ?? [],
    latestConfig,
  );
  const modelRef = await resolveModelRefPg(deps, orgId, payload, latestConfig);
  const templateRef = await resolveTemplateRefPg(tx, orgId, assistantId);
  const manifestHash = manifestHashFor(toolBindings, knowledgePins, modelRef, templateRef, payload);
  return { toolBindings, knowledgePins, modelRef, templateRef, manifestHash };
}
