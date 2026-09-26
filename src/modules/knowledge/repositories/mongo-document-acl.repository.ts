/**
 * MongoDB implementation of the document-ACL repository port (P3) — the
 * whole READY stage in one transaction: the session flips to READY first
 * (restoring the legacy READY-stage transaction boundary), the document
 * becomes queryable, and its access posture is fixed atomically. A later
 * failure rolls the whole stage — including the session flip — back.
 *
 * Transaction design (the 11000 claim-loss rule): a Mongo duplicate key
 * aborts the multi-document transaction, so NO duplicate-error
 * catch-and-continue happens inside `withOrg`. Every insert-or-read-back is
 * an atomic single-document upsert (`findOneAndUpdate` + `$setOnInsert` /
 * `$set`):
 * - the default org `retrieval_acl` row → bare `insertOne` (mirrors the pg
 *   lane's `insert … onConflictDoNothing()` with no conflict target and no
 *   unique index: no dedup, so a re-publish accumulates rows — legacy
 *   parity, not a bug);
 * - `external_principals` → upsert keyed on
 *   `(organization_id, provider, external_id)` with `$set`
 *   kind/email/updatedAt (mirrors `onConflictDoUpdate`);
 * - `external_identity_links` → upsert with `$setOnInsert` only
 *   (first-write-wins, mirrors `onConflictDoNothing`);
 * - `document_source_acls` → `deleteMany` + `insertMany` inside the same
 *   tx (the delete clears the unique key space first).
 *
 * Principal normalization mirrors the worker exactly: only
 * `user`/`group`/`domain` kinds with a non-empty string id (cap 500),
 * `external_id` sliced to 512, email lowercased + sliced to 320 only when
 * it contains '@', `display` null. A null/absent `sourceAcl` intent leaves
 * existing restrictions untouched — only an explicit `mode: 'open'`
 * deletes them.
 *
 * Tenant discipline: `mongo.withOrg` + an explicit `organization_id`
 * predicate on every tenant collection access. The `accounts` email lookup
 * is the one exception: accounts are the identity module's GLOBAL table
 * (the worker queries it with no org predicate), so the port uses the raw
 * collection there too.
 */
import type { Binary } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  DocumentMongoDoc,
  DocumentSourceAclMongoDoc,
  DocumentVersionMongoDoc,
  ExternalIdentityLinkMongoDoc,
  ExternalPrincipalMongoDoc,
  RetrievalAclMongoDoc,
  UploadSessionMongoDoc,
} from './mongo-documents';
import type { IDocumentAclRepository } from './document-acl.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  sessionOf,
  toIso,
} from './mongo-knowledge-shared';

const DOCUMENTS = 'documents';
const VERSIONS = 'document_versions';
const RETRIEVAL_ACL = 'retrieval_acl';
const SOURCE_ACLS = 'document_source_acls';
const PRINCIPALS = 'external_principals';
const IDENTITY_LINKS = 'external_identity_links';
const ACCOUNTS = 'accounts';
const SESSIONS = 'upload_sessions';

/** Narrow account projection for the email auto-link lookup. */
interface AccountEmailDoc {
  id: Binary;
  email: string | null;
}

type PublishInput = Parameters<IDocumentAclRepository['publishDocumentReady']>[0];

/** The worker's principal normalization, applied verbatim. */
function cleanPrincipals(
  principals: Array<{ kind: string; id: string; email?: string }>,
): Array<{ kind: string; externalId: string; email: string | null }> {
  return principals
    .filter(
      (p): p is { kind: string; id: string; email?: string } =>
        (p.kind === 'user' || p.kind === 'group' || p.kind === 'domain') &&
        typeof p.id === 'string' &&
        p.id.length > 0,
    )
    .slice(0, 500)
    .map((p) => ({
      kind: p.kind,
      externalId: p.id.slice(0, 512),
      email:
        typeof p.email === 'string' && p.email.includes('@')
          ? p.email.toLowerCase().slice(0, 320)
          : null,
    }));
}

