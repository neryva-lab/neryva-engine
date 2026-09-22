import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import { ApiError } from '../../common/http/api-error';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { toolCatalog } from './tool-catalog.schema';
import { BUILT_IN_TOOLS } from './tool-catalog.service';
import { assistantInstalls, assistantTemplates } from './schema';
import { modelCatalogEntries } from './model-catalog.schema';
import { qualifyModelAliases } from '../../common/model-aliases';
import { chunks, documents, documentVersions, embeddings } from '../knowledge/schema';
import type { AssistantPayload } from './validation';

/**
 * Publish-time dependency resolution — TPL-5.2 … TPL-5.5.
 *
 * Turns the validated DRAFT payload into the immutable resolved set stored
 * on the policy snapshot: ToolBindings (catalog row pinned at publish),
 * knowledge pins (source slugs to document_version ids), model refs
 * (aliases to catalog entries), and the template provenance ref. The
 * manifest hash covers exactly this resolved set — rerunning resolution on
 * identical inputs reproduces it byte-identically (TPL-5.7).
 *
 * Resolution NEVER mutates catalog/documents/config rows — it only reads.
 * Anything unresolvable fails closed HERE (publish/rollback TX aborts)
 * except explicitly documented degradations (unresolved knowledge pins are
 * recorded, not fatal — retrieval degrades and eval judges quality).
 *
 * Transaction discipline: every method takes the CALLER's transaction and
 * reads inside it — resolution sees the same snapshot the publish TX
 * commits. The only exception is configPublish.latest (model/knowledge
 * catalogs), which opens its own read TX: catalog rows are slow-moving and
 * every resolved value is hash-anchored, so drift surfaces as a typed
 * mismatch at authorize time rather than silent staleness.
 */

export interface ToolBinding {
  /** Catalog row id, or null for platform built-ins (no row exists). */
  tool_id: string | null;
  name: string;
  /** Catalog row version at publish, or the built-in contract version. */
  tool_version: string;
  /** Catalog content hash at publish (the mutation detector), null for built-ins. */
  schema_hash: string | null;
  capability_class: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
  /** Reserved for authorization_policies (ledger 2.8) — null until it lands. */
  authorization_policy: null;
  approval_mode: 'REQUIRED' | 'NONE';
  /** Pointer to the sealed credential holder — never secret material. */
  credential_binding: { catalog_tool_id: string } | null;
  timeout_ms: number;
  retry_policy: { max_attempts: number; backoff_ms: number };
  rate_limit_per_run: number | null;
  /**
   * P4 (execution perimeter): environment + egress pinned from the catalog
   * row AT PUBLISH (built-ins: in_process + []). authorizeToolCall denies
   * when the live row disagrees (perimeter drift) — the schema hash is
   * schema identity and intentionally does NOT cover these (see
   * normalizeToolPerimeter).
   */
  execution_environment: 'in_process' | 'sandboxed_microvm' | 'external_gateway';
  allowed_egress_domains: string[];
  /** P4: live | shadow, from the version's tool_policy entry (default live). */
  execution_mode: 'live' | 'shadow';
}

export interface EmbeddingCoverage {
  /** The model the pinned version's chunks must be embedded with. */
  model: string;
  /** Chunks in the pinned document version. */
  chunk_total: number;
  /** Of those, rows present in `embeddings` for `model`. */
  chunk_embedded: number;
  complete: boolean;
}

export interface KnowledgePin {
  source_slug: string;
  resolved: boolean;
  document_id: string | null;
  document_version_id: string | null;
  document_version: number | null;
  sha256_hex: string | null;
  parser_version: string | null;
  embedding_model: string | null;
  /**
   * P0 (ai-native-review.md GAP-1): embedding coverage of the PINNED version
   * for the pin's model. A READY document whose vectors are not (yet) indexed
   * for the active model retrieval-scores nothing — the publish gate treats
   * incomplete coverage as degraded. Null when unresolved (unknown ≠
   * incomplete) or when the pin carries no model (legacy snapshots).
   */
  embedding_coverage: EmbeddingCoverage | null;
  /** Org knowledge_config at publish (id + payload hash + chunking params), null when unpublished. */
  knowledge_config: {
    config_id: string;
    payload_hash: string;
    chunk_size: unknown;
    chunk_overlap: unknown;
    embedding_model: unknown;
  } | null;
}

