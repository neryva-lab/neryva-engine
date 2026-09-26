/**
 * MongoDB implementation of the retrieval-ACL repository port (P3).
 *
 * Legacy plain-INSERT semantics, mirroring the pg lane: a single
 * `insertOne` of the grant row per call — no DELETE, no dedup, no
 * replace. `retrieval_acl` has only the non-unique
 * `ix_retrieval_acl_resource` index (no unique constraint on the
 * resource key), so repeated grants accumulate rows and the retrieval
 * join admits on ANY matching row. One `withOrg` unit of work per
 * grant; no transaction handle leaks through the interface.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { RetrievalAclMongoDoc } from './mongo-documents';
import type { IRetrievalAclRepository } from './retrieval-acl.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  nowIso,
  sessionOf,
} from './mongo-knowledge-shared';

const RETRIEVAL_ACL = 'retrieval_acl';

export class MongoRetrievalAclRepository implements IRetrievalAclRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async grantDocumentAccess(input: {
    orgId: string;
    documentId: string;
    visibility: 'organization' | 'private';
    scopeAccountId: string | null;
  }): Promise<void> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const acl = new TenantScopedCollection<RetrievalAclMongoDoc>(db.collection(RETRIEVAL_ACL));
      const resourceId = binUuid(input.documentId, 'documentId');
      const s = sessionOf(ctx);
      // Legacy plain insert — exactly one grant row per call. No dedup,
      // no replace: repeated grants accumulate rows (mirrors the pg
      // lane's `insert … onConflictDoNothing()` with no conflict target).
      await acl.insertOne(
        input.orgId,
        {
          id: binUuid(newId()),
          organization_id: binUuid(input.orgId, 'orgId'),
          resource_type: 'document',
          resource_id: resourceId,
          visibility: input.visibility,
          scope_account_id:
            input.scopeAccountId === null ? null : binUuid(input.scopeAccountId, 'scopeAccountId'),
          created_at: nowIso(),
        },
        s,
      );
    });
  }
}