export class MongoDocumentAclRepository implements IDocumentAclRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async publishDocumentReady(input: PublishInput): Promise<{ documentId: string | null }> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    const orgId = input.orgId;
    const now = toIso(input.at);

    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const retrievalAcl = new TenantScopedCollection<RetrievalAclMongoDoc>(db.collection(RETRIEVAL_ACL));
      const sourceAcls = new TenantScopedCollection<DocumentSourceAclMongoDoc>(db.collection(SOURCE_ACLS));
      const principals = new TenantScopedCollection<ExternalPrincipalMongoDoc>(db.collection(PRINCIPALS));
      const identityLinks = new TenantScopedCollection<ExternalIdentityLinkMongoDoc>(
        db.collection(IDENTITY_LINKS),
      );
      // Global identity table — no tenant predicate, mirroring the worker.
      const accounts = db.collection<AccountEmailDoc>(ACCOUNTS);
      const s = sessionOf(ctx);
      const orgBin = binUuid(orgId, 'orgId');

      // 0. READY-stage transaction boundary: the session flips to READY as
      // the FIRST statement of this transaction (restores the legacy
      // worker's boundary — `readyStage` updated the session before
      // resolving the document); a later failure rolls the flip back
      // atomically.
      await db.collection<UploadSessionMongoDoc>(SESSIONS).updateOne(
        { id: binUuid(input.sessionId, 'sessionId') },
        { $set: { state: 'READY', updated_at: now } },
        s,
      );

      // 1. Resolve the document the session converged on. Null → the caller
      // fails the session rather than marking it READY.
      const docCond = input.targetDocumentId
        ? { id: binUuid(input.targetDocumentId, 'targetDocumentId') }
        : { source_artifact_id: binUuid(input.artifactId, 'artifactId') };
      const doc = await documents.findOne(orgId, docCond, s);
      if (!doc) return { documentId: null };
      const documentId = doc.id.toUUID().toString();

      // 2. Document → ready, stamping the embedding model.
      await documents.updateOne(
        orgId,
        { id: doc.id },
        { $set: { state: 'ready', embedding_model: input.embeddingModel, updated_at: now } },
        s,
      );

      // 3. Default org retrieval ACL — the org visibility baseline every
      // document carries. Without this row the retrieval join excludes the
      // document entirely. Bare insert, mirroring the pg lane's `insert …
      // onConflictDoNothing()` with no conflict target and no unique index:
      // no dedup, so a re-publish accumulates rows — legacy parity.
      await retrievalAcl.insertOne(
        orgId,
        {
          id: binUuid(newId()),
          organization_id: orgBin,
          resource_type: 'document',
          resource_id: doc.id,
          visibility: 'organization',
          scope_account_id: null,
          created_at: now,
        },
        s,
      );

      // 4. Source-ACL replace set.
      const intent = input.sourceAcl;
      if (!intent || intent.mode !== 'restricted') {
        // Open (or absent intent): absent intent leaves restrictions
        // untouched; explicit 'open' clears them (permissions widened at
        // the source — sync is the authority).
        if (intent && intent.mode === 'open') {
          await sourceAcls.deleteMany(orgId, { document_id: doc.id }, s);
        }
        return { documentId };
      }

      // mode: 'restricted' — upsert principals, auto-link verified emails,
      // then REPLACE the document's restriction set.
      const provider = input.connectorProvider;
      const clean = cleanPrincipals(intent.principals);
      for (const p of clean) {
        await principals.findOneAndUpdate(
          orgId,
          { provider, external_id: p.externalId },
          {
            $set: { kind: p.kind, email: p.email, updated_at: now },
            $setOnInsert: {
              id: binUuid(newId()),
              organization_id: orgBin,
              provider,
              external_id: p.externalId,
              display: null,
              created_at: now,
            },
          },
          { ...s, upsert: true },
        );
        // Auto-link on email equality (the common case) so account matching
        // works without manual mapping. No link = default-deny.
        if (p.email) {
          const owner = await accounts.findOne({ email: p.email }, { ...s, projection: { id: 1 } });
          if (owner) {
            await identityLinks.findOneAndUpdate(
              orgId,
              { provider, external_id: p.externalId },
              {
                $setOnInsert: {
                  id: binUuid(newId()),
                  organization_id: orgBin,
                  provider,
                  external_id: p.externalId,
                  account_id: owner.id,
                  created_at: now,
                },
              },
              { ...s, upsert: true },
            );
          }
        }
      }

      await sourceAcls.deleteMany(orgId, { document_id: doc.id }, s);
      if (clean.length > 0) {
        const aclDocs: DocumentSourceAclMongoDoc[] = clean.map((p) => ({
          id: binUuid(newId()),
          organization_id: orgBin,
          document_id: doc.id,
          provider,
          external_id: p.externalId,
          created_at: now,
        }));
        await sourceAcls.insertMany(orgId, aclDocs, s);
      }

      return { documentId };
    });
  }

  async latestVersion(orgId: string, documentId: string): Promise<number | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const versions = new TenantScopedCollection<DocumentVersionMongoDoc>(db.collection(VERSIONS));
      const rows = await versions.find(
        orgId,
        { document_id: binUuid(documentId, 'documentId') },
        { ...sessionOf(ctx), sort: { version: -1 }, limit: 1, projection: { version: 1 } },
      ).toArray();
      return rows[0]?.version ?? null;
    });
  }
}
