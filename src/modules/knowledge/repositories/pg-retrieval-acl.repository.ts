import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { retrievalAcl } from '../schema';
import type { IRetrievalAclRepository } from './retrieval-acl.repository';

/**
 * PostgreSQL implementation of `IRetrievalAclRepository` (P3).
 *
 * Legacy plain-INSERT semantics, byte-faithful to the service code this
 * replaces (`insert … onConflictDoNothing()` with NO conflict target):
 * one `DbService.withOrg` transaction per grant, a single INSERT of the
 * grant row, no DELETE, no dedup, no replace. `retrieval_acl` has only
 * the non-unique `ix_retrieval_acl_resource` index (no unique
 * constraint), so the no-target `ON CONFLICT DO NOTHING` never fires —
 * repeated grants accumulate rows and the retrieval join admits on ANY
 * matching row. The service-level validation (private requires
 * scopeAccountId) stays in the service — the repository writes exactly
 * what it is given.
 */
export class PgRetrievalAclRepository implements IRetrievalAclRepository {
  constructor(private readonly db: DbService) {}

  async grantDocumentAccess(input: {
    orgId: string;
    documentId: string;
    visibility: 'organization' | 'private';
    scopeAccountId: string | null;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx
        .insert(retrievalAcl)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          resourceType: 'document',
          resourceId: input.documentId,
          visibility: input.visibility,
          scopeAccountId: input.scopeAccountId,
        })
        .onConflictDoNothing();
    });
  }
}
