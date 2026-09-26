import { sql } from 'drizzle-orm';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { MemoryItem } from './schema';
import { withSpan, setSpanAttributes, queryHash } from '../../common/observability/spans';
import { EmbeddingService } from './embedding.service';
import { RerankerService } from './reranker.port';
import { QueryRewriteService } from './query-rewrite.port';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import { assertUuid } from './assert';
import {
  RETRIEVAL_REPOSITORY,
  RETRIEVAL_ACL_REPOSITORY,
  MEMORY_ITEM_REPOSITORY,
} from './repositories/repository-tokens';
import type { IRetrievalRepository } from './repositories/retrieval.repository';
import type { IRetrievalAclRepository } from './repositories/retrieval-acl.repository';
import type { IMemoryItemRepository } from './repositories/memory-item.repository';
import type { MemoryScope } from './repositories/repository-types';

/**
 * Retrieval — Phase 7.7 (ledger) + FL-2.1/2.4. TENANT + ACL PREDICATES RUN
 * BEFORE SCORING: every search statement (vector leg, lexical leg, memory
 * leg) carries `organization_id` + visibility/ACL filters in the WHERE clause
 * of the same statement that orders by `<=>` or `ts_rank_cd` — post-ranking
 * filtering is not authorization and is never used. Deleted/quarantined/
 * not-READY documents are unreachable by construction.
 *
 * FL-2.1 hybrid retrieval: the pgvector leg and the PG FTS leg (stored
 * tsvector, 0038 GIN index) run in parallel over the same predicates, fuse
 * with Reciprocal Rank Fusion (k=60), then the cross-encoder reranker
 * (default OFF — noop adapter) reorders the fused candidates. A reranker can
 * never drop or widen the candidate set, only reorder it.
 *
 * P0 (ai-native-review.md BUG-1) — model-scoped vector search: every vector
 * leg (document chunks AND semantic memories) constrains rows to the query's
 * embedding model. Vector spaces are per-model; comparing a query vector
 * against rows embedded by another model produces meaningless scores. During
 * a migration window both generations coexist (the re-embed worker keeps old
 * rows until new rows land), so the filter is load-bearing, not cosmetic.
 * Memory rows predating the `embedding_model` column (NULL) still
 * participate — they converge out as memories are re-approved/rewritten.
 */
export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  sequence: number;
  text: string;
  sourceRange: { byteStart: number; byteEnd: number };
  score: number;
  /** Document display title when available — citation support. */
  title?: string | null;
}

/** RRF constant — k=60 per Cormack et al.; dampens early-rank dominance. */
const RRF_K = 60;
/** Candidate pool per leg — deep enough for fusion, shallow enough for EXPLAIN. */
const CANDIDATE_POOL = 100;
/** FL-3.7 — vector-leg cap across expanded variants (FTS legs are cheap; embeddings are not). */
const MAX_VECTOR_VARIANTS = 3;

/**
 * P0-1 — source-ACL predicate (joins the scoring WHERE, never post-filter).
 * A document WITH source-acl rows is restricted: admitted only for callers
 * matching a listed principal by linked account or verified email. A
 * document with NO rows keeps the legacy posture. Unknown principals
 * default-deny; anonymous callers (no identity) see unrestricted docs only.
 * Pure — unit-tested (fragment assertions, not full-SQL snapshots).
 *
 * NOTE (P3): this builder is imported by `PgRetrievalRepository`, which
 * builds the byte-identical leg SQL inside the repository's transaction
 * shell. It stays here — with its unit test — as the canonical definition.
 */
export function buildSourceAclFilter(input: {
  orgId: string;
  accountId: string | null;
  emails: string[];
}): ReturnType<typeof sql> {
  const restricted = sql`exists (select 1 from document_source_acls s where s.document_id = d.id)`;
  if (input.accountId === null && input.emails.length === 0) {
    return sql`and (not ${restricted})`;
  }
  const emailList = input.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
  return sql`and ((not ${restricted}) or (exists (
    select 1 from document_source_acls s
    where s.document_id = d.id
      and (
        (${
          input.accountId === null
            ? sql`false`
            : sql`exists (
          select 1 from external_identity_links l
          where l.organization_id = ${input.orgId}::uuid
            and l.provider = s.provider
            and l.external_id = s.external_id
            and l.account_id = ${input.accountId}::uuid
        )`
        })
        or (${
          emailList.length === 0
            ? sql`false`
            : sql`exists (
          select 1 from external_principals p
          where p.organization_id = ${input.orgId}::uuid
            and p.provider = s.provider
            and p.external_id = s.external_id
            and lower(p.email) in (${sql.join(
              emailList.map((e) => sql`${e}`),
              sql`, `,
            )})
        )`
        })
      )
  )))`;
}

