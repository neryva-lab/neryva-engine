/**
 * MongoDB implementation of the document repository port (P3) — the
 * `documents` aggregate's management surface: inventory, slug addressing,
 * retirement, and the ACL-gated preview read.
 *
 * The preview's ACL gate is built inline from PRIMITIVE inputs
 * (`accountId`, `callerEmails`) to the IDENTICAL semantics of the canonical
 * `buildSourceAclFilter` in `retrieval.service.ts` (unit-tested there —
 * referenced here, never imported).
 */
import type { Binary } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
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
import type {
  DocumentInventoryRow,
  DocumentPreview,
  DocumentPreviewChunk,
  DocumentVersionTarget,
} from './repository-types';
import type { IDocumentRepository } from './document.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  nowIso,
  sessionOf,
} from './mongo-knowledge-shared';
import { isDuplicateKey } from './mongo-documents';

const DOCUMENTS = 'documents';
const VERSIONS = 'document_versions';
const CHUNKS = 'chunks';
const ARTIFACTS = 'artifacts';
const RETRIEVAL_ACL = 'retrieval_acl';
const DOCUMENT_SOURCE_ACLS = 'document_source_acls';
const EXTERNAL_IDENTITY_LINKS = 'external_identity_links';
const EXTERNAL_PRINCIPALS = 'external_principals';

