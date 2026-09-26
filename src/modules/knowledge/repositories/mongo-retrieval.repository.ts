/**
 * MongoDB implementation of the retrieval repository port (P3).
 *
 * Deliberately thin transaction shell: all legs run inside ONE
 * `mongo.withOrg` transaction with explicit `organization_id` predicates
 * (plan D6). The legs are implemented natively — exact cosine scoring for
 * vector legs (pgvector `<=>` is cosine distance) and MongoDB `$text`
 * (english) for the FTS legs — under the same authorization-before-scoring
 * gates the service's leg SQL applies: tenant, ready document, active +
 * clean/skipped + unexpired artifact, retrieval-ACL visibility, source-ACL
 * principals, version restriction, model-scoped vectors.
 *
 * Interface note: `ftsLegs[].variant` is documented as "the tsvector
 * configuration name", but the pg implementation passes it as the QUERY
 * TEXT to `websearch_to_tsquery('english', variant)` (the config is
 * hardcoded). This implementation follows the pg behavior — `variant` is
 * the query text — and reports the stale doc line rather than inventing
 * config-name semantics.
 *
 * Known divergence: `$text` ORs unquoted query terms while
 * `websearch_to_tsquery` ANDs them (see `ftsLeg`), and `$meta:
 * 'textScore'` is not `ts_rank_cd`. Rank order is what the service's RRF
 * fusion consumes, but candidate sets can differ from the pg lane.
 */
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { ISearchBackend } from '../search/search-backend';
import type {
  ArtifactMongoDoc,
  ChunkMongoDoc,
  DocumentMongoDoc,
  DocumentSourceAclMongoDoc,
  DocumentVersionMongoDoc,
  ExternalIdentityLinkMongoDoc,
  ExternalPrincipalMongoDoc,
  RetrievalAclMongoDoc,
} from './mongo-documents';
import type { IRetrievalRepository } from './retrieval.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  sessionOf,
} from './mongo-knowledge-shared';
import type { Db, Document } from 'mongodb';

const DOCUMENTS = 'documents';
const VERSIONS = 'document_versions';
const CHUNKS = 'chunks';
const ARTIFACTS = 'artifacts';
const RETRIEVAL_ACL = 'retrieval_acl';
const SOURCE_ACLS = 'document_source_acls';
const PRINCIPALS = 'external_principals';
const IDENTITY_LINKS = 'external_identity_links';

type LegInput = {
  orgId: string;
  vectorLegs: Array<{ vectorLiteral: string; pool: number; queryModel: string }>;
  ftsLegs: Array<{ variant: string; pool: number }>;
  versionIds: string[] | null;
  accountId: string | null;
  callerAccountId: string | null;
  callerEmails: string[];
};

type LegRow = Record<string, unknown>;

/** Parse a pg `vector` SQL literal (`'[1,2,3]'`) into a number array. */
function parseVectorLiteral(literal: string): number[] {  let parsed: unknown;
  try {
    parsed = JSON.parse(literal);
  } catch {
    throw ApiError.validation({ vectorLiteral: 'must be a JSON array of numbers' });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw ApiError.validation({ vectorLiteral: 'must be a non-empty array of finite numbers' });
  }
  return parsed as number[];
}

interface AdmittedCorpus {
  /** chunkId (uuid string) → chunk doc, for admitted (version-filtered) chunks. */
  chunks: Map<string, ChunkMongoDoc>;
  /** versionId (uuid string) → documentId (uuid string). */
  versionDocument: Map<string, string>;
  /** documentId (uuid string) → title. */
  documentTitle: Map<string, string | null>;
}

export class MongoRetrievalRepository implements IRetrievalRepository {
  constructor(
    private readonly mongo: MongoDbService,
    private readonly backend: ISearchBackend,
  ) {}

  async runRetrievalLegs(input: LegInput): Promise<{
    vectorLegs: Array<Array<LegRow>>;
    ftsLegs: Array<Array<LegRow>>;
  }> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    const orgId = input.orgId;

