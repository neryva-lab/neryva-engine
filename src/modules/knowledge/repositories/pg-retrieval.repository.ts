import { sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { buildSourceAclFilter } from '../retrieval.service';
import type { IRetrievalRepository } from './retrieval.repository';

/**
 * PostgreSQL implementation of `IRetrievalRepository` (P3).
 *
 * This port is DELIBERATELY THIN: it is a transaction shell around the
 * vector/FTS leg queries. The leg SQL template is the byte-identical shape
 * the service builds today (the canonical ACL filter builder is imported
 * from the service — it lives there with its unit test); the repository
 * executes all legs on ONE connection inside ONE tenant-scoped
 * (`DbService.withOrg`) transaction and hands the raw rows back. No
 * transaction handle leaks through this interface.
 *
 * What stays OUT (still the service's job):
 * - choosing the query variants and embedding them (vectors arrive as
 *   pre-computed SQL literals; the repository never embeds)
 * - the `hasVectorSignal` zero-vector skip (the service omits dead legs)
 * - RRF fusion, reranking, snippet assembly, tracing spans.
 */
export class PgRetrievalRepository implements IRetrievalRepository {
  constructor(private readonly db: DbService) {}

  async runRetrievalLegs(input: {
    orgId: string;
    vectorLegs: Array<{ vectorLiteral: string; pool: number; queryModel: string }>;
    ftsLegs: Array<{ variant: string; pool: number }>;
    versionIds: string[] | null;
    accountId: string | null;
    callerAccountId: string | null;
    callerEmails: string[];
  }): Promise<{
    vectorLegs: Array<Array<Record<string, unknown>>>;
    ftsLegs: Array<Array<Record<string, unknown>>>;
  }> {
    const orgId = input.orgId;
    const accountId = input.accountId ?? null;
    // E-1 pin filter and P0-1 source-ACL filter join the same WHERE —
    // authorization before scoring. Byte-identical shape across both legs
    // (the vector leg drives from `embeddings e`, the lexical leg from
    // `chunks c`, hence the two anchor aliases).
    const versionFilter =
      input.versionIds === null
        ? sql``
        : sql`and c.document_version_id in (${sql.join(
            input.versionIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
    const sourceAclFilter = buildSourceAclFilter({
      orgId,
      accountId: input.callerAccountId ?? accountId,
      emails: input.callerEmails ?? [],
    });
    const aclPredicate = (anchor: 'e' | 'c') => sql`
        left join retrieval_acl acl
          on acl.organization_id = d.organization_id
          and acl.resource_type = 'document'
          and acl.resource_id = d.id
        where ${sql.raw(anchor)}.organization_id = ${orgId}::uuid
          and d.state = 'ready'
          and a.state = 'active'
          and (a.scan_status in ('clean', 'skipped'))
          and (a.expires_at is null or a.expires_at > now())
          and (acl.visibility = 'organization' or (acl.visibility = 'private' and acl.scope_account_id = ${accountId}::uuid))
          ${versionFilter}
          ${sourceAclFilter}`;

    return this.db.withOrg(orgId, async (tx) => {
      const vectorLegs: Array<Array<Record<string, unknown>>> = [];
      for (const leg of input.vectorLegs) {
        const rows = await tx.execute(sql`
          select c.id as chunk_id, c.sequence, c.text, c.source_range,
                 dv.id as document_version_id, d.id as document_id, d.title as title,
                 1 - (e.embedding <=> ${leg.vectorLiteral}::vector) as score
          from embeddings e
          join chunks c on c.id = e.chunk_id
          join document_versions dv on dv.id = c.document_version_id
          join documents d on d.id = dv.document_id
          join artifacts a on a.id = d.source_artifact_id
          ${aclPredicate('e')}
          -- P0 (BUG-1): same vector space only. The model predicate joins the
          -- scoring WHERE (authorization-before-scoring posture extends to
          -- space-correctness: cross-model rows must never score).
          and e.model = ${leg.queryModel}
          order by e.embedding <=> ${leg.vectorLiteral}::vector
          limit ${leg.pool}
        `);
        vectorLegs.push(rows.rows as Array<Record<string, unknown>>);
      }

      const ftsLegs: Array<Array<Record<string, unknown>>> = [];
      for (const leg of input.ftsLegs) {
        const rows = await tx.execute(sql`
          select c.id as chunk_id, c.sequence, c.text, c.source_range,
                 dv.id as document_version_id, d.id as document_id, d.title as title,
                 ts_rank_cd(c.fts, websearch_to_tsquery('english', ${leg.variant})) as score
          from chunks c
          join document_versions dv on dv.id = c.document_version_id
          join documents d on d.id = dv.document_id
          join artifacts a on a.id = d.source_artifact_id
          ${aclPredicate('c')}
            and c.fts @@ websearch_to_tsquery('english', ${leg.variant})
          order by score desc
          limit ${leg.pool}
        `);
        ftsLegs.push(rows.rows as Array<Record<string, unknown>>);
      }

      return { vectorLegs, ftsLegs };
    });
  }
}
