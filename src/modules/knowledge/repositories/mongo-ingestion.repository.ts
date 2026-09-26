/**
 * MongoDB implementation of the ingestion repository port (P3) — the whole
 * INDEXING stage in ONE unit of work, per the interface contract.
 *
 * Transaction design (the 11000 claim-loss rule): a Mongo duplicate key
 * aborts the multi-document transaction, so NO duplicate-error
 * catch-and-continue happens inside `withOrg`. Instead every
 * insert-or-read-back is an atomic single-document upsert
 * (`findOneAndUpdate` + `$setOnInsert`), which never raises 11000 on its
 * own key:
 * - the document row dedupe by `source_artifact_id` → atomic upsert
 *   (mirrors `onConflictDoNothing` + read-back);
 * - the `connector_documents` mapping → atomic upsert (first-write-wins);
 * - the version row → two uniques, two convergence paths (0026:
 *   `uq_document_versions` on `(document_id, sha256, parser_version)`;
 *   0072: `uq_document_versions_doc_version` on `(document_id, version)`):
 *   a content pre-check converges identical content onto the existing
 *   row (rebuild its chunks, never duplicate); fresh content mints
 *   `max(version)+1` via atomic upsert on `(document_id, version)` —
 *   the upsert winner's `sha256`/`parser_version` tell whether we won the
 *   number (match → our row) or lost it to different content (mismatch →
 *   read back by content: found → rebuild that row; not found → fail the
 *   stage, mirroring the pg lane's crash on the same race).
 *
 * The only duplicate that can escape the transaction is the
 * `uq_documents_org_slug` unique on `(organization_id, source_slug)`; the
 * retry wrapper maps it (after the abort) to the same
 * `source_slug '…' is already taken` error the pg lane throws. A slug
 * pre-check before the transaction keeps the common case clean.
 *
 * Version-number races: mongo has no `SELECT … FOR UPDATE`. The unique
 * index on `(document_id, version)` plus the bounded whole-stage retry
 * converges concurrent minters the way the pg row lock serializes them.
 *
 * Embeddings: the pg lane relies on FK cascade when chunks are deleted
 * for an identical-content rebuild; mongo deletes the version's embeddings
 * explicitly before re-inserting.
 */
import { MongoServerError } from 'mongodb';
import type { Db } from 'mongodb';
import { Logger } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  ChunkMongoDoc,
  ConnectorDocumentMongoDoc,
  DocumentMongoDoc,
  DocumentVersionMongoDoc,
  EmbeddingMongoDoc,
  UploadSessionMongoDoc,
} from './mongo-documents';
import type { IIngestionRepository } from './ingestion.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  sessionOf,
  toIso,
} from './mongo-knowledge-shared';
import { Binary } from 'mongodb';

const DOCUMENTS = 'documents';
const VERSIONS = 'document_versions';
const CHUNKS = 'chunks';
const EMBEDDINGS = 'embeddings';
const SESSIONS = 'upload_sessions';
const CONNECTOR_DOCS = 'connector_documents';

const SLUG_INDEX = 'uq_documents_org_slug';
const MAX_STAGE_ATTEMPTS = 4;

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

function duplicateIndexName(err: unknown): string | null {
  if (!isDuplicateKey(err)) return null;
  const keyPattern = (err as { keyPattern?: Record<string, number> }).keyPattern;
  if (keyPattern) {
    const hit = Object.keys(keyPattern).join('_');
    if (hit) return hit;
  }
  const message = (err as Error).message ?? '';
  const m = /index:\s+(\S+)/.exec(message);
  return m ? m[1] : null;
}

function shaEqual(a: Binary, b: Uint8Array): boolean {
  const ab = a.buffer;
  if (ab.length !== b.length) return false;
  for (let i = 0; i < ab.length; i += 1) {
    if (ab[i] !== b[i]) return false;
  }
  return true;
}

/** Binary equality without relying on driver-version-specific helpers. */
function binaryEqual(a: Binary, b: Binary): boolean {
  return shaEqual(a, b.buffer);
}