/** Escape a literal for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MongoDocumentRepository implements IDocumentRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async findVersionTarget(orgId: string, documentId: string): Promise<DocumentVersionTarget | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const doc = await documents.findOne(
        orgId,
        { id: binUuid(documentId, 'documentId') },
        { ...sessionOf(ctx), projection: { id: 1, state: 1 } },
      );
      return doc ? { id: doc.id.toUUID().toString(), state: doc.state } : null;
    });
  }

  async isSourceSlugTaken(orgId: string, slug: string): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const count = await documents.countDocuments(
        orgId,
        { source_slug: slug },
        { ...sessionOf(ctx), limit: 1 },
      );
      return count > 0;
    });
  }

  async listInventory(orgId: string, limit: number): Promise<DocumentInventoryRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const s = sessionOf(ctx);
      const docs = await documents
        .find(orgId, {}, { ...s, sort: { updated_at: -1 }, limit: Math.max(limit, 0) })
        .toArray();
      if (docs.length === 0) return [];
      // max(document_versions.version) per document (0 when none exists).
      // Raw collection aggregate (typed): the tenant $match is explicit.
      const maxVersions = await db
        .collection<DocumentVersionMongoDoc>(VERSIONS)
        .aggregate<{ _id: Binary; maxVersion: number }>(
          [
            {
              $match: {
                organization_id: binUuid(orgId, 'orgId'),
                document_id: { $in: docs.map((d) => d.id) },
              },
            },
            { $group: { _id: '$document_id', maxVersion: { $max: '$version' } } },
          ],
          s,
        )
        .toArray();
      const latestByDoc = new Map<string, number>(
        maxVersions.map((r) => [r._id.toUUID().toString(), r.maxVersion]),
      );
      return docs.map((d) => {
        const id = d.id.toUUID().toString();
        return {
          id,
          source_slug: d.source_slug,
          title: d.title,
          state: d.state,
          updated_at: d.updated_at,
          latest_version: latestByDoc.get(id) ?? 0,
        };
      });
    });
  }

  async renameSourceSlug(
    orgId: string,
    documentId: string,
    slug: string,
  ): Promise<'renamed' | 'unchanged' | 'not_found' | 'slug_taken'> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    // The duplicate-key translation sits OUTSIDE the transaction: the
    // loser's TX is already aborted when the unique index rejects the
    // write, and returning from inside the catch would mask the abort.
    try {
      return await this.mongo.withOrg(orgId, async (ctx) => {
        const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
        const s = sessionOf(ctx);
        const doc = await documents.findOne(
          orgId,
          { id: binUuid(documentId, 'documentId') },
          { ...s, projection: { id: 1, source_slug: 1 } },
        );
        if (!doc) return 'not_found';
        if (doc.source_slug === slug) return 'unchanged';
        // Known race, preserved (no FOR UPDATE): two concurrent renames to
        // the same slug can both pass this check and one loses to the unique
        // index — the loser maps to `slug_taken`.
        const clash = await documents.countDocuments(
          orgId,
          { source_slug: slug },
          { ...s, limit: 1 },
        );
        if (clash > 0) return 'slug_taken';
        const res = await documents.updateOne(
          orgId,
          { id: doc.id },
          { $set: { source_slug: slug, updated_at: nowIso() } },
          s,
        );
        if (res.matchedCount === 0) return 'not_found';
        return 'renamed';
      });
    } catch (err) {
      if (isDuplicateKey(err)) return 'slug_taken';
      throw err;
    }
  }

  async retire(orgId: string, documentId: string): Promise<'retired' | 'already_retired' | 'not_found'> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const s = sessionOf(ctx);
      const doc = await documents.findOne(
        orgId,
        { id: binUuid(documentId, 'documentId') },
        { ...s, projection: { id: 1, state: 1 } },
      );
      if (!doc) return 'not_found';
      // Idempotent tombstone — retry-safe, not an error.
      if (doc.state === 'retired') return 'already_retired';
      await documents.updateOne(
        orgId,
        { id: doc.id },
        { $set: { state: 'retired', updated_at: nowIso() } },
        s,
      );
      return 'retired';
    });
  }

  async readPreview(input: {
    orgId: string;
    documentId: string;
    accountId: string | null;
    callerEmails: string[];
    chunkLimit: number;
  }): Promise<DocumentPreview | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = input.orgId;
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const artifacts = new TenantScopedCollection<ArtifactMongoDoc>(db.collection(ARTIFACTS));
      const retrievalAcl = new TenantScopedCollection<RetrievalAclMongoDoc>(
        db.collection(RETRIEVAL_ACL),
      );
      const acls = new TenantScopedCollection<DocumentSourceAclMongoDoc>(
        db.collection(DOCUMENT_SOURCE_ACLS),
      );
      const versions = new TenantScopedCollection<DocumentVersionMongoDoc>(db.collection(VERSIONS));
      const chunks = new TenantScopedCollection<ChunkMongoDoc>(db.collection(CHUNKS));
      const links = new TenantScopedCollection<ExternalIdentityLinkMongoDoc>(
        db.collection(EXTERNAL_IDENTITY_LINKS),
      );
      const principals = new TenantScopedCollection<ExternalPrincipalMongoDoc>(
        db.collection(EXTERNAL_PRINCIPALS),
      );
      const s = sessionOf(ctx);

      const doc = await documents.findOne(
        orgId,
        { id: binUuid(input.documentId, 'documentId') },
        s,
      );
      if (!doc) return null;

      // ── A4-12 gate, byte-identical shape to retrieval's aclPredicate ──
      // authorization before any chunk text is touched. A document failing
      // any gate is unreachable here exactly as it is unreachable by
      // retrieval — null (the service maps to 404, not 403, so the
      // existence of a non-visible document is never disclosed).
      if (doc.state !== 'ready') return null;
      const artifact = await artifacts.findOne(
        orgId,
        { id: doc.source_artifact_id },
        s,
      );
      const now = nowIso();
      if (
        !artifact ||
        artifact.state !== 'active' ||
        (artifact.scan_status !== 'clean' && artifact.scan_status !== 'skipped') ||
        (artifact.expires_at !== null && artifact.expires_at <= now)
      ) {
        return null;
      }
      // No acl row, or no row admitting this caller, denies — the pg
      // LEFT JOIN's visibility predicate must hold on at least one row
      // (uq_retrieval_acl permits several rows per document: one
      // 'organization' row plus per-account 'private' rows).
      const aclRows = await retrievalAcl
        .find(orgId, { resource_type: 'document', resource_id: doc.id }, s)
        .toArray();
      const aclAdmits = aclRows.some(
        (row) =>
          row.visibility === 'organization' ||
          (row.visibility === 'private' &&
            input.accountId !== null &&
            row.scope_account_id !== null &&
            row.scope_account_id.toUUID().toString() === input.accountId),
      );
      if (!aclAdmits) return null;

      // ── ACL gate (identical to buildSourceAclFilter) ──────────────────
      const sourceAcls = await acls
        .find(orgId, { document_id: doc.id }, s)
        .toArray();
      const restricted = sourceAcls.length > 0;
      const emailList = input.callerEmails
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0);
      let admitted = !restricted;
      if (!admitted) {
        // `l.provider = s.provider AND l.external_id = s.external_id` for
        // the caller's link, or `p.provider = s.provider AND
        // p.external_id = s.external_id AND lower(p.email) in emails`.
        for (const acl of sourceAcls) {
          const pair = { provider: acl.provider, external_id: acl.external_id };
          if (input.accountId !== null) {
            const link = await links.findOne(
              orgId,
              { ...pair, account_id: binUuid(input.accountId, 'accountId') },
              { ...s, projection: { _id: 1 } },
            );
            if (link) {
              admitted = true;
              break;
            }
          }
          if (emailList.length > 0) {
            // `lower(p.email) in emailList` — case-insensitive equality.
            const emailPatterns = emailList.map(
              (e) => new RegExp(`^${escapeRegExp(e)}$`, 'i'),
            );
            const principal = await principals.findOne(
              orgId,
              { ...pair, email: { $in: emailPatterns } },
              { ...s, projection: { _id: 1 } },
            );
            if (principal) {
              admitted = true;
              break;
            }
          }
        }
      }
      if (!admitted) return null;

      // ── document → latest version → chunk count + one page ────────────
      const latest = await versions
        .find(orgId, { document_id: doc.id }, { ...s, sort: { version: -1 }, limit: 1 })
        .toArray();
      const version = latest[0] ?? null;
      // A 'ready' document always has a version (READY is published after
      // INDEXING mints one); a missing version is treated as not found.
      if (!version) return null;
      const chunkCount = await chunks.countDocuments(
        orgId,
        { document_version_id: version.id },
        s,
      );
      const chunkDocs = await chunks
        .find(
          orgId,
          { document_version_id: version.id },
          {
            ...s,
            sort: { sequence: 1 },
            limit: Math.max(input.chunkLimit, 0),
            projection: { sequence: 1, text: 1, source_range: 1 },
          },
        )
        .toArray();
      const page: DocumentPreviewChunk[] = chunkDocs.map((c) => ({
        sequence: c.sequence,
        text: c.text,
        sourceRange: (c.source_range ?? null) as {
          byteStart: number;
          byteEnd: number;
        } | null,
      }));

      return {
        id: doc.id.toUUID().toString(),
        title: doc.title,
        state: doc.state,
        source_slug: doc.source_slug,
        version: version.version,
        chunkCount,
        chunks: page,
      };
    });
  }
}
