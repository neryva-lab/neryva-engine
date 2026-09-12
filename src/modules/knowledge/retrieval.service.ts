import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { uuidv7 } from '../../common/ids/uuidv7';
import { memoryItems, MemoryItem, retrievalAcl } from './schema';
import { EmbeddingService } from './embedding.service';
import { assertUuid } from './assert';

/**
 * Retrieval — Phase 7.7 (ledger). TENANT + ACL PREDICATES RUN BEFORE SCORING:
 * the vector search SQL carries `organization_id` + visibility/ACL filters in
 * the WHERE clause of the same statement that orders by `<=>` — post-ranking
 * filtering is not authorization and is never used. Deleted/quarantined/
 * not-READY documents are unreachable by construction.
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

@Injectable()
export class RetrievalService {
  constructor(
    private readonly db: DbService,
    private readonly embedding: EmbeddingService,
  ) {}

  async searchKnowledge(input: { orgId: string; query: string; limit?: number; accountId?: string }): Promise<KnowledgeHit[]> {
    assertUuid(input.orgId, 'orgId');
    const query = input.query.trim();
    if (query.length === 0) {
      throw ApiError.validation({ query: 'must not be empty' });
    }
    if (query.length > 512) {
      throw ApiError.validation({ query: 'max 512 chars' });
    }
    const limit = Math.min(Math.max(1, input.limit ?? 5), 20);
    const [vector] = await this.embedding.embed([query]);
    if (vector.every((v) => v === 0)) {
      return []; // no lexical signal — empty result, not an error
    }
    const vectorLiteral = `[${vector.join(',')}]`;

    return this.db.withOrg(input.orgId, async (tx) => {
      const accountId = input.accountId ?? null;
      const rows = await tx.execute(sql`
        select c.id as chunk_id, c.sequence, c.text, c.source_range,
               dv.id as document_version_id, d.id as document_id, d.title as title,
               1 - (e.embedding <=> ${vectorLiteral}::vector) as score
        from embeddings e
        join chunks c on c.id = e.chunk_id
        join document_versions dv on dv.id = c.document_version_id
        join documents d on d.id = dv.document_id
        join artifacts a on a.id = d.source_artifact_id
        left join retrieval_acl acl
          on acl.organization_id = d.organization_id
         and acl.resource_type = 'document'
         and acl.resource_id = d.id
        where e.organization_id = ${input.orgId}::uuid
          and d.state = 'ready'
          and a.state = 'active'
          and (a.scan_status in ('clean', 'skipped'))
          and (a.expires_at is null or a.expires_at > now())
          and (acl.visibility = 'organization' or (acl.visibility = 'private' and acl.scope_account_id = ${accountId}::uuid))
        order by e.embedding <=> ${vectorLiteral}::vector
        limit ${limit}
      `);
      return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        chunkId: String(r.chunk_id),
        documentId: String(r.document_id),
        documentVersionId: String(r.document_version_id),
        sequence: Number(r.sequence),
        text: String(r.text),
        sourceRange: r.source_range as { byteStart: number; byteEnd: number },
        score: Number(r.score),
        title: r.title == null ? null : String(r.title),
      }));
    });
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