type IndexInput = Parameters<IIngestionRepository['indexDocumentVersion']>[0];
type IndexResult = { documentId: string; versionId: string; version: number };

import type { ISearchBackend } from '../search/search-backend';
import { drainSearchIndexOutbox, writeSearchIndexIntents } from '../search/search-index-outbox';

export class MongoIngestionRepository implements IIngestionRepository {
  private static readonly logger = new Logger(MongoIngestionRepository.name);

  constructor(
    private readonly mongo: MongoDbService,
    private readonly backend: ISearchBackend,
  ) {}

  async indexDocumentVersion(input: IndexInput): Promise<IndexResult> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    const orgId = input.orgId;

    // Pre-check the slug so the common conflict surfaces as the pg lane's
    // clean error without entering the transaction at all.
    if (!input.targetDocumentId) {
      const clash = await new TenantScopedCollection<DocumentMongoDoc>(
        db.collection(DOCUMENTS),
      ).findOne(orgId, { source_slug: input.sourceSlug });
      if (clash && !binaryEqual(clash.source_artifact_id, binUuid(input.artifactId, 'artifactId'))) {
        throw new Error(`source_slug '${input.sourceSlug}' is already taken in this organization`);
      }
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_STAGE_ATTEMPTS; attempt += 1) {
      try {
        const staged = await this.mongo.withOrg(orgId, (ctx) =>
          this.indexOnce(db, ctx, input),
        );
        // Post-commit search-index sync (P4): drain the outbox intents
        // written in the transaction above — the fast path so new vectors
        // are searchable immediately when the sidecar is healthy. Best
        // effort: a failure is logged and the SearchIndexSyncWorker replays
        // the stranded intents with backoff. Never fails the durable write.
        if (this.backend.requiresSidecarSync) {
          try {
            await drainSearchIndexOutbox(this.mongo, this.backend, { orgId });
          } catch (syncErr) {
            MongoIngestionRepository.logger.warn(
              `search index sync deferred after indexing ${staged.documentId}: ${(syncErr as Error).message}`,
            );
          }
        }
        return {
          documentId: staged.documentId,
          versionId: staged.versionId,
          version: staged.version,
        };
      } catch (err) {
        if (isDuplicateKey(err)) {
          const indexName = duplicateIndexName(err) ?? '';
          if (indexName.includes('source_slug') || indexName.includes(SLUG_INDEX)) {
            throw new Error(
              `source_slug '${input.sourceSlug}' is already taken in this organization`,
            );
          }
          // Any other duplicate — e.g. a (document_id, sha256,
          // parser_version) write conflict that surfaced at commit because a
          // concurrent attempt versioned the same content first — is a
          // serialization race: retry the stage so the content pre-check
          // converges on the winner's row.
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`indexing stage failed after ${MAX_STAGE_ATTEMPTS} attempts`);
  }

  /** One attempt at the whole stage, inside a single transaction. */
  private async indexOnce(
    db: Db,
    ctx: MongoTxContext,
    input: IndexInput,
  ): Promise<
    IndexResult & { deletedChunkIds: string[]; vectors: Array<{ chunkId: string; vector: number[] }> }
  > {
    const orgId = input.orgId;
    const now = toIso(input.at);
    const s = sessionOf(ctx);
    const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
    const versions = new TenantScopedCollection<DocumentVersionMongoDoc>(db.collection(VERSIONS));
    const chunks = new TenantScopedCollection<ChunkMongoDoc>(db.collection(CHUNKS));
    const embeddings = new TenantScopedCollection<EmbeddingMongoDoc>(db.collection(EMBEDDINGS));
    const sessions = new TenantScopedCollection<UploadSessionMongoDoc>(db.collection(SESSIONS));
    const connectorDocs = new TenantScopedCollection<ConnectorDocumentMongoDoc>(
      db.collection(CONNECTOR_DOCS),
    );
    const orgBin = binUuid(orgId, 'orgId');
    const shaBinary = new Binary(Buffer.from(input.contentSha256), 0);

    // 1. Document row: FOR UPDATE on the re-ingest target (existence check;
    //    mongo has no row lock — the version retry converges racers), or
    //    atomic dedupe upsert by source_artifact_id.
    let documentId: string;
    if (input.targetDocumentId) {
      const target = await documents.findOne(
        orgId,
        { id: binUuid(input.targetDocumentId, 'targetDocumentId') },
        s,
      );
      if (!target) {
        throw new Error('re-ingestion target document is gone (deleted or foreign org)');
      }
      documentId = input.targetDocumentId;
    } else {
      const artifactBin = binUuid(input.artifactId, 'artifactId');
      const doc = await documents.findOneAndUpdate(
        orgId,
        { source_artifact_id: artifactBin },
        {
          $setOnInsert: {
            id: binUuid(newId()),
            organization_id: orgBin,
            source_artifact_id: artifactBin,
            title: input.title,
            state: 'processing',
            source_slug: input.sourceSlug,
            embedding_model: null,
            created_at: now,
            updated_at: now,
          },
        },
        { ...s, upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new Error('mongo repository: document dedupe upsert returned no document');
      documentId = doc.id.toUUID().toString();
    }
    const documentBin = binUuid(documentId, 'documentId');

    // 2. Connector provenance mapping: atomic upsert, first-write-wins.
    if (input.connectorRef) {
      const ref = input.connectorRef;
      await connectorDocs.findOneAndUpdate(
        orgId,
        {
          connector_account_id: binUuid(ref.accountId, 'connectorRef.accountId'),
          external_id: ref.externalId,
        },
        {
          $setOnInsert: {
            id: binUuid(newId()),
            organization_id: orgBin,
            connector_account_id: binUuid(ref.accountId, 'connectorRef.accountId'),
            external_id: ref.externalId,
            document_id: documentBin,
            created_at: now,
          },
        },
        { ...s, upsert: true, returnDocument: 'after' },
      );
    }

    // 3. Version resolution. The DB carries TWO uniques here
    //    (0026: uq_document_versions on (document_id, sha256,
    //    parser_version); 0072: uq_document_versions_doc_version on
    //    (document_id, version)), and the pg lane's bare
    //    onConflictDoNothing + read-back by (documentId, sha256,
    //    parserVersion) converges on whichever row wins:
    //    a. Identical content already versioned → converge on that row and
    //       rebuild its chunks (delete + reinsert), never duplicate.
    //    b. Fresh content → mint max(version)+1 via atomic upsert on
    //       (document_id, version). The upsert winner's sha256/parser_version
    //       tells whether we won the number (match → our row) or lost it to
    //       different content (mismatch → read back by content: found →
    //       rebuild that row; not found → throw, mirroring the pg lane's
    //       crash on the same race).
    //    The content pre-check avoids the commit-time 11000 the blind
    //    insert would hit when a concurrent attempt already versioned this
    //    exact content; a missed race still aborts the tx and the outer
    //    wrapper retries the stage, at which point the pre-check converges.
    const existingContent = await versions.findOne(
      orgId,
      { document_id: documentBin, sha256: shaBinary, parser_version: input.parserVersion },
      s,
    );
    let versionId: string;
    let version: number;
    if (existingContent) {
      versionId = existingContent.id.toUUID().toString();
      version = existingContent.version;
    } else {
      const latest = await versions
        .find(orgId, { document_id: documentBin }, { ...s, sort: { version: -1 }, limit: 1 })
        .toArray();
      const next = (latest[0]?.version ?? 0) + 1;
      const winner = await versions.findOneAndUpdate(
        orgId,
        { document_id: documentBin, version: next },
        {
          $setOnInsert: {
            id: binUuid(newId()),
            organization_id: orgBin,
            document_id: documentBin,
            version: next,
            sha256: shaBinary,
            parser_version: input.parserVersion,
            created_at: now,
          },
        },
        { ...s, upsert: true, returnDocument: 'after' },
      );
      if (!winner) throw new Error('mongo repository: version upsert returned no document');
      if (
        winner.parser_version === input.parserVersion &&
        shaEqual(winner.sha256, input.contentSha256)
      ) {
        versionId = winner.id.toUUID().toString();
        version = next;
      } else {
        // Lost the version number to different content — the pg lane's
        // read-back by content decides: rebuild the identical-content row
        // when it exists, otherwise fail the stage (its TypeError crash).
        const identical = await versions.findOne(
          orgId,
          { document_id: documentBin, sha256: shaBinary, parser_version: input.parserVersion },
          s,
        );
        if (!identical) {
          throw new Error(
            `document version number collision with different content for document ${documentId}`,
          );
        }
        versionId = identical.id.toUUID().toString();
        version = identical.version;
      }
    }
    const versionBin = binUuid(versionId, 'versionId');

    // 4. Chunk rebuild: delete the version's chunks AND their embeddings
    //    (pg relies on FK cascade here), then insert the fresh set.
    const oldChunks = await chunks
      .find(orgId, { document_version_id: versionBin }, { ...s, projection: { id: 1 } })
      .toArray();
    if (oldChunks.length > 0) {
      await embeddings.deleteMany(
        orgId,
        { chunk_id: { $in: oldChunks.map((c) => c.id) } },
        s,
      );
      await chunks.deleteMany(orgId, { document_version_id: versionBin }, s);
    }

    const chunkDocs: ChunkMongoDoc[] = input.chunks.map((c) => ({
      id: binUuid(newId()),
      document_version_id: versionBin,
      organization_id: orgBin,
      sequence: c.sequence,
      source_range: { byteStart: c.byteStart, byteEnd: c.byteEnd },
      chunk_hash: c.chunkHash,
      text: c.text,
    }));
    if (chunkDocs.length > 0) {
      await chunks.insertMany(orgId, chunkDocs, s);
    }
    const embeddingDocs: EmbeddingMongoDoc[] = input.chunks.map((c, i) => ({
      id: binUuid(newId()),
      chunk_id: chunkDocs[i].id,
      organization_id: orgBin,
      model: input.embeddingModel,
      embedding: c.vector,
    }));
    if (embeddingDocs.length > 0) {
      await embeddings.insertMany(orgId, embeddingDocs, s);
    }

    // 4b. Search-index outbox (P4): when the resolved backend keeps a sidecar
    // vector index (Qdrant), record durable sync intents in the SAME
    // transaction as the canonical writes — crash-safe by construction, and
    // the canonical transaction's atomicity is untouched (one extra insert
    // in the same TX). No-op for backends that index the canonical store.
    const deletedChunkIdStrings = oldChunks.map((c) => c.id.toUUID().toString());
    if (this.backend.requiresSidecarSync) {
      await writeSearchIndexIntents(db, s, {
        orgId,
        upserts:
          embeddingDocs.length > 0
            ? [
                {
                  model: input.embeddingModel,
                  chunkIds: embeddingDocs.map((d) => d.chunk_id.toUUID().toString()),
                },
              ]
            : [],
        // Re-chunk deletes every model row for the old chunks (the deleteMany
        // above has no model filter) → model: null = all models.
        deletes: deletedChunkIdStrings.length > 0 ? [{ model: null, chunkIds: deletedChunkIdStrings }] : [],
      });
    }

    // 5. Session → INDEXING.
    await sessions.updateOne(
      orgId,
      { id: binUuid(input.sessionId, 'sessionId') },
      { $set: { state: 'INDEXING', updated_at: now } },
      s,
    );

    return {
      documentId,
      versionId,
      version,
      deletedChunkIds: deletedChunkIdStrings,
      vectors: input.chunks.map((c, i) => ({
        chunkId: chunkDocs[i].id.toUUID().toString(),
        vector: c.vector,
      })),
    };
  }
}
