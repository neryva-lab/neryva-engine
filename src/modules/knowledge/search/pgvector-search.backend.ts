import { sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { buildSourceAclFilter } from '../retrieval.service';
import type {
  ISearchBackend,
  SearchBackendKind,
  SearchVector,
  VectorHit,
  VectorLegQuery,
} from './search-backend';

/**
 * pgvector search backend (P4).
 *
 * MECHANICAL EXTRACTION of the current vector-leg behavior: `runVectorLeg`
 * executes the byte-identical leg SQL that `PgRetrievalRepository` runs
 * today — same joins, same authorization-before-scoring predicates
 * (tenant, ready document, live artifact, retrieval-ACL visibility,
 * source-ACL principals, version pins, model-space scoping), same
 * `1 - (embedding <=> query)` cosine-similarity scoring, same ordering.
 * The only transformation is projecting the full leg rows down to the
 * port's `{chunkId, score}` shape; hydration stays the repository's job.
 *
 * Index maintenance (`upsertVectors` / `deleteVectorsForChunks`) is a
 * documented no-op: the `embeddings` table IS the vector index (writes go
 * through the ingestion / re-embed repositories; postgres maintains the
 * table's indexes itself).
 */
export class PgVectorSearchBackend implements ISearchBackend {
  readonly backendKind: SearchBackendKind = 'pgvector';
  readonly requiresSidecarSync = false;

  constructor(private readonly db: DbService) {}

  async upsertVectors(_input: {
    orgId: string;
    model: string;
    vectors: SearchVector[];
  }): Promise<void> {
    // No-op: the embeddings table is the index.
  }

  async deleteVectorsForChunks(_input: {
    orgId: string;
    chunkIds: string[];
    model?: string;
  }): Promise<void> {
    // No-op: the embeddings table is the index.
  }

  async runVectorLeg(query: VectorLegQuery): Promise<VectorHit[]> {
    if (query.vector.length === 0) {
      throw new Error('runVectorLeg: vector must be non-empty');
    }
    if (query.topK <= 0) {
      return [];
    }
    const orgId = query.orgId;
    const accountId = query.accountId ?? null;
    const vectorLiteral = `[${query.vector.join(',')}]`;
    // E-1 pin filter and P0-1 source-ACL filter join the same WHERE —
    // authorization before scoring. Identical shape to the leg SQL in
    // PgRetrievalRepository (the extraction source).
    const versionFilter =
      query.versionIds === null
        ? sql``
        : sql`and c.document_version_id in (${sql.join(
            query.versionIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
    const sourceAclFilter = buildSourceAclFilter({
      orgId,
      accountId: query.callerAccountId ?? accountId,
      emails: query.callerEmails ?? [],
    });
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select c.id as chunk_id,
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
        where e.organization_id = ${orgId}::uuid
          and d.state = 'ready'
          and a.state = 'active'
          and (a.scan_status in ('clean', 'skipped'))
          and (a.expires_at is null or a.expires_at > now())
          and (acl.visibility = 'organization' or (acl.visibility = 'private' and acl.scope_account_id = ${accountId}::uuid))
          ${versionFilter}
          ${sourceAclFilter}
          -- P0 (BUG-1): same vector space only — cross-model rows must
          -- never score.
          and e.model = ${query.model}
        order by e.embedding <=> ${vectorLiteral}::vector
        limit ${query.topK}
      `);
      return (rows.rows as Array<{ chunk_id: string; score: number }>).map((r) => ({
        chunkId: String(r.chunk_id),
        score: Number(r.score),
      }));
    });
  }
}