@Injectable()
export class RetrievalService {
  private static readonly logger = new Logger(RetrievalService.name);

  constructor(
    @Inject(RETRIEVAL_REPOSITORY) private readonly legs: IRetrievalRepository,
    @Inject(RETRIEVAL_ACL_REPOSITORY) private readonly acl: IRetrievalAclRepository,
    @Inject(MEMORY_ITEM_REPOSITORY) private readonly memories: IMemoryItemRepository,
    private readonly embedding: EmbeddingService,
    private readonly reranker: RerankerService,
    private readonly rewrite: QueryRewriteService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  /**
   * P0 (ai-native-review.md BUG-1) — the query's embedding model: the org's
   * `knowledge_config.embedding_model` when set (the same `effective` rule the
   * re-embed worker uses: configured ?? service default), else the embedding
   * service default. Config-read failure falls back to the service default
   * (legacy behavior) — a search must never fail because governance config is
   * momentarily unreadable; the model filter then matches the rows the
   * previous code path would have scored, minus cross-model contamination.
   */
  private async resolveQueryEmbeddingModel(orgId: string): Promise<string> {
    try {
      const latest = await this.configPublish.latest(orgId, 'knowledge_config', null);
      const configured = String(
        (latest?.payload as { embedding_model?: string } | undefined)?.embedding_model ?? '',
      ).trim();
      if (configured.length > 0) {
        return configured;
      }
    } catch (err) {
      RetrievalService.logger.warn(
        `query embedding model fell back to service default for org ${orgId}: ${(err as Error).message}`,
      );
    }
    return this.embedding.model;
  }

  private toVectorLiteral(vec: number[]): string {
    return `[${vec.join(',')}]`;
  }

  private static rowToHit(row: Record<string, unknown>): KnowledgeHit {
    const text = String(row.text);
    return {
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      documentVersionId: String(row.document_version_id),
      sequence: Number(row.sequence),
      text,
      sourceRange: RetrievalService.coerceRange(row.source_range, text.length),
      score: Number(row.score),
      title: row.title == null ? null : String(row.title),
    };
  }

  /**
   * Live-verification fix (team_setup_ledger.md F6): the raw-SQL legs return
   * jsonb as TEXT, so the wire carried sourceRange as a JSON string while
   * the interface (and MCP SearchKnowledge) promise an object. Coerce here
   * so every consumer sees the shape. Unparseable → whole-chunk span (the
   * only derivable truth), never invented offsets.
   */
  private static coerceRange(
    raw: unknown,
    textLength: number,
  ): { byteStart: number; byteEnd: number } {
    const candidate: unknown =
      typeof raw === 'string'
        ? (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return null;
            }
          })()
        : raw;
    if (typeof candidate === 'object' && candidate !== null) {
      const range = candidate as Record<string, unknown>;
      const start =
        typeof range.byteStart === 'number'
          ? range.byteStart
          : typeof range.byte_start === 'number'
            ? (range.byte_start as number)
            : 0;
      const end =
        typeof range.byteEnd === 'number'
          ? range.byteEnd
          : typeof range.byte_end === 'number'
            ? (range.byte_end as number)
            : textLength;
      return { byteStart: start, byteEnd: end };
    }
    return { byteStart: 0, byteEnd: textLength };
  }

  /**
   * E-1 — pin enforcement lives HERE, inside the scoring statements.
   * `allowedDocumentVersionIds`: undefined = legacy org-wide posture (console
   * test box, eval recall); [] = constrain to nothing (pins declared, none
   * resolved — fail-closed); non-empty = chunks limited to those versions.
   * The version predicate joins the same WHERE as tenant+ACL, before
   * `<=>`/`ts_rank_cd` — never post-filtered. IDs are UUID-validated.
   */
  async searchKnowledge(input: {
    orgId: string;
    query: string;
    limit?: number;
    accountId?: string;
    allowedDocumentVersionIds?: string[];
    /** P0-1: caller external identities for source-ACL matching (email-based). */
    callerEmails?: string[];
    callerAccountId?: string;
  }): Promise<KnowledgeHit[]> {
    assertUuid(input.orgId, 'orgId');
    const query = input.query.trim();
    if (query.length === 0) {
      throw ApiError.validation({ query: 'must not be empty' });
    }
    if (query.length > 512) {
      throw ApiError.validation({ query: 'max 512 chars' });
    }
    const limit = Math.min(Math.max(1, input.limit ?? 5), 20);
    // E-1: an explicitly empty allow-list constrains to nothing (fail-closed);
    // undefined preserves the legacy org-wide posture for unpinned callers.
    if (
      input.allowedDocumentVersionIds !== undefined &&
      input.allowedDocumentVersionIds.length === 0
    ) {
      return [];
    }
    const allowedVersions =
      input.allowedDocumentVersionIds === undefined
        ? null
        : input.allowedDocumentVersionIds.map((id) => {
            assertUuid(id, 'allowedDocumentVersionIds[]');
            return id;
          });
    // FL-3.7 — multi-query expansion (identity when the port is unset). Each
    // variant contributes its own FTS leg; the vector legs are bounded to
    // MAX_VECTOR_VARIANTS so the amplification stays deterministic.
    const variants = await this.rewrite.expand(query);
    // P0 (BUG-1): the query model MUST equal the model the scored rows were
    // embedded with — same `effective` rule as the re-embed worker.
    const queryModel = await this.resolveQueryEmbeddingModel(input.orgId);
    const embeddings = await this.embedding.embed(variants.slice(0, MAX_VECTOR_VARIANTS));
    const pool = Math.min(limit * 4, CANDIDATE_POOL);

    // The leg SQL is built inside the repository's transaction shell (one
    // tenant-scoped TX on one connection — RLS consistency across legs); the
    // service hands over pre-computed vectors and primitive ACL inputs.
    const vectorLegs = embeddings
      .slice(0, MAX_VECTOR_VARIANTS)
      .filter((vector) => !vector.every((v) => v === 0))
      .map((vector) => ({
        vectorLiteral: this.toVectorLiteral(vector),
        pool,
        queryModel,
      }));
    const ftsLegs = variants.map((variant) => ({ variant, pool }));

    // P1 (§6a) — rag.retrieval span. Attributes are ids/hashes/counts only:
    // the raw query text never enters a span (query_hash instead).
    const hits = await withSpan(
      'rag.retrieval',
      {
        org_id: input.orgId,
        query_hash: queryHash(query),
        variant_count: variants.length,
        embedding_model: queryModel,
        limit,
        pinned_versions: allowedVersions === null ? -1 : allowedVersions.length,
      },
      async (span) => {
        const finish = (ranked: KnowledgeHit[]): KnowledgeHit[] => {
          setSpanAttributes(span, {
            hit_count: ranked.length,
            top_score: ranked.length > 0 ? Math.round(ranked[0].score * 1000) / 1000 : null,
          });
          return ranked;
        };
        const { vectorLegs: vectorRows, ftsLegs: ftsRows } = await this.legs.runRetrievalLegs({
          orgId: input.orgId,
          vectorLegs,
          ftsLegs,
          versionIds: allowedVersions,
          accountId: input.accountId ?? null,
          callerAccountId: input.callerAccountId ?? null,
          callerEmails: input.callerEmails ?? [],
        });

        // Reciprocal Rank Fusion over ALL ranked legs (dedupe by chunk).
        const fused = new Map<string, { hit: KnowledgeHit; rrf: number }>();
        const leg = (rows: Array<Record<string, unknown>>) =>
          rows.map((row, i) => ({ row, rank: i + 1 }));
        for (const rows of vectorRows) {
          for (const { row, rank } of leg(rows)) {
            const hit = RetrievalService.rowToHit(row);
            const existing = fused.get(hit.chunkId);
            if (existing) {
              existing.rrf += 1 / (RRF_K + rank);
            } else {
              fused.set(hit.chunkId, { hit, rrf: 1 / (RRF_K + rank) });
            }
          }
        }
        for (const rows of ftsRows) {
          for (const { row, rank } of leg(rows)) {
            const contribution = 1 / (RRF_K + rank);
            const existing = fused.get(String(row.chunk_id));
            if (existing) {
              existing.rrf += contribution;
            } else {
              fused.set(String(row.chunk_id), {
                hit: RetrievalService.rowToHit(row),
                rrf: contribution,
              });
            }
          }
        }
        if (fused.size === 0) {
          return finish([]);
        }
        const candidates = [...fused.values()].sort((a, b) => b.rrf - a.rrf).map((f) => f.hit);
        // Cross-encoder stage (default noop = identity slice). Bounded to limit.
        return finish(await this.reranker.rerank(query, candidates, limit));
      },
    );
    return hits;
  }

  /**
   * FL-2.4 — semantic memory search. The query embedding orders APPROVED,
   * non-deleted, non-expired memory items whose scope appears in the
   * caller-authorized scope list (the scope OR-list is part of the ranking
   * statement). Zero vector signal degrades to recency-ordered selection;
   * pre-0038 rows without vectors top up from the recency tail.
   */
  async searchApprovedMemories(input: {
    orgId: string;
    query: string;
    scopes: Array<{
      scopeType: 'organization' | 'conversation' | 'user' | 'assistant';
      scopeId?: string;
    }>;
    limit?: number;
  }): Promise<MemoryItem[]> {
    assertUuid(input.orgId, 'orgId');
    const limit = Math.min(Math.max(1, input.limit ?? 20), 20);
    if (input.scopes.length === 0) {
      return [];
    }
    const scopes: MemoryScope[] = input.scopes.map((s) => ({
      scopeType: s.scopeType,
      scopeId: s.scopeId ?? null,
    }));
    const trimmedQuery = input.query.trim().slice(0, 512);
    if (!trimmedQuery) {
      return this.listApprovedMemoriesForScopes(input.orgId, input.scopes, limit);
    }
    // P0 (BUG-1): same model rule as the document leg. Legacy rows with NULL
    // embedding_model (pre-0064) still participate — they converge out as
    // memories are re-approved/rewritten with the model stamped.
    const queryModel = await this.resolveQueryEmbeddingModel(input.orgId);
    const [vector] = await this.embedding.embed([trimmedQuery]);
    const hasSignal = !vector.every((v) => v === 0);
    if (!hasSignal) {
      return this.listApprovedMemoriesForScopes(input.orgId, input.scopes, limit);
    }
    const vectorLiteral = this.toVectorLiteral(vector);
    // P1 (§6a) — same attribute law as the document leg.
    const memories = await withSpan(
      'rag.retrieval',
      {
        org_id: input.orgId,
        query_hash: queryHash(trimmedQuery),
        embedding_model: queryModel,
        limit,
        scope_count: input.scopes.length,
        leg: 'memory',
      },
      async (span) => {
        const finish = (items: MemoryItem[]): MemoryItem[] => {
          setSpanAttributes(span, { hit_count: items.length });
          return items;
        };
        const semantic = await this.memories.searchApprovedMemoriesVector({
          orgId: input.orgId,
          vectorLiteral,
          queryModel,
          scopes,
          limit,
        });
        if (semantic.length < limit) {
          // Top-up with recency items (covers pre-0038 rows without vectors).
          // P0 (BUG-1): the top-up must not smuggle foreign-model rows back in
          // through the back door. A row carrying a vector in ANOTHER space is
          // neither rankable (wrong space) nor top-up-able (it HAS a vector —
          // the top-up exists for rows that cannot rank at all). Skip exactly
          // those; NULL-model legacy rows and unvectored rows still top up.
          const have = new Set(semantic.map((m) => m.id));
          for (const item of await this.listApprovedMemoriesForScopes(
            input.orgId,
            input.scopes,
            limit,
          )) {
            if (semantic.length >= limit) break;
            if (have.has(item.id)) continue;
            if (
              item.embedding !== null &&
              item.embeddingModel !== null &&
              item.embeddingModel !== queryModel
            )
              continue;
            semantic.push(item);
          }
        }
        return finish(semantic);
      },
    );
    return memories;
  }

  private async listApprovedMemoriesForScopes(
    orgId: string,
    scopes: Array<{
      scopeType: 'organization' | 'conversation' | 'user' | 'assistant';
      scopeId?: string;
    }>,
    limit: number,
  ): Promise<MemoryItem[]> {
    return this.memories.listApprovedMemoriesForScopes(
      orgId,
      scopes.map((s) => ({ scopeType: s.scopeType, scopeId: s.scopeId ?? null })),
      limit,
    );
  }

  /**
   * Approved memories for a run context — scope authorization BEFORE return
   * (Phase 5.5 manifest path). Only APPROVED, non-deleted, non-expired items
   * whose scope matches the conversation's org/conversation scope are
   * visible; proposals never surface here.
   */
  async listApprovedMemories(input: {
    orgId: string;
    conversationId?: string;
    limit?: number;
  }): Promise<MemoryItem[]> {
    assertUuid(input.orgId, 'orgId');
    const limit = Math.min(Math.max(1, input.limit ?? 20), 20);
    return this.memories.listApprovedMemories({
      orgId: input.orgId,
      conversationId: input.conversationId,
      limit,
    });
  }

  /** ACL grant helper — documents default to organization visibility at ingest. */
  async grantDocumentAccess(input: {
    orgId: string;
    documentId: string;
    visibility: 'organization' | 'private';
    accountId?: string;
  }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.documentId, 'documentId');
    if (input.visibility === 'private' && !input.accountId) {
      throw ApiError.validation({ account_id: 'private visibility requires an account scope' });
    }
    await this.acl.grantDocumentAccess({
      orgId: input.orgId,
      documentId: input.documentId,
      visibility: input.visibility,
      scopeAccountId: input.visibility === 'private' ? (input.accountId as string) : null,
    });
  }

  /** Rebuild-path helper: chunk metadata parity check after re-ingestion (exit gate). */
  static chunkFingerprint(text: string, sequence: number): string {
    return canonicalHash({ sequence, text });
  }
}