export interface ModelRef {
  models: Array<{
    provider: string;
    model: string;
    catalog_config_id: string | null;
    catalog_payload_hash: string | null;
    entry_hash: string | null;
    catalog_enabled: boolean | null;
  }>;
  model_params: unknown;
}

export interface TemplateRef {
  slug: string;
  version: string;
  definition_hash: string | null;
}

export interface ResolvedManifest {
  toolBindings: ToolBinding[];
  knowledgePins: KnowledgePin[];
  modelRef: ModelRef;
  templateRef: TemplateRef | null;
  manifestHash: string;
}

/**
 * Degraded-knowledge gate input: source slugs declared but unresolvable at
 * publish time (no READY document carries the slug). Pure over the resolved
 * manifest — unit-tested. The publish path refuses these (422) unless the
 * caller explicitly acknowledges degraded knowledge (audited bypass).
 */
export function unresolvedPinSlugs(manifest: Pick<ResolvedManifest, 'knowledgePins'>): string[] {
  return manifest.knowledgePins.filter((p) => !p.resolved).map((p) => p.source_slug);
}

/**
 * P0 (ai-native-review.md GAP-1) — pins that resolve to a document but whose
 * pinned version is NOT fully embedded for the pin's model. Pure over the
 * resolved manifest — unit-tested. Pins with null coverage (unresolved, or
 * legacy snapshots predating coverage) are NOT listed here: unknown coverage
 * is not incomplete coverage, and legacy rows must keep publishing exactly as
 * before this field existed.
 */
export function undercoveredPinSlugs(
  manifest: Pick<ResolvedManifest, 'knowledgePins'>,
): Array<{ slug: string; model: string; embedded: number; total: number }> {
  const out: Array<{ slug: string; model: string; embedded: number; total: number }> = [];
  for (const pin of manifest.knowledgePins) {
    // Legacy snapshot rows predate the field (undefined at runtime) — the
    // nullish coalescing keeps them out: unknown coverage is not incomplete.
    const coverage = pin.embedding_coverage ?? null;
    if (pin.resolved && coverage && !coverage.complete) {
      out.push({
        slug: pin.source_slug,
        model: coverage.model,
        embedded: coverage.chunk_embedded,
        total: coverage.chunk_total,
      });
    }
  }
  return out;
}

/** Default retry posture, versioned with the snapshot (auditable, overridable later). */
const RETRY_POLICY_V1 = {
  READ_ONLY: { max_attempts: 2, backoff_ms: 500 },
  MUTATING: { max_attempts: 1, backoff_ms: 0 },
  DESTRUCTIVE: { max_attempts: 1, backoff_ms: 0 },
} as const;

