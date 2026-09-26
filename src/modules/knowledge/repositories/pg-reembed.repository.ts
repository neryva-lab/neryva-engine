import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { documents, embeddings } from '../schema';
import type { IReEmbedRepository } from './reembed.repository';

/**
 * PostgreSQL implementation of `IReEmbedRepository` (P3).
 *
 * Mechanical move of the `ReEmbedWorker` SQL. Each method owns its
 * transaction; no transaction handle leaks.
 *
 * The embedding computation moves OUTSIDE the transaction (the worker
 * embeds between `listDocumentChunks` and `swapDocumentEmbeddings`) — the
 * old code embedded inside the swap TX. The per-document parity check
 * inside `swapDocumentEmbeddings` guards the read/swap split: if chunks
 * changed between the read and the swap, the parity mismatch throws
 * retryable and the document stays pending.
 *
 * What stays OUT (still the worker's job): computing the new vectors
 * (they arrive pre-computed; never network I/O here), choosing the
 * effective model per org (worker policy), the per-document try/catch
 * isolation.
 */
export class PgReEmbedRepository implements IReEmbedRepository {
  constructor(private readonly db: DbService) {}

  async listReadyOrgIds(limit: number): Promise<string[]> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`
        select distinct d.organization_id as org_id
        from documents d
        where d.state = 'ready'
        limit ${limit}
      `);
      return (rows.rows as Array<{ org_id: string }>).map((r) => String(r.org_id));
    });
  }

  async listPendingDocuments(
    orgId: string,
    effectiveModel: string,
    batch: number,
  ): Promise<Array<{ id: string }>> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, orgId),
            eq(documents.state, 'ready'),
            sql`(${documents.embeddingModel} is null or ${documents.embeddingModel} <> ${effectiveModel})`,
          ),
        )
        .limit(batch),
    );
  }

  async listDocumentChunks(
    orgId: string,
    documentId: string,
  ): Promise<Array<{ chunkId: string; text: string }>> {
    return this.db.withOrg(orgId, async (tx) => {
      const chunkRows = await tx.execute(sql`
        select c.id as chunk_id, c.text as text
        from chunks c
        join document_versions dv on dv.id = c.document_version_id
        join documents d on d.id = dv.document_id
        where d.id = ${documentId}::uuid
        order by c.sequence
      `);
      return (chunkRows.rows as Array<{ chunk_id: string; text: string }>).map((r) => ({
        chunkId: String(r.chunk_id),
        text: String(r.text),
      }));
    });
  }

  async swapDocumentEmbeddings(input: {
    orgId: string;
    documentId: string;
    targetModel: string;
    vectors: Array<{ chunkId: string; vector: number[] }>;
    at: Date;
  }): Promise<{ chunks: number; staleModelsSwept: number }> {
    const atIso = input.at.toISOString();
    return this.db.withOrg(input.orgId, async (tx) => {
      // 1. Insert the target-model embedding rows (vectors are PRE-COMPUTED).
      // uq_embeddings_chunk makes the re-inserts idempotent on retry.
      for (const v of input.vectors) {
        await tx
          .insert(embeddings)
          .values({
            id: uuidv7(),
            chunkId: v.chunkId,
            organizationId: input.orgId,
            model: input.targetModel,
            embedding: v.vector,
          })
          .onConflictDoNothing();
      }

      if (input.vectors.length > 0) {
        // 2. Parity count check — the inserted row count must equal the
        // chunk count; mismatch throws (retryable) so a half-swapped
        // document can never publish.
        const parity = await tx.execute(sql`
          select count(c.id)::int as total,
                 count(e.id)::int as embedded
          from chunks c
          join document_versions dv on dv.id = c.document_version_id
          left join embeddings e on e.chunk_id = c.id and e.model = ${input.targetModel}
          where dv.document_id = ${input.documentId}::uuid
        `);
        const parityRow = (parity.rows as Array<{ total: number; embedded: number }>)[0];
        const total = Number(parityRow?.total ?? 0);
        const embedded = Number(parityRow?.embedded ?? 0);
        if (embedded !== total) {
          throw new Error(
            `re-embed parity failed for document ${input.documentId} on ${input.targetModel} (${embedded}/${total} chunks) — retrying next tick`,
          );
        }
      }

      // 3. Flip documents.embeddingModel to the target model.
      await tx
        .update(documents)
        .set({ embeddingModel: input.targetModel, updatedAt: atIso })
        .where(eq(documents.id, input.documentId));

      // 4. Sweep stale-model embedding rows for the document.
      const oldModels = await tx.execute(sql`
        select distinct e.model as model
        from embeddings e
        join chunks c on c.id = e.chunk_id
        join document_versions dv on dv.id = c.document_version_id
        where dv.document_id = ${input.documentId}::uuid and e.model <> ${input.targetModel}
      `);
      const stale = (oldModels.rows as Array<{ model: string }>).map((r) => String(r.model));
      if (stale.length > 0) {
        await tx.execute(sql`
          delete from embeddings e
          using chunks c, document_versions dv
          where e.chunk_id = c.id
            and c.document_version_id = dv.id
            and dv.document_id = ${input.documentId}::uuid
            and e.model in (${sql.join(
              stale.map((m) => sql`${m}`),
              sql`, `,
            )})
        `);
      }
      // staleModelsSwept is the distinct stale-model count (matches the
      // worker's log line); the DELETE itself sweeps all rows of those
      // models.
      return { chunks: input.vectors.length, staleModelsSwept: stale.length };
    });
  }
}
