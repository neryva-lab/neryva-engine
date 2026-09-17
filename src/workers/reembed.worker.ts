import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { env } from '../common/config/env';
import { documents, embeddings } from '../modules/knowledge/schema';
import { EmbeddingService } from '../modules/knowledge/embedding.service';
import { ConfigPublishService } from '../modules/config-publish/config-publish.service';
import { uuidv7 } from '../common/ids/uuidv7';

/**
 * Re-embed worker (FL-2.2) — resumable, batched re-indexing when an org's
 * configured embedding model changes (FL-2.3 `knowledge_config`).
 *
 * Resumability: `documents.embedding_model` IS the cursor. A document whose
 * active vectors were computed with a model different from the org's
 * configured model is re-embedded; the swap is ATOMIC PER DOCUMENT — new
 * embeddings insert and the document's model pointer flips in one
 * transaction, so a crash mid-batch leaves every document either fully on
 * the old model or fully on the new one. Zero-downtime reads: old-model
 * rows are kept until the new-model rows for the same document are in, then
 * swept in the same TX as the pointer flip.
 */
@Injectable()
export class ReEmbedWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(ReEmbedWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DbService,
    private readonly embedding: EmbeddingService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  onModuleInit(): void {
    if (!env.WORKERS__REEMBED_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    ReEmbedWorker.logger.log('re-embed worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const orgs = await this.db.withBypass(async (tx) => {
        const rows = await tx.execute(sql`
          select distinct d.organization_id as org_id
          from documents d
          where d.state = 'ready'
          limit 500
        `);
        return (rows.rows as Array<{ org_id: string }>).map((r) => r.org_id);
      });
      for (const orgId of orgs) {
        await this.reembedOrg(orgId);
      }
    } catch (err) {
      ReEmbedWorker.logger.warn(`re-embed tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reembedOrg(orgId: string): Promise<void> {
    const config = await this.configPublish.latest(orgId, 'knowledge_config', null);
    if (!config) {
      // Org has not opted into a specific model: NULL stays legacy and the
      // legacy vectors remain authoritative — no forced re-index.
      return;
    }
    const configured = String((config.payload as { embedding_model?: string }).embedding_model ?? '');
    const effective = configured || this.embedding.model;

    const pending = await this.db.withOrg(orgId, async (tx) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.organizationId, orgId),
            eq(documents.state, 'ready'),
            sql`(${documents.embeddingModel} is null or ${documents.embeddingModel} <> ${effective})`,
          ),
        )
        .limit(env.WORKERS__REEMBED_BATCH),
    );

    for (const doc of pending) {
      // P0: per-document isolation — a parity failure (or any transient) on
      // one document must not starve its siblings until the next tick. The
      // document stays pending (pointer unflipped) and converges on retry.
      try {
        await this.reembedDocument(orgId, doc.id, effective);
      } catch (err) {
        ReEmbedWorker.logger.warn(`re-embed of document ${doc.id} deferred: ${(err as Error).message}`);
      }
    }
  }

  /** Atomic per-document swap: new vectors in, old sweep + pointer flip in one TX. */
  private async reembedDocument(orgId: string, documentId: string, targetModel: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      const chunkRows = await tx.execute(sql`
        select c.id as chunk_id, c.text as text
        from chunks c
        join document_versions dv on dv.id = c.document_version_id
        join documents d on d.id = dv.document_id
        where d.id = ${documentId}::uuid
        order by c.sequence
      `);
      const rows = chunkRows.rows as Array<{ chunk_id: string; text: string }>;
      if (rows.length === 0) {
        await tx
          .update(documents)
          .set({ embeddingModel: targetModel, updatedAt: new Date().toISOString() })
          .where(eq(documents.id, documentId));
        return;
      }
      const vectors = await this.embedding.embed(rows.map((r) => r.text));
      for (let i = 0; i < rows.length; i++) {
        const chunk = rows[i];
        const vec = vectors[i];
        if (!chunk || !vec) {
          continue;
        }
        await tx
          .insert(embeddings)
          .values({
            id: uuidv7(),
            chunkId: chunk.chunk_id,
            organizationId: orgId,
            model: targetModel,
            embedding: vec,
          })
          .onConflictDoNothing();
      }
      // P0 (GAP-1) — chunk-count parity BEFORE the pointer flip: every chunk
      // of the document must carry a target-model row, or the flip would mark
      // a partially-indexed document complete (and the publish coverage gate
      // would refuse on it forever until the next tick). Mismatch throws
      // retryable — the document stays pending and converges next tick
      // (uq_embeddings_chunk makes the re-inserts idempotent).
      const parity = await tx.execute(sql`
        select count(c.id)::int as total,
               count(e.id)::int as embedded
        from chunks c
        join document_versions dv on dv.id = c.document_version_id
        left join embeddings e on e.chunk_id = c.id and e.model = ${targetModel}
        where dv.document_id = ${documentId}::uuid
      `);
      const parityRow = (parity.rows as Array<{ total: number; embedded: number }>)[0];
      const total = Number(parityRow?.total ?? 0);
      const embedded = Number(parityRow?.embedded ?? 0);
      if (embedded !== total) {
        throw new Error(`re-embed parity failed for document ${documentId} on ${targetModel} (${embedded}/${total} chunks) — retrying next tick`);
      }
      // Pointer flip + old-model cleanup — one TX with the inserts above.
      await tx
        .update(documents)
        .set({ embeddingModel: targetModel, updatedAt: new Date().toISOString() })
        .where(eq(documents.id, documentId));
      const oldModels = await tx.execute(sql`
        select distinct e.model as model
        from embeddings e
        join chunks c on c.id = e.chunk_id
        join document_versions dv on dv.id = c.document_version_id
        where dv.document_id = ${documentId}::uuid and e.model <> ${targetModel}
      `);
      const stale = (oldModels.rows as Array<{ model: string }>).map((r) => r.model);
      if (stale.length > 0) {
        await tx.execute(sql`
          delete from embeddings e
          using chunks c, document_versions dv
          where e.chunk_id = c.id
            and c.document_version_id = dv.id
            and dv.document_id = ${documentId}::uuid
            and e.model in (${sql.join(
              stale.map((m) => sql`${m}`),
              sql`, `,
            )})
        `);
      }
      ReEmbedWorker.logger.log(`document ${documentId} re-embedded on ${targetModel} (${rows.length} chunks, ${stale.length} stale model(s) swept)`);
    });
  }
}