@Injectable()
export class ManifestResolutionService {
  constructor(
    private readonly db: DbService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  async resolveForPublish(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
    payload: AssistantPayload,
  ): Promise<ResolvedManifest> {
    const toolBindings = await this.resolveToolBindings(tx, orgId, payload.tool_policy.tools);
    const knowledgePins = await this.resolveKnowledgePins(
      tx,
      orgId,
      payload.context_policy.knowledge_sources ?? [],
    );
    const modelRef = await this.resolveModelRef(orgId, payload);
    const templateRef = await this.resolveTemplateRef(tx, orgId, assistantId);
    const manifestHash = canonicalHash({
      tool_bindings: toolBindings,
      knowledge_pins: knowledgePins,
      model_ref: modelRef,
      template_ref: templateRef,
      guardrail_policy: payload.guardrail_policy,
      budget_policy: payload.budget_policy ?? null,
      // G4: brand is prompt-affecting — it joins the manifest hash so a
      // voice change is a manifest change (pins, diffs, and audits agree).
      brand_voice: payload.brand ?? null,
    });
    return { toolBindings, knowledgePins, modelRef, templateRef, manifestHash };
  }

  // ── Tools (TPL-5.2) ──────────────────────────────────────────────────

  private async resolveToolBindings(
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
    const byName = new Map(rows.map((r) => [r.name, r]));
    return tools.map((entry) => {
      const builtin = BUILT_IN_TOOLS.get(entry.name);
      const executionMode =
        entry.execution_mode === 'shadow' ? ('shadow' as const) : ('live' as const);
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
      const httpBinding = (row.httpBinding ?? {}) as { timeout_ms?: number };
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

  // ── Knowledge (TPL-5.3) ──────────────────────────────────────────────

  private async resolveKnowledgePins(
    tx: NodePgDatabase,
    orgId: string,
    sources: string[],
  ): Promise<KnowledgePin[]> {
    if (sources.length === 0) {
      return [];
    }
    const knowledgeConfig = await this.safeLatestConfig(orgId, 'knowledge_config');
    const configPayload = (knowledgeConfig?.payload ?? null) as {
      chunk_size?: unknown;
      chunk_overlap?: unknown;
      embedding_model?: unknown;
    } | null;
    const configRef =
      knowledgeConfig !== null && configPayload !== null
        ? {
            config_id: knowledgeConfig.id,
            payload_hash: canonicalHash(knowledgeConfig.payload),
            chunk_size: configPayload.chunk_size ?? null,
            chunk_overlap: configPayload.chunk_overlap ?? null,
            embedding_model: configPayload.embedding_model ?? null,
          }
        : null;
    const pins: KnowledgePin[] = [];
    for (const slug of sources) {
      pins.push(await this.pinSource(tx, orgId, slug, configRef));
    }
    return pins;
  }

  private async pinSource(
    tx: NodePgDatabase,
    orgId: string,
    slug: string,
    configRef: KnowledgePin['knowledge_config'],
  ): Promise<KnowledgePin> {
    const unresolved: KnowledgePin = {
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
    const coverage = await this.resolveEmbeddingCoverage(tx, orgId, v.id, docs[0].embeddingModel);
    return {
      source_slug: slug,
      resolved: true,
      document_id: docs[0].id,
      document_version_id: v.id,
      document_version: v.version,
      sha256_hex: Buffer.from(v.sha256 as unknown as Uint8Array).toString('hex'),
      parser_version: v.parserVersion,
      embedding_model: docs[0].embeddingModel,
      embedding_coverage: coverage,
      knowledge_config: configRef,
    };
  }

  private async resolveEmbeddingCoverage(
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
      .where(
        and(eq(chunks.documentVersionId, documentVersionId), eq(chunks.organizationId, orgId)),
      );
    const total = rows.length;
    const embedded = rows.filter((r) => r.embedded !== null).length;
    // Vacuous truth: a chunkless version has nothing to index, so there is
    // no indexing gap to refuse over — degraded means "vectors missing", not
    // "document empty".
    return { model, chunk_total: total, chunk_embedded: embedded, complete: embedded === total };
  }

  // ── Models (TPL-5.4) ─────────────────────────────────────────────────

  private async resolveModelRef(orgId: string, payload: AssistantPayload): Promise<ModelRef> {
    const catalog = await this.safeLatestConfig(orgId, 'model_catalog');
    const entries =
      (
        catalog?.payload as {
          models?: Array<{ provider: string; model: string; enabled: boolean }>;
        } | null
      )?.models ?? null;
    const catalogPayloadHash = catalog !== null ? canonicalHash(catalog.payload) : null;
    // Qualify bare aliases against the platform catalog so the snapshot's
    // modelRef carries real providers (not "unknown") — the run-time
    // provider check in mcp-authority reads modelRef.models[].provider.
    const platformRows = await this.db.root
      .select({
        provider: modelCatalogEntries.provider,
        modelId: modelCatalogEntries.modelId,
      })
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.status, 'active'));
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

  // ── Template provenance (TPL-5.5) ────────────────────────────────────

  private async resolveTemplateRef(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
  ): Promise<TemplateRef | null> {
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

  private async safeLatestConfig(
    orgId: string,
    scope: 'model_catalog' | 'knowledge_config',
  ): Promise<{ id: string; payload: unknown } | null> {
    try {
      const latest = await this.configPublish.latest(orgId, scope, null);
      if (!latest) return null;
      return {
        id: (latest as { id?: string }).id ?? 'unknown',
        payload: (latest as { payload?: unknown }).payload ?? null,
      };
    } catch {
      return null;
    }
  }
}
