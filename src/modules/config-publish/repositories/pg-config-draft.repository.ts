import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { configDrafts } from '../config-publish.schema';
import type { ConfigDraft, ConfigScope } from '../config-publish.schema';
import type { IConfigDraftRepository, SaveDraftInput } from './config-publish.repository';

/**
 * PostgreSQL implementation of `IConfigDraftRepository` (P3).
 *
 * Mechanical move of the `ConfigPublishService` draft units: every method
 * owns its transaction via `DbService.withOrg`, runs all reads/writes
 * inside it, and commits or rolls back as one. No transaction handle leaks
 * through the interface.
 *
 * What stays OUT (still the service's job): input validation, payload
 * validation (`validatePayload`), the post-publish cleanup's error
 * swallowing, and audit writes.
 */
export class PgConfigDraftRepository implements IConfigDraftRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Save (upsert) the draft for a key: insert, or update on the
   * (org_id, scope, product) unique key — one `withOrg` unit. Drafts keep
   * the RAW payload (not the normalized one) so the author sees exactly
   * what they typed; publish normalizes on the way out.
   */
  async saveDraft(input: SaveDraftInput): Promise<ConfigDraft> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(configDrafts)
        .values({
          orgId: input.orgId,
          scope: input.scope,
          product: input.product,
          payload: input.payload,
          payloadHash: input.payloadHash,
          validationStatus: input.validationStatus,
          validationIssues: input.validationIssues,
          notes: input.notes,
          createdBy: input.updatedBy,
          updatedBy: input.updatedBy,
        })
        .onConflictDoUpdate({
          target: [configDrafts.orgId, configDrafts.scope, configDrafts.product],
          set: {
            payload: input.payload,
            payloadHash: input.payloadHash,
            validationStatus: input.validationStatus,
            validationIssues: input.validationIssues,
            notes: input.notes,
            updatedBy: input.updatedBy,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return rows[0];
    });
  }

  /** The one draft for a key (null when absent). */
  async getDraft(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<ConfigDraft | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(configDrafts).where(draftKey(orgId, scope, product)).limit(1),
    );
    return rows[0] ?? null;
  }

  /** Every draft for the org, ordered by (scope, product). */
  async listDrafts(orgId: string): Promise<ConfigDraft[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(configDrafts).orderBy(configDrafts.scope, configDrafts.product),
    );
  }

  /** Delete the draft for a key; returns the deleted id (null when absent). */
  async deleteDraft(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<{ id: string } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .delete(configDrafts)
        .where(draftKey(orgId, scope, product))
        .returning({ id: configDrafts.id }),
    );
    return rows[0] ?? null;
  }

  /**
   * Delete the draft for a key only if its payload hash still matches —
   * the post-publish cleanup (a concurrent edit keeps the draft alive).
   * Never throws when nothing matches.
   */
  async deleteDraftIfPayloadMatches(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    payloadHash: string,
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .delete(configDrafts)
        .where(and(draftKey(orgId, scope, product), eq(configDrafts.payloadHash, payloadHash))),
    );
  }
}

/** The (org, scope, product) draft-key predicate (null product = org-wide key). */
function draftKey(orgId: string, scope: ConfigScope, product: string | null) {
  return product === null
    ? and(eq(configDrafts.orgId, orgId), eq(configDrafts.scope, scope), isNull(configDrafts.product))
    : and(eq(configDrafts.orgId, orgId), eq(configDrafts.scope, scope), eq(configDrafts.product, product));
}
