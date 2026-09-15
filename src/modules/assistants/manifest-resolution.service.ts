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
import { documents, documentVersions } from '../knowledge/schema';
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

  async resolveForPublish(tx: NodePgDatabase, orgId: string, assistantId: string, payload: AssistantPayload): Promise<ResolvedManifest> {
    const toolBindings = await this.resolveToolBindings(tx, orgId, payload.tool_policy.tools);
    const knowledgePins = await this.resolveKnowledgePins(tx, orgId, payload.context_policy.knowledge_sources ?? []);
    const modelRef = await this.resolveModelRef(orgId, payload);
    const templateRef = await this.resolveTemplateRef(tx, orgId, assistantId);
    const manifestHash = canonicalHash({
      tool_bindings: toolBindings,
      knowledge_pins: knowledgePins,
      model_ref: modelRef,
      template_ref: templateRef,
      guardrail_policy: payload.guardrail_policy,
      budget_policy: payload.budget_policy ?? null,
    });
    return { toolBindings, knowledgePins, modelRef, templateRef, manifestHash };
  }

  // ── Tools (TPL-5.2) ──────────────────────────────────────────────────

  private async resolveToolBindings(
    tx: NodePgDatabase,
    orgId: string,
    tools: Array<{ name: string; access: string; approval?: string; schema_hash?: string }>,
  ): Promise<ToolBinding[]> {
    const catalogNames = tools.map((t) => t.name).filter((n) => !BUILT_IN_TOOLS.has(n));
    const rows =
      catalogNames.length === 0
        ? []
        : await tx.select().from(toolCatalog).where(eq(toolCatalog.organizationId, orgId));
    const byName = new Map(rows.map((r) => [r.name, r]));
    return tools.map((entry) => {
      const builtin = BUILT_IN_TOOLS.get(entry.name);
      if (builtin) {
        return {
          tool_id: null,
          name: entry.name,
          tool_version: '1.0.0-platform',
          schema_hash: null,
          capability_class: builtin.effectClass,
          authorization_policy: null,
          approval_mode: entry.approval === 'required' || builtin.approvalRequirement === 'REQUIRED' ? 'REQUIRED' : 'NONE',
          credential_binding: null,
          timeout_ms: 30000,
          retry_policy: { ...RETRY_POLICY_V1[builtin.effectClass] },
          rate_limit_per_run: null,
        } satisfies ToolBinding;
      }
      const row = byName.get(entry.name);
      if (!row || !row.enabled) {
        // assertToolPins runs before resolution in the publish path and
        // rejects this case with a typed error — this is the fail-closed
        // backstop if resolution is ever called without it.
        throw ApiError.validation({ tool_policy: `tool pins rejected: ${entry.name}: not present in the tool catalog or disabled` });
      }
      if (entry.schema_hash !== undefined && entry.schema_hash !== row.hash) {
        throw ApiError.validation({ tool_policy: `tool pins rejected: ${entry.name}: schema_hash does not match the catalog entry (pin is stale)` });
      }
      const httpBinding = (row.httpBinding ?? {}) as { timeout_ms?: number };
      const capability = row.effectClass as ToolBinding['capability_class'];
      return {
        tool_id: row.id,
        name: entry.name,
        tool_version: row.version,
        schema_hash: row.hash,
        capability_class: capability,
        authorization_policy: null,
        approval_mode: entry.approval === 'required' || row.approvalRequirement === 'REQUIRED' ? 'REQUIRED' : 'NONE',
        credential_binding: row.credentialSealed != null ? { catalog_tool_id: row.id } : null,
        timeout_ms: typeof httpBinding.timeout_ms === 'number' ? httpBinding.timeout_ms : 30000,
        retry_policy: { ...RETRY_POLICY_V1[capability] },
        rate_limit_per_run: row.rateLimitPerRun,
      } satisfies ToolBinding;
    });
  }

  // ── Knowledge (TPL-5.3) ──────────────────────────────────────────────

  private async resolveKnowledgePins(tx: NodePgDatabase, orgId: string, sources: string[]): Promise<KnowledgePin[]> {
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
      knowledge_config: configRef,
    };
    // E-2 convention (deterministic): a seed slug matches the READY document
    // carrying it as source_slug — exact, org-unique, immutable except via
    // the explicit rename endpoint. No title match means the corpus is not
    // ingested — recorded unresolved, never invented.
    const docs = await tx
      .select({ id: documents.id, embeddingModel: documents.embeddingModel })
      .from(documents)
      .where(and(eq(documents.organizationId, orgId), eq(documents.sourceSlug, slug), eq(documents.state, 'ready')))
      .limit(1);
    if (docs.length === 0) {
      return unresolved;
    }
    const versions = await tx
      .select()
      .from(documentVersions)
      .where(and(eq(documentVersions.organizationId, orgId), eq(documentVersions.documentId, docs[0].id)))
      .orderBy(desc(documentVersions.version))
      .limit(1);
    if (versions.length === 0) {
      return unresolved;
    }
    const v = versions[0];
    return {
      source_slug: slug,
      resolved: true,
      document_id: docs[0].id,
      document_version_id: v.id,
      document_version: v.version,
      sha256_hex: Buffer.from(v.sha256 as unknown as Uint8Array).toString('hex'),
      parser_version: v.parserVersion,
      embedding_model: docs[0].embeddingModel,
      knowledge_config: configRef,
    };
  }

  // ── Models (TPL-5.4) ─────────────────────────────────────────────────

  private async resolveModelRef(orgId: string, payload: AssistantPayload): Promise<ModelRef> {
    const catalog = await this.safeLatestConfig(orgId, 'model_catalog');
    const entries = (catalog?.payload as { models?: Array<{ provider: string; model: string; enabled: boolean }> } | null)?.models ?? null;
    const catalogPayloadHash = catalog !== null ? canonicalHash(catalog.payload) : null;
    return {
      models: payload.model_policy.allowed_models.map((alias) => {
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

  private async resolveTemplateRef(tx: NodePgDatabase, orgId: string, assistantId: string): Promise<TemplateRef | null> {
    const installs = await tx.select().from(assistantInstalls).where(eq(assistantInstalls.assistantId, assistantId)).limit(1);
    const install = installs[0];
    if (!install || install.organizationId !== orgId) {
      return null;
    }
    const templates = await tx
      .select({ hash: assistantTemplates.hash })
      .from(assistantTemplates)
      .where(and(eq(assistantTemplates.slug, install.slug), eq(assistantTemplates.version, install.templateVersion)))
      .limit(1);
    return { slug: install.slug, version: install.templateVersion, definition_hash: templates[0]?.hash ?? null };
  }

  private async safeLatestConfig(orgId: string, scope: 'model_catalog' | 'knowledge_config'): Promise<{ id: string; payload: unknown } | null> {
    try {
      const latest = await this.configPublish.latest(orgId, scope, null);
      if (!latest) return null;
      return { id: (latest as { id?: string }).id ?? 'unknown', payload: (latest as { payload?: unknown }).payload ?? null };
    } catch {
      return null;
    }
  }
}