    return this.mongo.withOrg(orgId, async (ctx) => {
      const corpus = await this.admittedCorpus(db, ctx, input);
      const vectorLegs: Array<Array<LegRow>> = [];
      for (const leg of input.vectorLegs) {
        vectorLegs.push(await this.vectorLeg(db, ctx, orgId, corpus, input, leg));
      }
      const ftsLegs: Array<Array<LegRow>> = [];
      for (const leg of input.ftsLegs) {
        ftsLegs.push(await this.ftsLeg(db, ctx, orgId, corpus, leg));
      }
      return { vectorLegs, ftsLegs };
    });
  }

  /**
   * Authorization-before-scoring: resolve the admitted chunk set once for all
   * legs (the pg lane applies the same gates per leg; the tx snapshot keeps
   * them consistent).
   */
  private async admittedCorpus(
    db: Db,
    ctx: MongoTxContext,
    input: LegInput,
  ): Promise<AdmittedCorpus> {
    const orgId = input.orgId;
    const s = sessionOf(ctx);
    const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
    const versions = new TenantScopedCollection<DocumentVersionMongoDoc>(db.collection(VERSIONS));
    const chunks = new TenantScopedCollection<ChunkMongoDoc>(db.collection(CHUNKS));
    const artifacts = new TenantScopedCollection<ArtifactMongoDoc>(db.collection(ARTIFACTS));
    const retrievalAcl = new TenantScopedCollection<RetrievalAclMongoDoc>(db.collection(RETRIEVAL_ACL));
    const sourceAcls = new TenantScopedCollection<DocumentSourceAclMongoDoc>(db.collection(SOURCE_ACLS));
    const principals = new TenantScopedCollection<ExternalPrincipalMongoDoc>(db.collection(PRINCIPALS));
    const identityLinks = new TenantScopedCollection<ExternalIdentityLinkMongoDoc>(
      db.collection(IDENTITY_LINKS),
    );

    const nowIso = new Date().toISOString();

    // 1. Ready documents with an active, clean/skipped, unexpired artifact.
    const readyDocs = await documents
      .find(orgId, { state: 'ready' }, s)
      .toArray();
    const artifactIds = [...new Set(readyDocs.map((d) => d.source_artifact_id.toUUID().toString()))];
    const artifactById = new Map<string, ArtifactMongoDoc>();
    for (const a of await artifacts
      .find(orgId, { id: { $in: artifactIds.map((id) => binUuid(id)) } }, s)
      .toArray()) {
      artifactById.set(a.id.toUUID().toString(), a);
    }
    const liveDocs = readyDocs.filter((d) => {
      const a = artifactById.get(d.source_artifact_id.toUUID().toString());
      return (
        a !== undefined &&
        a.state === 'active' &&
        (a.scan_status === 'clean' || a.scan_status === 'skipped') &&
        (a.expires_at === null || a.expires_at > nowIso)
      );
    });

    // 2. Retrieval-ACL visibility: org-wide, or private scoped to accountId.
    // A document with NO acl row is excluded (the pg LEFT JOIN requires the
    // visibility predicate to hold). uq_retrieval_acl permits several rows
    // per document — admission holds when ANY row admits the caller.
    const docIds = liveDocs.map((d) => d.id);
    const aclsByDoc = new Map<string, RetrievalAclMongoDoc[]>();
    for (const row of await retrievalAcl
      .find(orgId, { resource_type: 'document', resource_id: { $in: docIds } }, s)
      .toArray()) {
      const key = row.resource_id.toUUID().toString();
      const list = aclsByDoc.get(key);
      if (list) list.push(row);
      else aclsByDoc.set(key, [row]);
    }
    const accountId = input.accountId;
    const visibleDocs = liveDocs.filter((d) => {
      const rows = aclsByDoc.get(d.id.toUUID().toString()) ?? [];
      return rows.some(
        (acl) =>
          acl.visibility === 'organization' ||
          (acl.visibility === 'private' &&
            accountId !== null &&
            acl.scope_account_id !== null &&
            acl.scope_account_id.toUUID().toString() === accountId),
      );
    });

    // 3. Source-ACL principals for restricted documents.
    const visibleDocIds = visibleDocs.map((d) => d.id);
    const restrictedByDoc = new Map<string, DocumentSourceAclMongoDoc[]>();
    for (const row of await sourceAcls
      .find(orgId, { document_id: { $in: visibleDocIds } }, s)
      .toArray()) {
      const key = row.document_id.toUUID().toString();
      const list = restrictedByDoc.get(key);
      if (list) list.push(row);
      else restrictedByDoc.set(key, [row]);
    }
    const callerAccount = input.callerAccountId ?? input.accountId;
    // The canonical builder lowercases caller emails before matching
    // (`lower(p.email) in (...)`); principals are stored lowercased.
    const callerEmails = new Set(
      input.callerEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
    );
    const linkedPrincipals = new Set<string>(); // provider + '\n' + external_id
    if (callerAccount !== null) {
      for (const link of await identityLinks.find(orgId, { account_id: binUuid(callerAccount) }, s).toArray()) {
        linkedPrincipals.add(`${link.provider}\n${link.external_id}`);
      }
    }
    if (callerEmails.size > 0) {
      for (const p of await principals.find(orgId, { email: { $in: [...callerEmails] } }, s).toArray()) {
        linkedPrincipals.add(`${p.provider}\n${p.external_id}`);
      }
    }
    const admittedDocs = visibleDocs.filter((d) => {
      const rows = restrictedByDoc.get(d.id.toUUID().toString());
      if (!rows || rows.length === 0) return true; // unrestricted
      return rows.some((r) => linkedPrincipals.has(`${r.provider}\n${r.external_id}`));
    });

    // 4. Version restriction: explicit ids, else latest version per document.
    const admittedDocIds = new Set(admittedDocs.map((d) => d.id.toUUID().toString()));
    const versionDocument = new Map<string, string>();
    const versionIds: string[] = [];
    if (input.versionIds !== null) {
      const wanted = new Set(input.versionIds);
      for (const v of await versions
        .find(orgId, { id: { $in: [...wanted].map((id) => binUuid(id)) } }, s)
        .toArray()) {
        const docId = v.document_id.toUUID().toString();
        if (admittedDocIds.has(docId)) {
          const vid = v.id.toUUID().toString();
          versionIds.push(vid);
          versionDocument.set(vid, docId);
        }
      }
    } else {
      for (const d of admittedDocs) {
        const docId = d.id.toUUID().toString();
        const latest = await versions
          .find(orgId, { document_id: d.id }, { ...s, sort: { version: -1 }, limit: 1 })
          .toArray();
        if (latest[0]) {
          const vid = latest[0].id.toUUID().toString();
          versionIds.push(vid);
          versionDocument.set(vid, docId);
        }
      }
    }

    // 5. Chunks of the admitted versions.
    const chunkMap = new Map<string, ChunkMongoDoc>();
    if (versionIds.length > 0) {
      const versionBinaries = versionIds.map((id) => binUuid(id));
      for (const c of await chunks.find(orgId, { document_version_id: { $in: versionBinaries } }, s).toArray()) {
        chunkMap.set(c.id.toUUID().toString(), c);
      }
    }

    return {
      chunks: chunkMap,
      versionDocument,
      documentTitle: new Map(admittedDocs.map((d) => [d.id.toUUID().toString(), d.title])),
    };
  }

  private chunkRow(
    chunk: ChunkMongoDoc,
    corpus: AdmittedCorpus,
    score: number,
  ): LegRow {
    const versionId = chunk.document_version_id.toUUID().toString();
    const documentId = corpus.versionDocument.get(versionId) ?? '';
    return {
      chunk_id: chunk.id.toUUID().toString(),
      sequence: chunk.sequence,
      text: chunk.text,
      source_range: chunk.source_range,
      document_version_id: versionId,
      document_id: documentId,
      title: corpus.documentTitle.get(documentId) ?? null,
      score,
    };
  }

  /**
   * Vector leg via the resolved search backend (P4). The admitted chunk
   * set is pre-computed by `admittedCorpus` (authorization-before-scoring)
   * and handed to the backend as `candidateChunkIds`; the backend scores
   * only that set. This replaces the previous in-JS brute-force cosine —
   * the backend is Atlas `$vectorSearch` or Qdrant, resolved automatically
   * at boot. Rows are hydrated from the admitted corpus map.
   */
  private async vectorLeg(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    corpus: AdmittedCorpus,
    input: LegInput,
    leg: { vectorLiteral: string; pool: number; queryModel: string },
  ): Promise<Array<LegRow>> {
    const query = parseVectorLiteral(leg.vectorLiteral);
    if (corpus.chunks.size === 0) return [];
    const hits = await this.backend.runVectorLeg({
      orgId,
      vector: query,
      model: leg.queryModel,
      topK: Math.max(leg.pool, 0),
      versionIds: input.versionIds,
      accountId: input.accountId,
      callerAccountId: input.callerAccountId,
      callerEmails: input.callerEmails,
      candidateChunkIds: [...corpus.chunks.keys()],
    });
    const rows: Array<LegRow> = [];
    for (const hit of hits) {
      const chunk = corpus.chunks.get(hit.chunkId);
      if (!chunk) continue;
      rows.push(this.chunkRow(chunk, corpus, hit.score));
    }
    return rows;
  }

  /**
   * Lexical leg over MongoDB's `$text` index (english) — the native
   * counterpart of the pg lane's
   * `c.fts @@ websearch_to_tsquery('english', variant)`: same english
   * stemming/stop-words, same quoted-phrase and `-negation` operators, and
   * `$meta: 'textScore'` plays the role of `ts_rank_cd` (both are
   * term-frequency rankers; RRF fusion only needs rank order).
   *
   * Documented divergence: `$text` ORs unquoted query terms while
   * `websearch_to_tsquery` ANDs them, so the mongo leg admits a superset of
   * the pg leg's rows for multi-term variants. Rank order still puts the
   * best lexical matches first, and the service's RRF fusion is
   * rank-based — but candidate SETS can differ from the pg lane.
   */
  private async ftsLeg(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    corpus: AdmittedCorpus,
    leg: { variant: string; pool: number },
  ): Promise<Array<LegRow>> {
    if (corpus.chunks.size === 0 || leg.variant.trim().length === 0) return [];
    const s = sessionOf(ctx);
    const chunkBinaries = [...corpus.chunks.keys()].map((id) => binUuid(id, 'chunkId'));
    // $text must lead the pipeline; the org predicate rides in the same
    // $match (explicit tenant scoping — the aggregate escape hatch is used
    // because $meta: 'textScore' needs pipeline stages).
    const pipeline: Document[] = [
      {
        $match: {
          organization_id: binUuid(orgId, 'orgId'),
          id: { $in: chunkBinaries },
          $text: { $search: leg.variant },
        },
      },
      { $addFields: { _textScore: { $meta: 'textScore' } } },
      { $sort: { _textScore: -1 } },
      { $limit: Math.max(leg.pool, 0) },
    ];
    const rows: Array<LegRow> = [];
    const cursor = db
      .collection<ChunkMongoDoc>(CHUNKS)
      .aggregate<ChunkMongoDoc & { _textScore: number }>(pipeline, s);
    for await (const doc of cursor) {
      const chunk = corpus.chunks.get(doc.id.toUUID().toString());
      if (!chunk) continue;
      rows.push(this.chunkRow(chunk, corpus, doc._textScore));
    }
    return rows;
  }
}
