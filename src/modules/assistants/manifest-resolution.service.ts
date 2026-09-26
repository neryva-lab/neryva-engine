import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import type { AssistantPayload } from './validation';
import { resolveForPublishPg } from './repositories/pg-manifest-resolution';

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

@Injectable()
export class ManifestResolutionService {
  constructor(
    private readonly db: DbService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  /**
   * Resolve the publish manifest inside the CALLER's transaction.
   *
   * Signature and behavior are unchanged — the SQL now lives in
   * `resolveForPublishPg` (repositories/pg-manifest-resolution.ts) and this
   * method supplies the two reads that are deliberately NOT part of the
   * caller's transaction: the fail-soft config lookup
   * (`configPublish.latest`, fail-soft by contract) and the platform model
   * catalog read (`db.root`, cross-org by design — it is the platform
   * catalog, not tenant data).
   */
  async resolveForPublish(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
    payload: AssistantPayload,
  ): Promise<ResolvedManifest> {
    return resolveForPublishPg(tx, { db: this.db, configPublish: this.configPublish }, orgId, assistantId, payload);
  }

  /**
   * Fail-soft latest-config read: a missing config or a read failure
   * resolves to null (the caller records a null config_ref / falls back),
   * never to a thrown error.
   */
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
