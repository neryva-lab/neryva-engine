import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { uuidv7 } from '../../common/ids/uuidv7';
import { memoryItems, MemoryItem, retrievalAcl } from './schema';
import { EmbeddingService } from './embedding.service';
import { RerankerService } from './reranker.port';
import { QueryRewriteService } from './query-rewrite.port';
import { assertUuid } from './assert';

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
 */
export function buildSourceAclFilter(input: { orgId: string; accountId: string | null; emails: string[] }): ReturnType<typeof sql> {
  const restricted = sql`exists (select 1 from document_source_acls s where s.document_id = d.id)`;
  if (input.accountId === null && input.emails.length === 0) {
    return sql`and (not ${restricted})`;
  }
  const emailList = input.emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
  return sql`and ((not ${restricted}) or (exists (
    select 1 from document_source_acls s
    where s.document_id = d.id
      and (
        (${input.accountId === null ? sql`false` : sql`exists (
          select 1 from external_identity_links l
          where l.organization_id = ${input.orgId}::uuid
            and l.provider = s.provider
            and l.external_id = s.external_id
            and l.account_id = ${input.accountId}::uuid
        )`})
        or (${emailList.length === 0
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
        )`})
      )
  )))`;
}

@Injectable()
export class RetrievalService {
  constructor(
    private readonly db: DbService,
    private readonly embedding: EmbeddingService,
    private readonly reranker: RerankerService,
    private readonly rewrite: QueryRewriteService,
  ) {}

  private toVectorLiteral(vec: number[]): string {
    return `[${vec.join(',')}]`;
  }

  private static rowToHit(row: Record<string, unknown>): KnowledgeHit {
    return {
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      documentVersionId: String(row.document_version_id),
      sequence: Number(row.sequence),
      text: String(row.text),
      sourceRange: row.source_range as { byteStart: number; byteEnd: number },
      score: Number(row.score),
      title: row.title == null ? null : String(row.title),
    };
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
    if (input.allowedDocumentVersionIds !== undefined && input.allowedDocumentVersionIds.length === 0) {
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
    const embeddings = await this.embedding.embed(variants.slice(0, MAX_VECTOR_VARIANTS));
    const pool = Math.min(limit * 4, CANDIDATE_POOL);

    return this.db.withOrg(input.orgId, async (tx) => {
      const accountId = input.accountId ?? null;

      // Shared tenant + ACL predicate — byte-identical shape across both legs
      // (the vector leg drives from `embeddings e`, the lexical leg from
      // `chunks c`, hence the two anchor aliases). E-1 pin filter and P0-1
      // source-ACL filter join the same WHERE — authorization before scoring.
      const versionFilter =
        allowedVersions === null
          ? sql``
          : sql`and c.document_version_id in (${sql.join(
              allowedVersions.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`;
      const sourceAclFilter = buildSourceAclFilter({
        orgId: input.orgId,
        accountId: input.callerAccountId ?? accountId,
        emails: input.callerEmails ?? [],
      });
      const aclPredicate = (anchor: 'e' | 'c') => sql`
        left join retrieval_acl acl
          on acl.organization_id = d.organization_id
          and acl.resource_type = 'document'
          and acl.resource_id = d.id
        where ${sql.raw(anchor)}.organization_id = ${input.orgId}::uuid
          and d.state = 'ready'
          and a.state = 'active'
          and (a.scan_status in ('clean', 'skipped'))
          and (a.expires_at is null or a.expires_at > now())
          and (acl.visibility = 'organization' or (acl.visibility = 'private' and acl.scope_account_id = ${accountId}::uuid))
          ${versionFilter}
          ${sourceAclFilter}`;

      const vectorLegs: Array<Array<Record<string, unknown>>> = [];
      for (let i = 0; i < Math.min(variants.length, MAX_VECTOR_VARIANTS); i++) {
        const vector = embeddings[i];
        const hasVectorSignal = !vector.every((v) => v === 0);
        const vectorLiteral = this.toVectorLiteral(vector);
        if (!hasVectorSignal) {
          continue;
        }
        const rows = await tx.execute(sql`
          select c.id as chunk_id, c.sequence, c.text, c.source_range,
                 dv.id as document_version_id, d.id as document_id, d.title as title,
                 1 - (e.embedding <=> ${vectorLiteral}::vector) as score
          from embeddings e
          join chunks c on c.id = e.chunk_id
          join document_versions dv on dv.id = c.document_version_id
          join documents d on d.id = dv.document_id
          join artifacts a on a.id = d.source_artifact_id
          ${aclPredicate('e')}
          order by e.embedding <=> ${vectorLiteral}::vector
          limit ${pool}
        `);
        vectorLegs.push(rows.rows as Array<Record<string, unknown>>);
      }

      const ftsLegs: Array<Array<Record<string, unknown>>> = [];
      for (const variant of variants) {
        const rows = await tx.execute(sql`
          select c.id as chunk_id, c.sequence, c.text, c.source_range,
                 dv.id as document_version_id, d.id as document_id, d.title as title,
                 ts_rank_cd(c.fts, websearch_to_tsquery('english', ${variant})) as score
          from chunks c
          join document_versions dv on dv.id = c.document_version_id
          join documents d on d.id = dv.document_id
          join artifacts a on a.id = d.source_artifact_id
          ${aclPredicate('c')}
            and c.fts @@ websearch_to_tsquery('english', ${variant})
          order by score desc
          limit ${pool}
        `);
        ftsLegs.push(rows.rows as Array<Record<string, unknown>>);
      }

      // Reciprocal Rank Fusion over ALL ranked legs (dedupe by chunk).
      const fused = new Map<string, { hit: KnowledgeHit; rrf: number }>();
      const leg = (rows: Array<Record<string, unknown>>) => rows.map((row, i) => ({ row, rank: i + 1 }));
      for (const rows of vectorLegs) {
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
      for (const rows of ftsLegs) {
        for (const { row, rank } of leg(rows)) {
          const contribution = 1 / (RRF_K + rank);
          const existing = fused.get(String(row.chunk_id));
          if (existing) {
            existing.rrf += contribution;
          } else {
            fused.set(String(row.chunk_id), { hit: RetrievalService.rowToHit(row), rrf: contribution });
          }
        }
      }
      if (fused.size === 0) {
        return [];
      }
      const candidates = [...fused.values()].sort((a, b) => b.rrf - a.rrf).map((f) => f.hit);
      // Cross-encoder stage (default noop = identity slice). Bounded to limit.
      return this.reranker.rerank(query, candidates, limit);
    });
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
    scopes: Array<{ scopeType: 'organization' | 'conversation' | 'user' | 'assistant'; scopeId?: string }>;
    limit?: number;
  }): Promise<MemoryItem[]> {
    assertUuid(input.orgId, 'orgId');
    const limit = Math.min(Math.max(1, input.limit ?? 20), 20);
    if (input.scopes.length === 0) {
      return [];
    }
    const scopePredicates = input.scopes.map((s) =>
      s.scopeId
        ? sql`(scope_type = ${s.scopeType} and scope_id = ${s.scopeId}::uuid)`
        : sql`(scope_type = ${s.scopeType})`,
    );
    const trimmedQuery = input.query.trim().slice(0, 512);
    if (!trimmedQuery) {
      return this.listApprovedMemoriesForScopes(input.orgId, input.scopes, limit);
    }
    const [vector] = await this.embedding.embed([trimmedQuery]);
    const hasSignal = !vector.every((v) => v === 0);
    if (!hasSignal) {
      return this.listApprovedMemoriesForScopes(input.orgId, input.scopes, limit);
    }
    const vectorLiteral = this.toVectorLiteral(vector);
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select id, scope_type, scope_id, content, source_ref, provenance, confidence, visibility,
               expires_at, valid_from, invalid_at, supersedes, created_at, updated_at
        from memory_items
        where organization_id = ${input.orgId}::uuid
          and deleted_at is null
          and embedding is not null
          and (expires_at is null or expires_at > now())
          and (${sql.join(scopePredicates, sql` or `)})
        order by embedding <=> ${vectorLiteral}::vector
        limit ${limit}
      `);
      const semantic = (rows.rows as Array<Record<string, unknown>>).map(
        (r): MemoryItem => ({
          id: String(r.id),
          organizationId: input.orgId,
          scopeType: String(r.scope_type),
          scopeId: r.scope_id == null ? null : String(r.scope_id),
          content: String(r.content),
          sourceRef: r.source_ref ?? null,
          provenance: r.provenance == null ? null : String(r.provenance),
          confidence: r.confidence == null ? null : String(r.confidence),
          visibility: String(r.visibility),
          expiresAt: r.expires_at == null ? null : String(r.expires_at),
          deletedAt: null,
          embedding: null,
          validFrom: String(r.valid_from ?? r.created_at),
          invalidAt: r.invalid_at == null ? null : String(r.invalid_at),
          supersedes: r.supersedes == null ? null : String(r.supersedes),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        }),
      );
      if (semantic.length < limit) {
        // Top-up with recency items (covers pre-0038 rows without vectors).
        const have = new Set(semantic.map((m) => m.id));
        for (const item of await this.listApprovedMemoriesForScopes(input.orgId, input.scopes, limit)) {
          if (semantic.length >= limit) break;
          if (!have.has(item.id)) semantic.push(item);
        }
      }
      return semantic;
    });
  }

  private async listApprovedMemoriesForScopes(
    orgId: string,
    scopes: Array<{ scopeType: 'organization' | 'conversation' | 'user' | 'assistant'; scopeId?: string }>,
    limit: number,
  ): Promise<MemoryItem[]> {
    const scopePredicates = scopes.map((s) =>
      s.scopeId
        ? and(eq(memoryItems.scopeType, s.scopeType), eq(memoryItems.scopeId, s.scopeId))
        : eq(memoryItems.scopeType, s.scopeType),
    );
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.organizationId, orgId),
            isNull(memoryItems.deletedAt),
            or(...scopePredicates),
            or(isNull(memoryItems.expiresAt), sql`expires_at > now()`),
            or(isNull(memoryItems.invalidAt), sql`invalid_at > now()`),
          ),
        )
        .orderBy(desc(memoryItems.updatedAt))
        .limit(limit),
    );
  }

  /**
   * Approved memories for a run context — scope authorization BEFORE return
   * (Phase 5.5 manifest path). Only APPROVED, non-deleted, non-expired items
   * whose scope matches the conversation's org/conversation scope are
   * visible; proposals never surface here.
   */
  async listApprovedMemories(input: { orgId: string; conversationId?: string; limit?: number }): Promise<MemoryItem[]> {
    assertUuid(input.orgId, 'orgId');
    const limit = Math.min(Math.max(1, input.limit ?? 20), 20);
    return this.db.withOrg(input.orgId, (tx) =>
      tx
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.organizationId, input.orgId),
            isNull(memoryItems.deletedAt),
            or(
              eq(memoryItems.scopeType, 'organization'),
              input.conversationId ? eq(memoryItems.scopeId, input.conversationId) : sql`false`,
            ),
            or(isNull(memoryItems.expiresAt), sql`expires_at > now()`),
            or(isNull(memoryItems.invalidAt), sql`invalid_at > now()`),
          ),
        )
        .orderBy(desc(memoryItems.updatedAt))
        .limit(limit),
    );
  }

  /** ACL grant helper — documents default to organization visibility at ingest. */
  async grantDocumentAccess(input: { orgId: string; documentId: string; visibility: 'organization' | 'private'; accountId?: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.documentId, 'documentId');
    if (input.visibility === 'private' && !input.accountId) {
      throw ApiError.validation({ account_id: 'private visibility requires an account scope' });
    }
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx
        .insert(retrievalAcl)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          resourceType: 'document',
          resourceId: input.documentId,
          visibility: input.visibility,
          scopeAccountId: input.visibility === 'private' ? input.accountId! : null,
        })
        .onConflictDoNothing();
    });
  }

  /** Rebuild-path helper: chunk metadata parity check after re-ingestion (exit gate). */
  static chunkFingerprint(text: string, sequence: number): string {
    return canonicalHash({ sequence, text });
  }
}
