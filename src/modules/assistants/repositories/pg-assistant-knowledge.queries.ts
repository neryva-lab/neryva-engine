/**
 * PostgreSQL `IAssistantKnowledgeQueries` — the assistants module's
 * read-only view over knowledge-domain tables.
 *
 * Every query is verbatim from the pre-extraction `AssistantsService`
 * (same predicates, same SQL, same `withOrg` boundary). No writes, no
 * transactions beyond the caller's read — these back operate-view reads,
 * never the publish commit.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { documents } from '../../knowledge/schema';
import { evalDatasets, evalRuns } from '../../knowledge/eval.schema';
import type {
  ChunkEmbeddingStats,
  IAssistantKnowledgeQueries,
  LatestEvalDecision,
} from './assistant-knowledge.queries';

@Injectable()
export class PgAssistantKnowledgeQueries implements IAssistantKnowledgeQueries {
  constructor(private readonly db: DbService) {}

  async getDocumentStates(orgId: string, documentIds: string[]): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    if (documentIds.length === 0) {
      return states;
    }
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: documents.id, state: documents.state })
        .from(documents)
        .where(inArray(documents.id, documentIds)),
    );
    for (const r of rows) {
      states.set(r.id, r.state);
    }
    return states;
  }

  async getChunkEmbeddingStats(
    orgId: string,
    pairs: Array<{ versionId: string; model: string }>,
  ): Promise<Map<string, ChunkEmbeddingStats>> {
    const byVersion = new Map<string, ChunkEmbeddingStats>();
    if (pairs.length === 0) {
      return byVersion;
    }
    // Per-(version, model) pairs: a version carrying stale rows of ANOTHER
    // model (pre-sweep migration residue) must not inflate its own count.
    // The VALUES join binds each pinned version to exactly its pin's model.
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute(sql`
        select c.document_version_id as version_id,
               count(c.id)::int as total,
               count(e.id)::int as embedded
        from chunks c
        join (values ${sql.join(
          pairs.map((pair) => sql`(${pair.versionId}::uuid, ${pair.model})`),
          sql`, `,
        )}) as want(version_id, model) on want.version_id = c.document_version_id
        left join embeddings e on e.chunk_id = c.id and e.model = want.model
        where c.organization_id = ${orgId}::uuid
        group by c.document_version_id
      `),
    );
    for (const r of rows.rows as Array<{ version_id: string; total: number; embedded: number }>) {
      byVersion.set(r.version_id, { total: Number(r.total), embedded: Number(r.embedded) });
    }
    return byVersion;
  }

  async getLatestEvalDecision(
    orgId: string,
    versionId: string,
  ): Promise<LatestEvalDecision | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          decision: evalRuns.decision,
          score: evalRuns.score,
          finishedAt: evalRuns.finishedAt,
        })
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.organizationId, orgId),
            eq(evalRuns.assistantVersionId, versionId),
            eq(evalRuns.state, 'completed'),
            // P5: the version verdict is the FORMAL decision — shadow
            // observations surface via drift alerts, never here.
            eq(evalRuns.isShadow, false),
          ),
        )
        .orderBy(desc(evalRuns.finishedAt))
        .limit(1),
    );
    const last = rows[0];
    return last?.decision
      ? { decision: last.decision, score: last.score, finished_at: last.finishedAt }
      : null;
  }

  async findEvalDatasetId(orgId: string, name: string): Promise<string | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: evalDatasets.id })
        .from(evalDatasets)
        .where(and(eq(evalDatasets.organizationId, orgId), eq(evalDatasets.name, name)))
        .limit(1),
    );
    return rows[0]?.id ?? null;
  }
}
